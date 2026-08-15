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

const ID_COL = 1; // sheet1 헤더의 "지역ID" 열 인덱스(행 식별자)

// ---------------------------------------------------------------------------
// JS -> Y 변환
// ---------------------------------------------------------------------------
function newText(str) {
  const t = new Y.Text();
  if (str != null && str !== '') t.insert(0, String(str));
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
export function applyTextDiff(ytext, oldStr, newStr) {
  oldStr = oldStr == null ? '' : String(oldStr);
  newStr = newStr == null ? '' : String(newStr);
  if (oldStr === newStr) return;

  // 공통 접두/접미를 잘라 바뀐 가운데 구간만 교체.
  let p = 0;
  const minLen = Math.min(oldStr.length, newStr.length);
  while (p < minLen && oldStr[p] === newStr[p]) p++;
  let s = 0;
  while (
    s < minLen - p &&
    oldStr[oldStr.length - 1 - s] === newStr[newStr.length - 1 - s]
  ) s++;

  const delLen = oldStr.length - p - s;
  const insStr = newStr.slice(p, newStr.length - s);

  const cur = ytext.length;
  if (p > cur) {
    // Y.Text가 예상과 어긋남(원격 재편집 등) -> 안전하게 전체 교체.
    if (cur) ytext.delete(0, cur);
    ytext.insert(0, newStr);
    return;
  }
  const safeDel = Math.min(delLen, cur - p);
  if (safeDel > 0) ytext.delete(p, safeDel);
  if (insStr) ytext.insert(p, insStr);
}

// ---------------------------------------------------------------------------
// 재조정(reconcile): DATA(현재) vs shadow(직전 동기 상태)를 diff해 Y에 적용.
// persist()에서 호출한다. origin으로 로컬 변경임을 표시(에코 방지).
// ---------------------------------------------------------------------------
function deepEq(a, b) {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
}

export function reconcile(ydoc, data, shadow, origin) {
  const root = ydoc.getMap('project');
  ydoc.transact(() => {
    // 삭제된 최상위 키
    root.forEach((_v, k) => {
      if (!(k in data) && !PERSONAL_KEYS.has(k)) root.delete(k);
    });
    for (const k of Object.keys(data)) {
      if (PERSONAL_KEYS.has(k)) continue;
      const dv = data[k];
      const sv = shadow ? shadow[k] : undefined;
      if (deepEq(dv, sv) && root.has(k)) continue;
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
  // 헤더가 바뀌면 통째 교체(드묾)
  const yHeaders = sheet.get('headers');
  if (!deepEq(yHeaders ? yHeaders.toArray() : null, headers)) {
    const nh = new Y.Array(); nh.push(headers.slice()); sheet.set('headers', nh);
  }
  const yRows = sheet.get('rows');
  const dataRows = (data && data.rows) || [];
  const shadowRows = (shadow && shadow.rows) || [];
  reconcileRows(yRows, dataRows, shadowRows, headers);
}

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
    if (RICH_TEXT_COLUMNS.has(headers[c])) {
      let cell = yRow.get(c);
      if (!(cell instanceof Y.Text)) { // 타입 방어
        yRow.delete(c, 1); yRow.insert(c, [newText(dv)]);
      } else {
        applyTextDiff(cell, sv, dv);
      }
    } else {
      yRow.delete(c, 1); yRow.insert(c, [dv]); // 고정폭 -> 길이 유지
    }
  }
}

// 일반 객체(Y.Map) 자식 재조정
function reconcileChildInMap(ymap, key, dv, sv, keyName) {
  const cur = ymap.get(key);
  // rich-text 문자열
  if (typeof dv === 'string' && RICH_TEXT_KEYS.has(keyName)) {
    if (cur instanceof Y.Text) applyTextDiff(cur, sv, dv);
    else ymap.set(key, newText(dv));
    return;
  }
  if (Array.isArray(dv)) {
    if (cur instanceof Y.Array) reconcileArray(cur, dv, Array.isArray(sv) ? sv : [], keyName);
    else ymap.set(key, jsToY(dv, keyName));
    return;
  }
  if (dv && typeof dv === 'object') {
    if (cur instanceof Y.Map) reconcileMap(cur, dv, sv && typeof sv === 'object' ? sv : {});
    else ymap.set(key, jsToY(dv, keyName));
    return;
  }
  ymap.set(key, dv); // 스칼라/null
}

function reconcileMap(ymap, data, shadow) {
  ymap.forEach((_v, k) => { if (!(k in data)) ymap.delete(k); });
  for (const k of Object.keys(data)) {
    if (deepEq(data[k], shadow ? shadow[k] : undefined) && ymap.has(k)) continue;
    reconcileChildInMap(ymap, k, data[k], shadow ? shadow[k] : undefined, k);
  }
}

function reconcileArray(yarr, dataArr, shadowArr, keyName) {
  const yLen = yarr.length;
  if (dataArr.length < yLen) yarr.delete(dataArr.length, yLen - dataArr.length);
  for (let i = 0; i < dataArr.length; i++) {
    const dv = dataArr[i];
    const sv = shadowArr[i];
    if (i >= yarr.length) { yarr.push([jsToY(dv)]); continue; }
    if (deepEq(dv, sv)) continue;
    const cur = yarr.get(i);
    if (Array.isArray(dv) && cur instanceof Y.Array) { reconcileArray(cur, dv, Array.isArray(sv) ? sv : [], keyName); continue; }
    if (dv && typeof dv === 'object' && !(dv instanceof Array) && cur instanceof Y.Map) { reconcileMap(cur, dv, sv && typeof sv === 'object' ? sv : {}); continue; }
    yarr.delete(i, 1); yarr.insert(i, [jsToY(dv, keyName)]);
  }
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
