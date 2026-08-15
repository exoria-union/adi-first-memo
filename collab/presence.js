// ============================================================================
// 프레즌스 UI: 접속자 아바타 + "누가 무엇을 편집 중"
// awareness의 상태를 받아 DOM으로 그린다(앱 렌더 로직은 건드리지 않음).
// ============================================================================

// 사용자별 안정적인 색상(이메일/ID 해시 기반)
export function colorFor(key) {
  let h = 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 62% 45%)`;
}

export function initialsFor(nameOrEmail) {
  const s = String(nameOrEmail || '?').trim();
  const local = s.split('@')[0];
  return (local.slice(0, 2) || '?').toUpperCase();
}

// states: Map<clientId, {user:{id,name,color}, editing?:{label}}>
export function renderAvatars(container, states, selfClientId) {
  if (!container) return;
  const seen = new Map(); // user.id -> {user, editing}
  states.forEach((st, cid) => {
    if (!st || !st.user) return;
    seen.set(st.user.id + '', { ...st, self: cid === selfClientId });
  });
  container.innerHTML = '';
  const frag = document.createDocumentFragment();
  seen.forEach((st) => {
    const dot = document.createElement('span');
    dot.className = 'collab-avatar' + (st.self ? ' self' : '');
    dot.style.background = st.user.color || colorFor(st.user.id);
    dot.textContent = initialsFor(st.user.name);
    const who = st.user.name + (st.self ? ' (나)' : '');
    dot.title = st.editing && st.editing.label
      ? `${who} · [${st.editing.label}] 편집 중`
      : who;
    frag.appendChild(dot);
  });
  container.appendChild(frag);

  // "누가 무엇을 편집 중" 요약(자기 자신 제외)
  const editors = [];
  seen.forEach((st) => {
    if (!st.self && st.editing && st.editing.label) {
      editors.push(`${st.user.name.split('@')[0]} · [${st.editing.label}]`);
    }
  });
  return editors;
}
