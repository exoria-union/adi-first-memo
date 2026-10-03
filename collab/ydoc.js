// ============================================================================
// DATA <-> Y.Doc 브리지
// ----------------------------------------------------------------------------
// 앱은 모든 편집을 하나의 평범한 JS 객체 DATA에 담고 markDirty()/persist()로
// 흘려보낸다. 이 모듈은 DATA를 Y.Doc(CRDT) 구조로 "미러링"해서, 여러 사용자의
// 동시 편집이 문자/구조 단위로 무손실 병합되게 한다.
//
// 설계 원칙
//  - 긴 서술 텍스트 필드는 Y.Text  -> 같은 필드 동시 타이핑도 글자 단위 병합(무손실)
//  - 그 외 스칼라(코드/플래그/숫자)는 평범한 값 -> 값 단위 최종쓰기(충분)
//  - 객체는 Y.Map, 배열은 Y.Array -> 서로 다른 행/아이템 동시 편집이 병합됨
//  - 개인 설정(태그색/폰트 등)은 공유하지 않는다(앱이 사용자별로 로컬 적용).
//
// 앱의 수백 개 편집 지점을 고치지 않는다: persist() 한 곳에서 DATA를 직전 스냅샷
// (shadow)과 비교(diff)해 바뀐 부분만 Y에 적용한다.
// ============================================================================

import { Y } from './deps.js';

// 스프레드시트에서 "긴 서술 텍스트" 컬럼(헤더명 기준). 이 칸들만 Y.Text가 된다.
export const RICH_TEXT_COLUMNS = new Set([
  '스크립트(내용)',
  '성공 스크립트',
  '실패 스크립트',
  '최초 탐사가 아닐 시 실패 스크립트',
  '종족이 아닐 때 스크립트',
  '유일 아이템 소진 스크립트',
  '비고',
]);

// 스프레드시트 밖(아이템/서브퀘스트 등)에서 키 이름이 이 집합에 들면 Y.Text.
export const RICH_TEXT_KEYS = new Set([
  'content', 'text', 'body', 'desc', 'description', 'script', 'note', 'memo',
  '내용', '본문', '설명', '스크립트', '메모', '비고', '텍스트',
]);

// 공유하지 않는 개인 설정 키. Y.Doc에서 제외하고, 앱이 applyUserPrefs로 로컬 적용.
export const PERSONAL_KEYS = new Set([
  'tagColors', 'tagOpacity', 'fontSettings', 'customFonts', 'exportNames',
]);

// 삭제 금지 최상위 키. 나중에 추가된 섹션(예: 날씨·에너미)은 "그 코드가 아직 없는 옛 클라이언트"의
// DATA엔 없어서, reconcile의 "한쪽에 없는 키 삭제" 규칙에 걸려 공유 문서에서 지워질 수 있다.
// 이 집합의 키는 incoming data에 없어도 Y.Doc에서 삭제하지 않는다(동기화 자체는 정상 수행).
// ⚠ index.html에 새 최상위 데이터 섹션(탭)을 추가하면 반드시 여기에도 그 키를 넣을 것.
export const PROTECTED_KEYS = new Set([
  'weather',
  'enemy',
  'sqlUpAreaId',   // SQL 내보내기 up_area_id(프로젝트별 기억)
]);

const ID_COL = 1; // sheet1 헤더의 "지역ID" 열 인덱스(행 식별자)

// ---------------------------------------------------------------------------
// 줄바꿈 정규화: 공유 문서의 줄바꿈은 LF(\n)만 쓴다.
// textarea.value는 브라우저가 항상 LF로 정규화해 돌려준다. 그런데 문서에 CR(\r)이 섞여 있으면
// (엑셀 가져오기 등) 입력칸 값과 Y.Text/shadow의 글자 위치가 어긋나 diff가 엉뚱한 곳에 적용되고,
// 외부 도구 왕복마다 CR이 쌓였다("완료.\r\r\r\r\r\n…", 2026-09-29 정리).
// 규칙: LF 앞에 쌓인 CR 묶음(\r\n, \r\r\r\n…)은 줄바꿈 하나(\n), 홀로 남은 \r은 각각 \n.
// ---------------------------------------------------------------------------
export function normalizeLineBreaks(s) {
  return typeof s === 'string' && s.indexOf('\r') !== -1
    ? s.replace(/\r+\n/g, '\n').replace(/\r/g, '\n')
    : s;
}

