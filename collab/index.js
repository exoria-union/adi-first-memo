// ============================================================================
// 협업 엔진 공개 API — index.html이 호출하는 유일한 진입점.
//   const session = await openProject({...});
//   session.push(DATA)            // 로컬 편집 -> Y로 반영(방송+영속)
//   session.setEditing(label)     // 프레즌스: 내가 무엇을 편집 중
//   session.bindText(el,rowId,col)// (선택) 텍스트칸 글자단위 실시간 바인딩
//   session.destroy()
// ============================================================================

import { Y, Awareness } from './deps.js';
import {
  buildProject, readProject, reconcile, applyTextDiff, getRowTextCellById,
} from './ydoc.js';
import { SupabaseYjsProvider } from './provider.js';
import { colorFor } from './presence.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const APP = 'app';        // 로컬 편집(재조정) origin
const LIVE = 'app-live';  // 라이브 텍스트 바인딩 origin

export async function openProject(cfg) {
  const { supabase, projectId, user, seedData, onRemote, onPresence, onStatus } = cfg;

  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  const provider = new SupabaseYjsProvider(supabase, projectId, ydoc, {
    awareness,
    onStatus: onStatus || (() => {}),
  });

  await provider.connect(); // DB에서 현재 상태 로드 + 채널 구독 + 핸드셰이크

  // 브랜드-뉴 프로젝트면 로컬 데이터로 시드(최초 클라이언트만).
  // 주의: 완전 신규 프로젝트를 두 명이 "동시에" 처음 여는 경우의 시드 경쟁은
  // 소규모 팀에선 사실상 발생하지 않는다(필요하면 DB 유니크 클레임으로 방지).
  const root = ydoc.getMap('project');
  if (root.size === 0 && seedData) buildProject(ydoc, clone(seedData), APP);

  let data = readProject(ydoc);
  let shadow = clone(data);

  // 내 프레즌스 상태
  awareness.setLocalStateField('user', {
    id: user.id,
    name: user.email || user.id,
    color: colorFor(user.id),
  });
  const pushPresence = () => {
    if (onPresence) onPresence(awareness.getStates(), awareness.clientID);
  };
  awareness.on('change', pushPresence);
  pushPresence();

  // 원격 변경 -> 앱(디바운스). 우리 로컬 origin(APP/LIVE)은 무시.
  let readTimer = null;
  ydoc.on('update', (_u, origin) => {
    if (origin !== provider) return; // 원격/영속에서 온 것만
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      data = readProject(ydoc);
      shadow = clone(data);
      if (onRemote) onRemote(data);
    }, 80);
  });

  // ---- shadow의 특정 셀 값을 갱신(라이브 바인딩이 재조정 중복을 막기 위해) ----
  function setShadowCell(rowId, col, val) {
    if (!shadow.sheet1) return;
    const rows = shadow.sheet1.rows;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][1] === rowId) { rows[i][col] = val; if (data.sheet1) data.sheet1.rows[i][col] = val; return; }
    }
  }

  // ---- (선택) 라이브 텍스트 바인딩: 포커스된 텍스트칸을 글자단위로 동기화 ----
  function bindText(el, rowId, col) {
    const ytext = getRowTextCellById(ydoc, rowId, col);
    if (!ytext) return () => {};
    let composing = false;
    let prev = ytext.toString();
    if (el.value !== prev) el.value = prev;

    const onInput = () => {
      if (composing) return;
      const val = el.value;
      ydoc.transact(() => applyTextDiff(ytext, prev, val), LIVE);
      prev = val;
      setShadowCell(rowId, col, val); // 앱 persist가 같은 칸을 다시 건드리지 않게
    };
    const onCompStart = () => { composing = true; };
    const onCompEnd = () => { composing = false; onInput(); };
    const observer = (_evt, tr) => {
      if (tr.origin === LIVE) return;     // 내 키 입력
      if (composing) return;              // 한글 조합 중엔 건드리지 않음
      const next = ytext.toString();
      if (next === el.value) { prev = next; return; }
      setInputPreservingCaret(el, next);  // 원격 변경 반영, 커서 보존
      prev = next;
      setShadowCell(rowId, col, next);
    };
    el.addEventListener('input', onInput);
    el.addEventListener('compositionstart', onCompStart);
    el.addEventListener('compositionend', onCompEnd);
    ytext.observe(observer);
    return function unbind() {
      el.removeEventListener('input', onInput);
      el.removeEventListener('compositionstart', onCompStart);
      el.removeEventListener('compositionend', onCompEnd);
      try { ytext.unobserve(observer); } catch (e) {}
    };
  }

  return {
    ydoc, awareness, provider,
    get data() { return data; },
    // 현재 Yjs 문서의 병합 결과(로컬+원격)를 즉시 읽는다. blur 시 안전 병합에 사용.
    readCurrent() { return readProject(ydoc); },
    push(latest) {
      reconcile(ydoc, latest, shadow, APP);
      shadow = clone(latest);
      data = latest;
    },
    setEditing(label) {
      awareness.setLocalStateField('editing', label ? { label: String(label) } : null);
    },
    bindText,
    // 합성 편집기(scriptFieldEditor)용 저수준 프리미티브 --------------------
    // 현재 셀 Y.Text 값(문자열) 또는 null(텍스트 칸 아님)
    getCellTextValue(rowId, col) {
      const t = getRowTextCellById(ydoc, rowId, col);
      return t ? t.toString() : null;
    },
    // oldStr->newStr 최소 diff를 셀 Y.Text에 적용(글자 단위 병합). shadow도 동기화.
    // composedForShadow: 앱 DATA[cell]에 실제 저장되는 합성값(재조정 중복 방지용).
    applyCellTextEdit(rowId, col, oldStr, newStr, composedForShadow) {
      const t = getRowTextCellById(ydoc, rowId, col);
      if (!t) return false;
      ydoc.transact(() => applyTextDiff(t, oldStr, newStr), LIVE);
      setShadowCell(rowId, col, composedForShadow == null ? newStr : composedForShadow);
      return true;
    },
    // 원격 변경 구독(내 LIVE 편집은 제외). cb(합성문자열). 해제 함수 반환.
    observeCellText(rowId, col, cb) {
      const t = getRowTextCellById(ydoc, rowId, col);
      if (!t) return function () {};
      const obs = (_e, tr) => { if (tr.origin === LIVE) return; cb(t.toString()); };
      t.observe(obs);
      return function () { try { t.unobserve(obs); } catch (e) {} };
    },
    async destroy() {
      awareness.off('change', pushPresence);
      clearTimeout(readTimer);
      await provider.destroy();
      ydoc.destroy();
    },
  };
}

// 입력요소 값 교체 시 커서 위치 최대한 보존
function setInputPreservingCaret(el, next) {
  const cur = el.value;
  const start = el.selectionStart, end = el.selectionEnd;
  // 공통 접두 길이
  let p = 0; const m = Math.min(cur.length, next.length);
  while (p < m && cur[p] === next[p]) p++;
  el.value = next;
  if (start != null) {
    const delta = next.length - cur.length;
    const ns = start > p ? start + delta : start;
    const ne = end > p ? end + delta : end;
    try { el.setSelectionRange(Math.max(0, ns), Math.max(0, ne)); } catch (e) {}
  }
}

export { colorFor } from './presence.js';
export { renderAvatars } from './presence.js';
