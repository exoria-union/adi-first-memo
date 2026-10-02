// ============================================================================
// 협업 엔진 공개 API — index.html이 호출하는 유일한 진입점.
//   const session = await openProject({...});
//   session.push(DATA)            // 로컬 편집 -> Y로 반영(방송+영속)
//   DATA = session.sync(DATA)     // 원격 변경 반영: 내 미반영 편집을 먼저 올리고 병합본을 받는다
//   session.setEditing(label)     // 프레즌스: 내가 무엇을 편집 중
//   session.bindText(el,rowId,col)// (선택) 텍스트칸 글자단위 실시간 바인딩
//   session.destroy()
//
// ⚠ 불변식: shadow = "앱의 DATA가 기반한 상태". push는 diff(DATA vs shadow) = 내 편집만 Y에 얹는다.
//   원격 업데이트가 와도 shadow를 앞당기면 안 된다(앱 DATA는 그대로라 다음 push가 원격 편집을 옛 값으로
//   되돌렸다 — "동시 편집이 적용 안 됨/방금 입력이 사라짐"). shadow는 앱이 병합본을 받아 DATA를 교체할 때
//   (sync/readCurrent)만 함께 옮긴다.
// ============================================================================

import { Y, Awareness } from './deps.js';
import {
  buildProject, readProject, reconcile, applyTextDiff, getRowTextCellById, repairTextLineBreaks,
  healConcurrentCellDuplicates,
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
  // 과거에 CR(\r)이 섞여 저장된 문서면 여기서 LF로 복구(방송+영속). 이후 DATA·shadow·textarea가
  // 모두 같은 LF 문자열을 보게 되어 글자 위치가 어긋나지 않는다.
  repairTextLineBreaks(ydoc, APP);
  // 같은 칸 동시 편집으로 한 칸 길어진(뒤 칸이 밀린) 행이 있으면 복구.
  healConcurrentCellDuplicates(ydoc, APP);

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

  // 원격 변경 -> 앱에 알림(디바운스). 우리 로컬 origin(APP/LIVE)은 무시.
  // 여기서 data/shadow를 바꾸지 않는다(위 불변식). 앱이 알림을 받아 sync(DATA)로 병합본을 가져간다.
  let readTimer = null;
  ydoc.on('update', (_u, origin) => {
    if (origin !== provider) return; // 원격/영속에서 온 것만
    clearTimeout(readTimer);
    readTimer = setTimeout(() => { if (onRemote) onRemote(); }, 80);
  });

  // 현재 Y 병합본을 읽고 그것을 새 기준(shadow)으로 삼는다. 반환값으로 앱 DATA를 교체해야 한다.
  function adopt() {
    healConcurrentCellDuplicates(ydoc, APP);
    data = readProject(ydoc);
    shadow = clone(data);
    return data;
  }
  function push(latest) {
    healConcurrentCellDuplicates(ydoc, APP);   // 밀린 행에 내 편집이 엉뚱한 칸으로 가지 않도록 먼저 복구
    reconcile(ydoc, latest, shadow, APP);
    shadow = clone(latest);
    data = latest;
  }

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
      // shadow는 건드리지 않는다: 앱 DATA 칸은 아직 옛 값이라, shadow만 원격값으로 옮기면
      // 다음 push가 diff(옛 값 vs 원격값)로 원격 편집을 되돌린다. 다음 입력/병합(sync) 때 함께 맞춰진다.
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
    // 현재 Yjs 병합본(로컬+원격)을 읽고 새 기준으로 삼는다 → 반환값으로 DATA를 교체할 것.
    // (DATA를 교체하지 않을 거면 쓰지 말 것: shadow만 앞당겨져 다음 push가 원격 편집을 되돌린다.)
    readCurrent() { return adopt(); },
    push,
    // 원격 변경 반영용: 앱의 아직 안 올린 편집(latest)을 먼저 Y에 얹고, 병합본을 새 기준으로 돌려준다.
    sync(latest) {
      if (latest) push(latest);
      return adopt();
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
    // ⚠ shadow에는 앱의 합성값이 아니라 "Y.Text에 실제로 남은 값"을 넣는다(앱도 DATA 칸을 getCellTextValue로
    //   맞출 것). 본문 뒤 선택지 부분이 joinScript 표준형과 다르면(빈 줄 수·CR·원격이 추가한 선택지 등)
    //   합성값≠Y인데, 예전처럼 shadow=합성값이면 Y≠DATA가 조용히 고착되고 다음 재조정 diff가 어긋난
    //   위치에 적용됐다(예: 선택지 이모티콘 " :sq:"가 다른 줄에 박힘).
    //   composedForShadow는 옛 호출 호환용으로만 받는다(미사용).
    applyCellTextEdit(rowId, col, oldStr, newStr, composedForShadow) {
      const t = getRowTextCellById(ydoc, rowId, col);
      if (!t) return false;
      ydoc.transact(() => applyTextDiff(t, oldStr, newStr), LIVE);
      setShadowCell(rowId, col, t.toString());
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