function normalizeDeep(v) {
  if (typeof v === 'string') return normalizeLineBreaks(v);
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = normalizeDeep(v[i]); return v; }
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = normalizeDeep(v[k]); return v; }
  return v;
}

// DATA 안의 모든 문자열 줄바꿈을 제자리(in place)에서 정규화한다(개인 설정 키 제외). data를 반환.
export function normalizeDataLineBreaks(data) {
  if (!data || typeof data !== 'object') return data;
  for (const k of Object.keys(data)) {
    if (PERSONAL_KEYS.has(k)) continue;
    data[k] = normalizeDeep(data[k]);
  }
  return data;
}

// 이미 CR이 들어간 공유 문서(과거 데이터·옛 클라이언트)를 Y.Text 단위로 복구한다.
// 실제 피해 패턴인 "LF 앞 CR 묶음"은 삭제만 하므로 여러 클라이언트가 동시에 복구해도 결과가 같다(멱등).
// LF 없이 홀로 남은 \r(드묾)만 \n 삽입이 필요해, 두 클라이언트가 정확히 동시에 복구하면 빈 줄이 하나 더 생길 수 있다.
// 복구한 Y.Text 개수를 반환.
export function repairTextLineBreaks(ydoc, origin) {
  const texts = [];
  const walk = (node) => {
    if (node instanceof Y.Text) { if (node.toString().indexOf('\r') !== -1) texts.push(node); }
    else if (node instanceof Y.Array || node instanceof Y.Map) node.forEach(walk);
  };
  ydoc.getMap('project').forEach((v, k) => { if (!PERSONAL_KEYS.has(k)) walk(v); });
  if (!texts.length) return 0;
  ydoc.transact(() => {
    for (const t of texts) {
      const s = t.toString();
      const runs = [];
      const re = /\r+/g;
      let m;
      while ((m = re.exec(s))) runs.push({ at: m.index, len: m[0].length, beforeLf: s[m.index + m[0].length] === '\n' });
      // 뒤에서부터 고쳐야 앞쪽 위치가 밀리지 않는다.
      for (let i = runs.length - 1; i >= 0; i--) {
        const r = runs[i];
        t.delete(r.at, r.len);
        if (!r.beforeLf) t.insert(r.at, '\n'.repeat(r.len));
      }
    }
  }, origin);
  return texts.length;
}

// ---------------------------------------------------------------------------
// 동시 같은 칸 편집 복구: 표의 행은 Y.Array<셀>이라 평범한 칸은 delete+insert로 바꾼다. 두 사람이(또는
// 모든 클라이언트가 같은 자동 정리를) 같은 칸을 "동시에" 바꾸면 두 값이 모두 들어가 행이 한 칸 길어지고
// 그 뒤 칸이 전부 한 칸씩 밀린다(종류 코드가 주사위 칸으로 가는 식의 데이터 훼손).
// 같은 틈에 동시에 끼워진 항목은 같은 origin·rightOrigin을 가진다 → 그중 client ID가 가장 큰 것만 남긴다
// (모든 클라이언트가 같은 것을 고르므로 동시에 복구해도 결과가 같다). 헤더보다 긴 행만 손댄다.
// 복구한 항목 수를 반환.
// ---------------------------------------------------------------------------
const idKey = (id) => (id ? id.client + ':' + id.clock : '-');

function healRowArray(yRow, width) {
  if (!(yRow instanceof Y.Array) || !width || yRow.length <= width) return 0;
  const groups = new Map();
  let at = 0;
  for (let it = yRow._start; it; it = it.right) {
    if (it.deleted || !it.countable) continue;
    const key = idKey(it.origin) + '|' + idKey(it.rightOrigin);
    const g = groups.get(key);
    const entry = { at, len: it.length, client: it.id.client };
    if (g) g.push(entry); else groups.set(key, [entry]);
    at += it.length;
  }
  const victims = [];
  groups.forEach((g) => {
    if (g.length < 2) return;
    g.sort((a, b) => b.client - a.client);
    victims.push(...g.slice(1));
  });
  victims.sort((a, b) => b.at - a.at).forEach((v) => yRow.delete(v.at, v.len));
  return victims.length;
}

export function healConcurrentCellDuplicates(ydoc, origin) {
  const root = ydoc.getMap('project');
  const tables = [];
  root.forEach((v) => {
    if (v instanceof Y.Map && v.get('headers') instanceof Y.Array && v.get('rows') instanceof Y.Array) tables.push(v);
  });
  const corrupt = [];
  for (const t of tables) {
    const width = t.get('headers').length;
    t.get('rows').forEach((yRow) => { if (yRow instanceof Y.Array && width && yRow.length > width) corrupt.push([yRow, width]); });
  }
  if (!corrupt.length) return 0;
  let n = 0;
  ydoc.transact(() => { for (const [yRow, width] of corrupt) n += healRowArray(yRow, width); }, origin);
  return n;
}

// ---------------------------------------------------------------------------
// JS -> Y 변환
// ---------------------------------------------------------------------------
function newText(str) {
  const t = new Y.Text();
  if (str != null && str !== '') t.insert(0, normalizeLineBreaks(String(str)));
  return t;
}

// keyName이 rich-text 키면 문자열을 Y.Text로, 그 외는 재귀 변환.
export function jsToY(value, keyName) {
  if (typeof value === 'string' && keyName != null && RICH_TEXT_KEYS.has(keyName)) {
    return newText(value);
  }
  if (Array.isArray(value)) {
    const arr = new Y.Array();
    arr.push(value.map((v) => jsToY(v)));
    return arr;
  }
  if (value && typeof value === 'object') {
    const map = new Y.Map();
    for (const k of Object.keys(value)) map.set(k, jsToY(value[k], k));
    return map;
  }
  return value; // number | boolean | null | (rich가 아닌) string
}

// sheet1 전용 변환: 행은 고정폭 Y.Array<셀>, 텍스트 컬럼만 Y.Text.
function rowToY(rowArr, headers) {
  const yRow = new Y.Array();
  const cells = rowArr.map((cell, c) =>
    RICH_TEXT_COLUMNS.has(headers[c]) ? newText(cell) : cell
  );
  yRow.push(cells);
  return yRow;
}

// ---------------------------------------------------------------------------
// Y -> JS 재구성
// ---------------------------------------------------------------------------
export function yToJs(node) {
  if (node instanceof Y.Text) return node.toString();
  if (node instanceof Y.Array) return node.toArray().map(yToJs);
  if (node instanceof Y.Map) {
    const obj = {};
    node.forEach((v, k) => { obj[k] = yToJs(v); });
    return obj;
  }
  return node;
}

function readRow(yRow, headers) {
  return yRow.toArray().map((cell, c) => {
    if (cell instanceof Y.Text) {
      const s = cell.toString();
      return s === '' ? null : s; // 빈 텍스트 칸은 앱 규약대로 null
    }
    return cell;
  });
}

// Y.Doc 전체 -> 앱이 렌더할 DATA 객체(개인 설정 제외).
export function readProject(ydoc) {
  const root = ydoc.getMap('project');
  const data = {};
  root.forEach((v, k) => {
    if (k === 'sheet1') {
      const yHeaders = v.get('headers');
      const yRows = v.get('rows');
      const headers = yHeaders ? yHeaders.toArray() : [];
      data.sheet1 = {
        headers,
        rows: yRows ? yRows.toArray().map((r) => readRow(r, headers)) : [],
      };
    } else {
      data[k] = yToJs(v);
    }
  });
  return data;
}

// ---------------------------------------------------------------------------
// 최초 구성: 비어 있는 Y.Doc를 DATA로 채운다(이미 있으면 건너뜀).
// ---------------------------------------------------------------------------
export function buildProject(ydoc, data, origin) {
  const root = ydoc.getMap('project');
  if (root.size > 0) return false; // 원격에서 이미 로드됨
  normalizeDataLineBreaks(data);
  ydoc.transact(() => {
    for (const k of Object.keys(data)) {
      if (PERSONAL_KEYS.has(k)) continue;
      if (k === 'sheet1') {
        const sheet = new Y.Map();
        const headers = (data.sheet1 && data.sheet1.headers) || [];
        const yHeaders = new Y.Array(); yHeaders.push(headers.slice());
        const yRows = new Y.Array();
        yRows.push((data.sheet1.rows || []).map((r) => rowToY(r, headers)));
        sheet.set('headers', yHeaders);
        sheet.set('rows', yRows);
        root.set('sheet1', sheet);
      } else {
        root.set(k, jsToY(data[k], k));
      }
    }
  }, origin);
  return true;
}

// ---------------------------------------------------------------------------
// 텍스트 최소 diff -> Y.Text 연산(동시 편집과 병합됨)
// ---------------------------------------------------------------------------
// a -> b 를 "가운데 한 구간 교체"로 표현: 공통 접두 p, 지울 길이 del, 넣을 문자열 ins.
function textHunk(a, b) {
  let p = 0;
  const m = Math.min(a.length, b.length);
  while (p < m && a[p] === b[p]) p++;
  let s = 0;
  while (s < m - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { p, del: a.length - p - s, ins: b.slice(p, b.length - s) };
}

// oldStr = 내 편집의 기준값(shadow), newStr = 내 새 값. oldStr는 Y 위치 계산의 기준이라 원문 그대로 두고 newStr만 정규화.
// Y.Text가 기준값과 같으면 그대로 diff를 적용하고, 다르면(아직 앱에 반영 안 된 원격 편집이 섞임) 3-way 병합한다:
// 내 변경 구간과 원격 변경 구간이 안 겹치면 둘 다 살리고, 겹치면 그 구간만 내 값으로 둔다.
// 예전엔 기준이 어긋나면 엉뚱한 위치에 적용되거나 전체 교체(원격 편집 소실), 같은 변경을 두 번 넣기도 했다.
export function applyTextDiff(ytext, oldStr, newStr) {
  oldStr = oldStr == null ? '' : String(oldStr);
  newStr = newStr == null ? '' : normalizeLineBreaks(String(newStr));
  if (oldStr === newStr) return;
  const cur = ytext.toString();
  if (cur === newStr) return;                       // 이미 반영됨 → 중복 적용 금지

  const L = textHunk(oldStr, newStr);
  let at = L.p;
  if (cur !== oldStr) {
    const R = textHunk(oldStr, cur);                // 기준 이후 Y에 들어온 원격 변경
    if (L.p + L.del <= R.p) {
      at = L.p;                                     // 내 변경이 원격 변경보다 앞: 위치 그대로
    } else if (R.p + R.del <= L.p) {
      at = L.p + R.ins.length - R.del;              // 뒤: 원격이 늘리고 줄인 만큼 이동
    } else {
      // 같은 글자 구간을 둘 다 고침 → 합친 구간을 내 값으로(그 밖의 원격 편집은 보존)
      const a = Math.min(L.p, R.p), b = Math.max(L.p + L.del, R.p + R.del);
      ytext.delete(a, b + R.ins.length - R.del - a);
      ytext.insert(a, newStr.slice(a, b + L.ins.length - L.del));
      return;
    }
  }
  at = Math.max(0, Math.min(at, ytext.length));
  const del = Math.min(L.del, ytext.length - at);
  if (del > 0) ytext.delete(at, del);
  if (L.ins) ytext.insert(at, L.ins);
}

// 셀/키의 기준값을 모를 때(shadow에 없음)는 Y 현재값을 기준으로 삼아 "덮어쓰기"로 처리한다.
// 빈 문자열을 기준으로 쓰면 Y에 이미 있는 글 앞에 같은 글이 한 번 더 붙었다.
function textBase(sv, ytext) {
  if (typeof sv === 'string') return sv;
  if (sv === null) return '';                      // 빈 칸(앱 규약 null)으로 알려진 기준
  return ytext.toString();
}

// ---------------------------------------------------------------------------
// 재조정(reconcile): DATA(현재) vs shadow(직전 동기 상태)를 diff해 Y에 적용.
// persist()에서 호출한다. origin으로 로컬 변경임을 표시(에코 방지).
//
// ⚠ shadow = "앱의 DATA가 기반한 상태"(기준)다. Y에는 그 뒤에 들어온 원격 편집이 더 있을 수 있으므로,
//   diff(DATA vs shadow)로 "내가 바꾼 것"만 골라 Y에 얹고, 삭제도 "기준엔 있었는데 내가 없앤 것"만 한다.
//   (예전엔 Y 기준으로 지워서, 아직 앱에 반영 안 된 원격 추가분 — 새 노드·위치·키 — 이 지워졌다.)
// ---------------------------------------------------------------------------
function deepEq(a, b) {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
}
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export function reconcile(ydoc, data, shadow, origin) {
  const root = ydoc.getMap('project');
  // data의 줄바꿈을 제자리 정규화한다. 그래야 Y에 CR이 안 들어가고, 호출자가 뜨는 shadow(=clone(data))도
  // Y와 글자 단위로 일치한다. shadow에 남은 CR은 원문 그대로 두어야 diff 위치가 Y와 맞는다.
  normalizeDataLineBreaks(data);
  ydoc.transact(() => {
    // 내가 지운 최상위 키만 삭제(보호 키는 incoming data에 없어도 지우지 않음 — 옛 클라이언트발 유실 방지)
    root.forEach((_v, k) => {
      if (!(k in data) && !PERSONAL_KEYS.has(k) && !PROTECTED_KEYS.has(k) && (!shadow || k in shadow)) root.delete(k);
    });
    for (const k of Object.keys(data)) {
      if (PERSONAL_KEYS.has(k)) continue;
      const dv = data[k];
      const sv = shadow ? shadow[k] : undefined;
      // 내가 안 바꾼 키는 건너뜀(원격이 지운 키를 되살리지 않음)
      if (deepEq(dv, sv) && (root.has(k) || (shadow && k in shadow))) continue;
      if (k === 'sheet1') {
        reconcileSheet(root, dv, sv);
      } else {
        reconcileChildInMap(root, k, dv, sv, k);
      }
    }
  }, origin);
}

function reconcileSheet(root, data, shadow) {
  let sheet = root.get('sheet1');
  if (!(sheet instanceof Y.Map)) {
    root.set('sheet1', jsToY(data, 'sheet1')); // 초기화 방어
    return;
  }
  const headers = (data && data.headers) || [];
  // 헤더는 내가 바꿨을 때만 통째 교체(드묾). 기준을 모르면 Y와 다를 때 교체(옛 동작).
  const yHeaders = sheet.get('headers');
  const sHeaders = shadow ? shadow.headers : undefined;
  if (!deepEq(yHeaders ? yHeaders.toArray() : null, headers) && (sHeaders === undefined || !deepEq(headers, sHeaders))) {
    const nh = new Y.Array(); nh.push(headers.slice()); sheet.set('headers', nh);
  }
  const yRows = sheet.get('rows');
  const dataRows = (data && data.rows) || [];
  // 행은 지역ID로 맞춘다 — 원격이 그 사이 행을 추가/삭제해 Y의 행 순번이 DATA와 달라도
  // 내 편집이 "같은 노드"에 가고, 원격이 추가한 노드를 내 새 노드로 덮어쓰지 않는다.
  if (shadow && Array.isArray(shadow.rows) && reconcileRowsByKey(
    yRows, dataRows, shadow.rows, ID_COL,
    (r) => rowToY(r, headers),
    (yRow, dRow, sRow) => reconcileRow(yRow, dRow, sRow, headers),
  )) return;
  reconcileRows(yRows, dataRows, (shadow && shadow.rows) || [], headers);
}

// ---------------------------------------------------------------------------
// 행 키(ID) 기반 3-way 행 재조정. 표(시트/아이템 표)의 행 배열에 쓴다.
// 키 = 키 열 값 + 같은 값의 몇 번째인지(중복 ID·빈 ID도 순서대로 구분).
// 내가 기존 행의 "순서"를 바꾼 경우(드묾)만 false를 돌려 인덱스 방식(reconcileRows)에 맡긴다.
// ---------------------------------------------------------------------------
function cellKey(v) {
  if (v instanceof Y.Text) v = v.toString();
  return v == null ? '' : String(v);
}
function occurrenceKeys(cells) {
  const seen = new Map();
  return cells.map((v) => {
    const k = cellKey(v);
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    return n === 1 ? k : k + '\u0000' + n;
  });
}
function yRowKeyIndex(yRows, keyCol) {
  const keys = occurrenceKeys(yRows.toArray().map((yr) =>
    (yr instanceof Y.Array && yr.length > keyCol) ? yr.get(keyCol) : null));
  const m = new Map();
  keys.forEach((k, i) => m.set(k, i));
  return m;
}

function sameExceptCol(a, b, col) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const n = Math.max(a.length, b.length);
  for (let c = 0; c < n; c++) {
    if (c !== col && !deepEq(a[c] === undefined ? null : a[c], b[c] === undefined ? null : b[c])) return false;
  }
  return true;
}

function reconcileRowsByKey(yRows, dataRows, shadowRows, keyCol, makeY, editRow) {
  const dKeys = occurrenceKeys(dataRows.map((r) => (r ? r[keyCol] : null)));
  const sKeys = occurrenceKeys(shadowRows.map((r) => (r ? r[keyCol] : null)));
  const dSet = new Set(dKeys);
  const sPos = new Map(sKeys.map((k, i) => [k, i]));
  // 내가 기존 행의 상대 순서를 바꿨으면 키로 표현하기 어렵다 → 인덱스 방식
  const a = dKeys.filter((k) => sPos.has(k));
  const b = sKeys.filter((k) => dSet.has(k));
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;

  // 기준(shadow)과 DATA를 공통 행을 기준점 삼아 나란히 훑어 편집/삭제/추가를 고른다.
  const edits = [], dels = [], adds = []; // edits: [shadow 인덱스, data 인덱스]
  for (let si = 0, di = 0; si < sKeys.length || di < dKeys.length;) {
    const sRun = [], dRun = [];
    while (si < sKeys.length && !dSet.has(sKeys[si])) sRun.push(si++);
    while (di < dKeys.length && !sPos.has(dKeys[di])) dRun.push(di++);
    // 같은 자리에서 ID만 바뀐 행(중복 ID 정리로 새 ID를 받은 노드 등)은 "그 행의 편집"으로 보낸다.
    // 삭제+추가로 보내면 여러 클라이언트가 같은 정리를 동시에 할 때마다 새 행이 하나씩 불어난다.
    let k = 0;
    for (; k < sRun.length && k < dRun.length && sameExceptCol(shadowRows[sRun[k]], dataRows[dRun[k]], keyCol); k++) {
      edits.push([sRun[k], dRun[k]]);
    }
    for (let x = k; x < sRun.length; x++) dels.push(sRun[x]);
    for (let x = k; x < dRun.length; x++) adds.push(dRun[x]);
    if (si < sKeys.length && di < dKeys.length) { // 공통 행(순서 검사로 같은 키가 보장됨)
      if (!deepEq(dataRows[di], shadowRows[si])) edits.push([si, di]);
      si++; di++;
    }
  }
  if (!edits.length && !dels.length && !adds.length) return true;

  const yIdx = yRowKeyIndex(yRows, keyCol); // 편집은 행 위치를 바꾸지 않으므로 삭제까지 이 위치를 쓴다
  // 1) 내가 고친 행 → Y에서 같은 키의 행에 셀 단위 재조정. 원격이 그 행을 지웠으면 삭제가 우선
  //    (ID만 바뀐 행은 원격 삭제와 무관한 새 행일 수 있으니 추가로 살린다).
  for (const [si, di] of edits) {
    const yi = yIdx.get(sKeys[si]);
    if (yi === undefined) { if (sKeys[si] !== dKeys[di]) adds.push(di); continue; }
    editRow(yRows.get(yi), dataRows[di], shadowRows[si]);
  }
  // 2) 내가 지운 행 → Y에서 그 키의 행 삭제(뒤에서부터). 원격이 이미 지웠으면 건너뜀.
  dels.map((si) => yIdx.get(sKeys[si])).filter((p) => p !== undefined)
    .sort((x, y) => y - x).forEach((p) => yRows.delete(p, 1));
  // 3) 내가 추가한 행 → DATA에서 바로 앞 행의 뒤에 끼운다(연속된 새 행은 한 번에).
  //    Y에 같은 키가 이미 있어도(두 사람이 동시에 같은 ID를 만든 경우) 덮어쓰지 않고 따로 넣는다 —
  //    두 노드 모두 보존되고, 중복 ID는 앱의 노드 무결성 정리가 처리한다.
  adds.sort((x, y) => x - y);
  for (let i = 0; i < adds.length;) {
    let j = i + 1;
    while (j < adds.length && adds[j] === adds[j - 1] + 1) j++;
    const idx = yRowKeyIndex(yRows, keyCol);
    let at = 0;
    for (let q = adds[i] - 1; q >= 0; q--) {
      if (idx.has(dKeys[q])) { at = idx.get(dKeys[q]) + 1; break; }
    }
    yRows.insert(at, adds.slice(i, j).map((di) => makeY(dataRows[di])));
    i = j;
  }
  return true;
}

// 인덱스 방식(옛 동작): 내가 행 순서를 바꿨거나 기준을 모를 때만 쓴다.
function reconcileRows(yRows, dataRows, shadowRows, headers) {
  // 꼬리 증감 + 인덱스별 재조정(추가/편집/말단삭제에 최적. 소규모 팀 편집 패턴).
  const yLen = yRows.length;
  // 데이터가 더 짧아졌으면 말단 삭제
  if (dataRows.length < yLen) {
    yRows.delete(dataRows.length, yLen - dataRows.length);
  }
  for (let i = 0; i < dataRows.length; i++) {
    const dRow = dataRows[i];
    const sRow = shadowRows[i];
    if (i >= yRows.length) {
      yRows.push([rowToY(dRow, headers)]); // 새 행
      continue;
    }
    if (deepEq(dRow, sRow)) continue;
    reconcileRow(yRows.get(i), dRow, sRow, headers);
  }
}

function reconcileRow(yRow, dRow, sRow, headers) {
  for (let c = 0; c < dRow.length; c++) {
    const dv = dRow[c];
    const sv = sRow ? sRow[c] : undefined;
    if (deepEq(dv, sv)) continue;
    const isText = RICH_TEXT_COLUMNS.has(headers[c]);
    // Yjs 행이 이 열까지 없는 경우(마이그레이션으로 열이 늘어난 sparse 행) → 홀은 null로 채우고 append.
    // 예전엔 여기서 yRow.delete(c,1)이 범위를 벗어나 "Length exceeded!"로 reconcile이 죽어 편집이 유실됐다.
    if (c >= yRow.length) {
      while (yRow.length < c) yRow.push([null]);
      yRow.push([isText ? newText(dv) : dv]);
      continue;
    }
    if (isText) {
      let cell = yRow.get(c);
      if (!(cell instanceof Y.Text)) { // 타입 방어
        yRow.delete(c, 1); yRow.insert(c, [newText(dv)]);
      } else {
        applyTextDiff(cell, textBase(sv, cell), dv);
      }
    } else {
      yRow.delete(c, 1); yRow.insert(c, [dv]);
    }
  }
}

// 일반 객체(Y.Map) 자식 재조정. sv = 기준값(모르면 undefined).
function reconcileChildInMap(ymap, key, dv, sv, keyName) {
  const cur = ymap.get(key);
  // rich-text 문자열
  if (typeof dv === 'string' && RICH_TEXT_KEYS.has(keyName)) {
    if (cur instanceof Y.Text) applyTextDiff(cur, textBase(sv, cur), dv);
    else ymap.set(key, newText(dv));
    return;
  }
  if (Array.isArray(dv)) {
    if (cur instanceof Y.Array) reconcileArray(cur, dv, Array.isArray(sv) ? sv : null, keyName);
    else ymap.set(key, jsToY(dv, keyName));
    return;
  }
  if (isPlainObject(dv)) {
    if (cur instanceof Y.Map) reconcileMap(cur, dv, isPlainObject(sv) ? sv : null);
    else ymap.set(key, jsToY(dv, keyName));
    return;
  }
  ymap.set(key, dv); // 스칼라/null
}

// shadow = 기준 객체(모르면 null → Y를 data와 똑같이 맞추는 옛 동작)
function reconcileMap(ymap, data, shadow) {
  const base = isPlainObject(shadow) ? shadow : null;
  // 내가 지운 키만 삭제 — 원격이 새로 넣은 키(새 노드의 그래프 위치 등)는 보존
  ymap.forEach((_v, k) => { if (!(k in data) && (!base || k in base)) ymap.delete(k); });
  for (const k of Object.keys(data)) {
    const sv = base ? base[k] : undefined;
    // 내가 안 바꾼 키는 건너뜀(원격이 지운 키를 되살리지 않음)
    if (deepEq(data[k], sv) && (ymap.has(k) || (base && k in base))) continue;
    reconcileChildInMap(ymap, k, data[k], sv, k);
  }
}

const isRowList = (arr) => Array.isArray(arr) && arr.every(Array.isArray);

// 일반 배열. shadowArr = 기준 배열(모르면 null → Y 현재값을 기준으로 삼아 data와 똑같이 맞춤).
function reconcileArray(yarr, dataArr, shadowArr, keyName) {
  const base = Array.isArray(shadowArr) ? shadowArr : yToJs(yarr);
  // 표의 행 배열(아이템·키아이템·서브퀘스트 등 {headers, rows})은 0열(ID) 기준으로 맞춘다.
  if (keyName === 'rows' && isRowList(dataArr) && isRowList(base) && reconcileRowsByKey(
    yarr, dataArr, base, 0,
    (r) => jsToY(r),
    (yRow, dRow, sRow) => { if (yRow instanceof Y.Array) reconcileArray(yRow, dRow, sRow, null); },
  )) return;
  const sLen = base.length, dLen = dataArr.length;
  for (let i = 0; i < Math.min(sLen, dLen) && i < yarr.length; i++) {
    const dv = dataArr[i];
    const sv = base[i];
    if (deepEq(dv, sv)) continue;
    const cur = yarr.get(i);
    if (Array.isArray(dv) && cur instanceof Y.Array) { reconcileArray(cur, dv, Array.isArray(sv) ? sv : null, keyName); continue; }
    if (isPlainObject(dv) && cur instanceof Y.Map) { reconcileMap(cur, dv, isPlainObject(sv) ? sv : null); continue; }
    yarr.delete(i, 1); yarr.insert(i, [jsToY(dv, keyName)]);
  }
  // 내가 줄인 만큼만 그 자리에서 삭제(원격이 뒤에 덧붙인 요소는 보존)
  if (dLen < sLen) {
    const n = Math.min(sLen - dLen, yarr.length - dLen);
    if (n > 0) yarr.delete(dLen, n);
  }
  // 내가 늘린 요소는 기준 길이 자리에 넣는다(원격이 끝에 덧붙인 요소를 덮어쓰지 않음)
  if (dLen > sLen) yarr.insert(Math.min(sLen, yarr.length), dataArr.slice(sLen).map((v) => jsToY(v)));
}

// ---------------------------------------------------------------------------
// 라이브 텍스트 바인딩용: 특정 셀의 Y.Text를 찾는다.
// 행은 "지역ID"(1번 열) 값으로 식별(인덱스보다 안정적).
// ---------------------------------------------------------------------------
export function getRowTextCellById(ydoc, regionId, colIndex) {
  const sheet = ydoc.getMap('project').get('sheet1');
  if (!(sheet instanceof Y.Map)) return null;
  const yRows = sheet.get('rows');
  if (!(yRows instanceof Y.Array)) return null;
  for (let i = 0; i < yRows.length; i++) {
    const row = yRows.get(i);
    const idCell = row.get(ID_COL);
    const idVal = idCell instanceof Y.Text ? idCell.toString() : idCell;
    if (idVal === regionId) {
      const cell = row.get(colIndex);
      return cell instanceof Y.Text ? cell : null;
    }
  }
  return null;
}
