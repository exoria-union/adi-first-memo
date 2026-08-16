// ============================================================================
// 자동봇 "지역 탐사" 테스트 모드 — exoria_bot/mastodon_area_system.py 이식(단일 플레이어)
// ----------------------------------------------------------------------------
// 편집기의 지역 데이터(sheet1)를 bot_area로 매핑해, 실제 봇처럼 채팅으로 탐사를
// 체험/테스트한다. 명령 [지역/지역명/스탯/포션], 인카운터(00·02/03/04/99), 주사위,
// 스크립트 태그({name}/{XdY}/{a/b/c}), 아이템/골드/경험치를 원본 로직 그대로 재현.
//
// 단일 플레이어 근사(원본과 의도적으로 다른 부분, 명확히 표기):
//  - 팀/동행·최초팀 게이트·선행 완료(prerequisite, 전역 DB)·일일 한도·급여 등은
//    단순화. open_yn/healing_hp/open_roll 등 편집기에 없는 컬럼은 기본값(개방/0).
//  - '최초 탐사자' 여부는 캐릭터 설정의 토글로 대체(personalFirst).
//  - 아이템 지급은 인벤토리에 반영 + 이름 표시(편집기 items로 해석). 소모도 반영.
// ============================================================================

// bot_area 필드 → 편집기 시트 헤더
const COL = {
  parent_area_id: '상위지역ID(부모ID)', area_id: '지역ID', area_name: '지역명',
  adjacent_id: '인접 지역', incounter_cd: '종류 코드', area_cn: '스크립트(내용)',
  target_roll: '주사위 목표치', succ_cn: '성공 스크립트', fail_cn: '실패 스크립트',
  key_yn: '키아이템 필요 여부', key_id: '키아이템 ID', item_id: '파밍 아이템 ID',
  item_drop: '파밍 아이템 수', gold_drop: '파밍 골드', area_exp: '파밍 경험치',
  deal_item_id: '지역거래 시, 교단원이 낼 아이템ID', deal_gold: '지역거래 시, 교단원이 낼 골드 상한가',
  first_check_yn: '최초 탐사 여부', check_fail_cn: '최초 탐사가 아닐 시 실패 스크립트',
  open_race: '종족 전용', race_fail_cn: '종족이 아닐 때 스크립트', open_target: '개방 조건',
  first_drop_yn: '최초 유일 지급 여부', drop_fail_cn: '유일 아이템 소진 스크립트',
  branch_group: '갈림길 그룹',
};

const RACE_TO_CLASS = { VAM: 3, CYC: 6, GAG: 5, BAN: 4 };
const HALF_HUMAN = new Set([3, 4, 5, 6]);
const STAT_KOR = ['힘', '솜씨', '지혜'];
const STAT_COL = { '힘': 'str', '솜씨': 'diy', '지혜': 'wis' };

const safeInt = (v, d = 0) => { const n = parseInt(String(v == null ? '' : v).trim(), 10); return isNaN(n) ? d : n; };
const safeStr = (v, d = '') => (v == null ? d : String(v));
const rint = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

// XdY = X개 Y면 주사위 합
function randomDice(count, sides) { let s = 0; const c = safeInt(count, 1), n = safeInt(sides, 6); for (let i = 0; i < c; i++) s += rint(1, n); return s; }
function rollDiceExpr(expr, def = 1) {
  if (expr == null || expr === '') return def;
  const s = String(expr).toUpperCase().trim();
  if (!s.includes('D')) { const n = parseInt(s, 10); return isNaN(n) ? def : n; }
  const p = s.split('D'); if (p.length !== 2 || !/^\d+$/.test(p[0]) || !/^\d+$/.test(p[1])) return def;
  return randomDice(p[0], p[1]);
}
function parseIdList(raw) {
  if (raw == null) return [];
  return String(raw).trim().replace(/^\{|\}$/g, '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
}
// stat개 D6, 하나라도 target 이상이면 성공(+포션 시 stat+1)
function targetDice(stat, target, potion) {
  let st = safeInt(stat, 0); if (potion) st += 1;
  const rolls = [];
  const n = st >= 1 ? st : 0;
  for (let i = 0; i < n; i++) rolls.push(rint(1, 6));
  const good = rolls.some(r => r >= target);
  return { good, stat: st, target, rolls, dice_result: '[' + rolls.join(', ') + ']' };
}

export function buildAreas(rows, headers) {
  const idx = {}; headers.forEach((h, i) => { idx[h] = i; });
  const get = (row, field) => { const i = idx[COL[field]]; return i == null ? null : row[i]; };
  const areas = [];      // bot_area-shaped
  const byId = {};
  rows.forEach(row => {
    const a = {};
    for (const f in COL) a[f] = get(row, f);
    if (a.area_id == null || String(a.area_id).trim() === '') return;
    a.area_id = String(a.area_id);
    a.parent_area_id = a.parent_area_id == null ? '' : String(a.parent_area_id);
    a.area_name = safeStr(a.area_name);
    areas.push(a); byId[a.area_id] = a;
  });
  // 지역 루트(최상위 조상) 계산 → 같은 루트 안에서 선택지 이름 해석
  const rootOf = (a) => {
    let cur = a, guard = 0;
    while (cur && cur.parent_area_id && byId[cur.parent_area_id] && guard++ < 100) cur = byId[cur.parent_area_id];
    return cur ? cur.area_id : a.area_id;
  };
  areas.forEach(a => { a._root = rootOf(a); });
  // 이름→area (루트별 + 전역). 시작 지점은 parent 없는 최상위 노드.
  const byRootName = {}, byName = {};
  areas.forEach(a => {
    const nm = a.area_name.replace(/\s/g, '');
    (byRootName[a._root] = byRootName[a._root] || {});
    if (byRootName[a._root][nm] === undefined) byRootName[a._root][nm] = a;
    if (byName[nm] === undefined) byName[nm] = a;   // 최상위 우선(먼저 등록)
  });
  // 최상위(시작) 지역 우선 재등록: parent 빈 것
  areas.forEach(a => { if (!a.parent_area_id) { const nm = a.area_name.replace(/\s/g, ''); byName[nm] = a; } });
  return { areas, byId, byRootName, byName };
}

// ---- 스크립트 렌더링(extract_cn 이식) ----
function resolveTag(content) {
  const c = content.toUpperCase();
  if (c.includes('NAME')) return { rep: null, dice: 0 };       // {name} 은 4단계
  if (c.includes('D') && !c.includes('/')) {
    const p = c.split('D');
    if (p.length === 2 && /^\d+$/.test(p[0]) && /^\d+$/.test(p[1])) { const r = randomDice(p[0], p[1]); return { rep: String(r), dice: r }; }
    return { rep: null, dice: 0 };
  }
  if (content.includes('/')) { const ch = content.split('/').filter(Boolean); if (ch.length) return { rep: ch[rint(0, ch.length - 1)], dice: 0 }; }
  return { rep: null, dice: 0 };
}
function calcDropCount(itemDrop, tagContent, diceResult) {
  if (itemDrop == null || itemDrop === '') return 1;
  const s = String(itemDrop).toUpperCase().trim();
  if (diceResult > 0 && s === tagContent) return diceResult;
  if (/^\d+$/.test(s)) return safeInt(s, 1);
  if (s.includes('D')) return rollDiceExpr(s, 1);
  return 1;
}

export function createSim(data, opts = {}) {
  const A = buildAreas(data.rows, data.headers);
  const itemName = opts.itemName || (id => '아이템#' + id);
  // 캐릭터(설정 가능)
  const ch = Object.assign({
    ch_name: '체험자', ch_class: 0,       // 0=인간, RACE_TO_CLASS 값=반인
    str: 3, diy: 3, wis: 3,
    hp: 0, max_hp: 100, gold: 1000, exp: 0,   // hp=누적 피해량(0=만전). hp_left=max_hp-hp.
    inventory: [],                         // item id 배열
    personalFirst: true,                   // '최초 탐사자' 여부(단일 플레이어 근사)
  }, opts.character || {});
  let mission = null;                       // {area_id, root, result}
  const log = [];                          // 진행 로그(디버그)

  const hasItem = id => ch.inventory.includes(id);
  const consumeFirst = ids => { for (const id of ids) { const i = ch.inventory.indexOf(id); if (i >= 0) { ch.inventory.splice(i, 1); return true; } } return false; };
  const awardItem = (id, n) => { for (let k = 0; k < Math.max(0, n); k++) ch.inventory.push(id); };

  function extractCn(area, cnType) {
    let text = ''; let itemEvent = false; let markGranted = false;
    const fDrop = area.first_drop_yn, fCheck = area.first_check_yn;
    if (cnType === 'fail') text = safeStr(area.fail_cn);
    else if (cnType === 'succ') { text = safeStr(area.succ_cn); itemEvent = true; }
    else {
      text = safeStr(area.area_cn);
      const personalFirst = ch.personalFirst;
      if (fCheck === 'Y' && !personalFirst) text = safeStr(area.check_fail_cn);
      else {
        let raceOk = true;
        if (area.open_race) { const rk = String(area.open_race); raceOk = rk === 'H_ALL' ? HALF_HUMAN.has(ch.ch_class) : ch.ch_class === RACE_TO_CLASS[rk]; }
        if (!raceOk) text = safeStr(area.race_fail_cn);
        else if (fDrop === 'N') itemEvent = true;
        else if (fDrop === 'Y') { if (personalFirst) { itemEvent = true; markGranted = true; } else if (area.drop_fail_cn) text = safeStr(area.drop_fail_cn); }
      }
    }
    // 태그 치환
    let diceResult = 0, tagContent = '';
    const st = text.indexOf('{'), en = text.indexOf('}');
    if (st >= 0 && en > st) {
      const full = text.slice(st, en + 1); tagContent = full.slice(1, -1).toUpperCase();
      const r = resolveTag(full.slice(1, -1));
      if (r.rep != null) { text = text.replace(full, r.rep); diceResult = r.dice; }
    }
    // 아이템 지급
    const notes = [];
    if (itemEvent && area.item_id != null && String(area.item_id).trim() !== '') {
      const ids = parseIdList(area.item_id);
      const cnt = calcDropCount(area.item_drop, tagContent, diceResult);
      ids.forEach(id => { awardItem(id, cnt); notes.push(`획득: ${itemName(id)} ×${cnt}`); });
    }
    text = text.split('{name}').join(ch.ch_name).split('{NAME}').join(ch.ch_name);
    return { text, notes };
  }

  // ---- 인카운터 핸들러 (각자 { msg, status } 반환; status = 이번 스텝 결과: ING/SUCC/FAIL) ----
  function handlePass(area) { return { msg: join(extractCn(area, '')), status: 'ING' }; }
  function handleTradeIG(area) {
    const ids = parseIdList(area.deal_item_id); if (!ids.length || !consumeFirst(ids)) return { msg: '필요한 아이템을 다 가지고 있지 않은 것 같다. 다시 주머니를 확인해 보자.', status: 'ING' };
    const g = safeInt(area.gold_drop, 0); ch.gold += g; return { msg: join(extractCn(area, ''), [`골드 +${g} (보유 ${ch.gold})`]), status: 'ING' };
  }
  function handleTradeII(area) {
    const ids = parseIdList(area.deal_item_id); if (!ids.length || !consumeFirst(ids)) return { msg: '필요한 아이템을 다 가지고 있지 않은 것 같다. 다시 주머니를 확인해 보자.', status: 'ING' };
    const newIds = parseIdList(area.item_id); const notes = [];
    if (newIds.length) { const cnt = rollDiceExpr(area.item_drop, 1); awardItem(newIds[0], cnt); notes.push(`획득: ${itemName(newIds[0])} ×${cnt}`); }
    const a2 = Object.assign({}, area, { item_id: null }); return { msg: join(extractCn(a2, ''), notes), status: 'ING' };
  }
  function handleTradeGI(area) {
    const g = safeInt(area.deal_gold, 0); if (ch.gold < g) return { msg: '상인이 흥정은 어렵다며 내쫓았다……. 충분한 골드를 챙긴 다음 다시 오자.', status: 'ING' };
    ch.gold -= g; const notes = [`골드 -${g} (보유 ${ch.gold})`]; const newIds = parseIdList(area.item_id);
    if (newIds.length) { const cnt = safeInt(area.item_drop, 1); awardItem(newIds[0], cnt); notes.push(`획득: ${itemName(newIds[0])} ×${cnt}`); }
    const a2 = Object.assign({}, area, { item_id: null }); return { msg: join(extractCn(a2, ''), notes), status: 'ING' };
  }
  function requiredStats(inc) { const s = safeStr(inc).toUpperCase(), r = []; if (s.includes('STR')) r.push('힘'); if (s.includes('WIS')) r.push('지혜'); if (s.includes('DEX')) r.push('솜씨'); if (s.includes('ALL')) r.push('무관'); return r; }
  function handleSkill(area, action, potion, name) {
    const stats = requiredStats(area.incounter_cd);
    if (!STAT_KOR.includes(action)) {
      if (area.area_cn) return { msg: join(extractCn(area, '')), status: 'ING' };
      const req = stats[0] && stats[0] !== '무관' ? stats[0] : '원하는 스탯';
      return { msg: `이곳을 통과하려면 능력을 발휘해야 할 것 같다. [지역/${name}/${req}]을 입력해 도전해 보자.`, status: 'ING' };
    }
    if (!stats.includes('무관') && !stats.includes(action)) {
      if (!stats.length) return { msg: '이 행동은 통하지 않을 것 같다! 다른 방식으로 도전해 보자.', status: 'ING' };
      return { msg: `이 행동은 통하지 않을 것 같다! 침착하게, 다른 방식으로 도전해 보자.\n 가령, ${stats[0]}을(를) 살린다면 어떨까?\n\n▶[지역/${name}/${stats[0]}]`, status: 'ING' };
    }
    if (potion) { const sv = safeInt(ch[STAT_COL[action]], 0); if (sv === 3) return { msg: '강화 포션을 사용할 필요는 없을 것 같다. 포션 없이 자신의 능력으로 도전해 보자.', status: 'ING' }; }
    const target = safeInt(area.target_roll, 0);
    const res = targetDice(ch[STAT_COL[action]], target, !!potion);
    let out = `(${res.stat}D6>=${res.target}) ＞ ${res.dice_result}\n`;
    if (res.good) {
      const r = extractCn(area, 'succ'); out += r.text; const notes = r.notes.slice();
      const ax = safeInt(area.area_exp, 0); if (ax > 0) { ch.exp += ax; notes.push(`경험치 +${ax}`); }
      return { msg: join({ text: out, notes }), status: 'ING' };
    } else {
      const r = extractCn(area, 'fail'); return { msg: join({ text: out + r.text, notes: r.notes.concat(['(실패 — ▶포기 하거나, 같은 명령을 다시 입력해 재도전)']) }), status: 'FAIL' };
    }
  }
  function handleComplete(area) {
    ch.exp += 10;
    const r = extractCn(area, '');
    const tail = `\n\n짧은 시간에 많은 경험이 쌓였다. 이제 교단으로 복귀하여 푹 쉬자.\n\n지역 임무를 하면서 10시간의 경험이 쌓였다.\n지금까지 ${ch.ch_name}이(가) 쌓은 경험은 ${ch.exp}시간 정도다.`;
    return { msg: join({ text: r.text + tail, notes: r.notes.concat(['✅ 탐사 완료']) }), status: 'SUCC' };
  }

  function join(r, extra) { const notes = (r.notes || []).concat(extra || []); return r.text + (notes.length ? '\n\n— ' + notes.join(' · ') : ''); }

  // ---- 선택지 추출: "표시된 스크립트(메시지)"의 ▶[지역/X]/▶[진입/X] 마커에서만 뽑는다.
  //   (예전엔 area_cn+성공+실패를 통째로 훑어, 성공 시 실패 스크립트의 선택지까지 나왔다.)
  function choicesFromText(text) {
    const out = []; const re = /▶\s*\[(?:지역|진입)\/([^\]]+)\]/g; let m;
    while ((m = re.exec(safeStr(text)))) { const n = m[1].trim(); if (n && !out.includes(n)) out.push(n); }
    return out;
  }

  // ---- 메인 진입점(area_mission 이식) ----
  //   미션이 있으면 "진행 중"(현재 루트 우선 이름 해석 + 스텝 디스패치), 없으면 "신규 시작".
  //   status는 sticky한 mission 상태가 아니라 매 스텝 핸들러가 돌려주는 값을 그대로 쓴다.
  function command(areaName, action, potion) {
    const norm = safeStr(areaName).replace(/\s/g, '');
    if (norm === '포기') { if (!mission) return { msg: '아직 지역 임무에 도전하지 않았던 것 같다. 임무를 수행하러 가볼까?' }; ch.exp += 5; mission = null; return { msg: `지역 임무를 포기하고 돌아가기로 했다.\n실패는 성공의 어머니다.\n\n지역 임무를 하면서 5시간의 경험이 쌓였다. (누적 ${ch.exp}시간)`, ended: true }; }
    if (safeInt(ch.max_hp, 0) - safeInt(ch.hp, 0) < 1) return { msg: '지금 몸 상태로 임무에 나가는 것은 무리다……. 우선 체력부터 회복하고 보자.' };

    // 지역 해석: 미션 중이면 현재 루트 안에서 → 전역, 없으면 새 미션(최상위 진입)
    let area, isNew = false;
    if (mission) {
      area = (A.byRootName[mission.root] || {})[norm] || A.byName[norm];
      if (!area) return { msg: `${areaName} (이)라는 곳을 찾을 수 없다……. 지도를 확인해 보자.` };
    } else {
      area = A.byName[norm];
      if (!area) return { msg: `${areaName} 임무를 수행할 수 있는 지역이 아닌 것 같다……. 지도를 확인해 보자.` };
      mission = { area_id: area.area_id, root: area._root }; isNew = true;
    }
    // 키아이템 게이트
    if (area.key_yn === 'Y') {
      const raw = safeStr(area.key_id); const ids = parseIdList(raw);
      if (ids.length) {
        const isOr = raw.includes('{'); const ok = isOr ? ids.some(hasItem) : ids.every(hasItem);
        if (!ok) { if (isNew) mission = null; return { msg: '필요한 키 아이템을 다 가지고 있지 않은 것 같다. 다시 주머니를 확인해 보자.', area, choices: [], status: 'ING' }; }
        if (isOr) consumeFirst(ids); else ids.forEach(id => { const i = ch.inventory.indexOf(id); if (i >= 0) ch.inventory.splice(i, 1); });
      }
    }
    mission.area_id = area.area_id; mission.root = area._root;   // 루트 동기화(트리 간 이동/완료 후 인접 이동 대응)
    const inc = safeStr(area.incounter_cd); let res;
    if (inc === 'INCUNTR_02' || inc.indexOf('INCUNTR_00') === 0) res = handlePass(area);
    else if (inc.includes('INCUNTR_04_IG')) res = handleTradeIG(area);
    else if (inc.includes('INCUNTR_04_II')) res = handleTradeII(area);
    else if (inc.includes('INCUNTR_04_GI')) res = handleTradeGI(area);
    else if (inc.includes('INCUNTR_03')) res = handleSkill(area, action, potion, area.area_name);
    else if (inc === 'INCUNTR_99') res = handleComplete(area);
    else res = handlePass(area);
    // 선택지는 실제로 표시된 메시지에서만 추출(성공→성공스크립트, 실패→실패스크립트, 완료→인접지역).
    let choices = choicesFromText(res.msg);
    if (res.status === 'FAIL') choices = ['포기'];   // 실패 후엔 ▶포기(경험치 소액) 또는 같은 명령 재입력
    return { msg: res.msg, area, choices, status: res.status };
  }

  return {
    character: ch,
    command,
    reset() { mission = null; ch.hp = ch.max_hp; ch.exp = 0; },
    startAreas() { return A.areas.filter(a => !a.parent_area_id).map(a => a.area_name); },
    get mission() { return mission; },
  };
}

// 채팅 입력 정규화: '종탑' / '나선계단/힘/포션' / '[진입/정문 홀]' / '▶[지역/X]' 모두 → {name,action,potion}
// (실제 봇은 진입 노드도 명령이 [지역/노드이름]. ▶[진입/…]는 스크립트 표시용 마커일 뿐이라 벗겨낸다.)
export function parseAreaInput(raw) {
  let s = String(raw == null ? '' : raw).trim().replace(/^▶\s*/, '');
  const m = s.match(/^\[\s*(?:지역|진입|동행)\s*\/\s*([\s\S]+?)\s*\]$/);
  if (m) s = m[1]; else s = s.replace(/^\[|\]$/g, '').trim();
  const parts = s.split('/').map(x => x.trim()).filter(Boolean);
  const potion = parts.slice(1).includes('포션');
  const action = parts[1] && parts[1] !== '포션' ? parts[1] : '';
  return { name: parts[0] || '', action, potion };
}

// ============================================================================
// 채팅 UI — 컨테이너에 캐릭터 설정 + 채팅 로그 + 입력/선택지 버튼을 그린다.
// ============================================================================
const el = (t, css, txt) => { const e = document.createElement(t); if (css) e.style.cssText = css; if (txt != null) e.textContent = txt; return e; };

export function openAreaTestUI(container, data, opts = {}) {
  container.innerHTML = '';
  let sim = null;
  const races = [['0', '인간'], ['3', '흡혈귀(VAM)'], ['6', '키클롭스(CYC)'], ['5', '가고일(GAG)'], ['4', '반시(BAN)']];

  // ---- 캐릭터 설정 바 ----
  const cfg = el('div', 'display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2,#f7f8fb);margin-bottom:10px;font-size:11.5px;');
  function field(label, node) { const w = el('label', 'display:flex;flex-direction:column;gap:3px;color:var(--text-dim,#666);'); w.appendChild(el('span', '', label)); w.appendChild(node); return w; }
  const inStyle = 'border:1px solid var(--border-strong,#ccc);border-radius:3px;padding:5px 7px;font-size:12px;width:70px;';
  const raceSel = el('select', inStyle.replace('70px', '110px')); races.forEach(r => { const o = el('option', '', r[1]); o.value = r[0]; raceSel.appendChild(o); });
  const nameIn = el('input', inStyle.replace('70px', '90px')); nameIn.value = '체험자';
  const strIn = el('input', inStyle); strIn.type = 'number'; strIn.value = '3';
  const diyIn = el('input', inStyle); diyIn.type = 'number'; diyIn.value = '3';
  const wisIn = el('input', inStyle); wisIn.type = 'number'; wisIn.value = '3';
  const goldIn = el('input', inStyle); goldIn.type = 'number'; goldIn.value = '1000';
  const invIn = el('input', inStyle.replace('70px', '140px')); invIn.placeholder = '아이템ID 쉼표';
  const firstCb = el('input'); firstCb.type = 'checkbox'; firstCb.checked = true;
  const firstWrap = el('label', 'display:flex;align-items:center;gap:4px;color:var(--text-dim,#666);'); firstWrap.appendChild(firstCb); firstWrap.appendChild(el('span', '', '최초 탐사자'));
  const startSel = el('select', inStyle.replace('70px', '150px'));
  cfg.appendChild(field('이름', nameIn)); cfg.appendChild(field('종족', raceSel));
  cfg.appendChild(field('힘', strIn)); cfg.appendChild(field('솜씨', diyIn)); cfg.appendChild(field('지혜', wisIn));
  cfg.appendChild(field('골드', goldIn)); cfg.appendChild(field('인벤토리', invIn)); cfg.appendChild(firstWrap);
  cfg.appendChild(field('시작 지역', startSel));
  const startBtn = el('button', 'padding:6px 14px;', '탐사 시작'); startBtn.className = 'primary';
  cfg.appendChild(startBtn);
  container.appendChild(cfg);

  // ---- 채팅 로그 ----
  const chatWrap = el('div', 'border:1px solid var(--border);border-radius:8px;height:46vh;overflow:auto;padding:12px;background:var(--bg,#f6f6f7);display:flex;flex-direction:column;gap:8px;');
  container.appendChild(chatWrap);
  const choicesBar = el('div', 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;');
  container.appendChild(choicesBar);

  // ---- 입력 ----
  const inputRow = el('div', 'display:flex;gap:6px;margin-top:8px;');
  const cmdIn = el('input', 'flex:1;border:1px solid var(--border-strong,#ccc);border-radius:4px;padding:8px 10px;font-size:13px;'); cmdIn.placeholder = '예: 종탑 · 나선계단/힘/포션 · [진입/정문 홀] 붙여넣기도 OK · 또는 아래 ▶선택지 클릭';
  const sendBtn = el('button', 'padding:8px 16px;', '입력'); sendBtn.className = 'primary';
  inputRow.appendChild(cmdIn); inputRow.appendChild(sendBtn); container.appendChild(inputRow);
  const hint = el('div', 'font-size:10.5px;color:var(--text-faint,#999);margin-top:6px;', '봇 명령: [지역/지역명] 으로 시작 → 스크립트의 ▶[지역/X] 선택지를 입력해 이동. 능력 판정(INCUNTR_03)은 [지역/X/힘|솜씨|지혜] 형식. 포션은 뒤에 /포션.');
  container.appendChild(hint);

  function bubble(text, who) {
    const b = el('div', `max-width:82%;white-space:pre-wrap;line-height:1.55;padding:9px 12px;border-radius:12px;font-size:13px;` +
      (who === 'user' ? 'align-self:flex-end;background:var(--accent,#3457d5);color:#fff;' : 'align-self:flex-start;background:var(--surface,#fff);border:1px solid var(--border,#e1e1e4);color:var(--text,#1c1c1f);'), text);
    chatWrap.appendChild(b); chatWrap.scrollTop = chatWrap.scrollHeight;
  }
  function renderChoices(list) {
    choicesBar.innerHTML = '';
    (list || []).forEach(name => { const c = el('button', 'font-size:12px;padding:5px 11px;border-radius:999px;', '▶ ' + name); c.className = 'ghost'; c.addEventListener('click', () => submit(name)); choicesBar.appendChild(c); });
  }
  function submit(raw) {
    if (!sim) { bubble('먼저 [탐사 시작]을 눌러주세요.', 'bot'); return; }
    const { name, action, potion } = parseAreaInput(raw);
    if (!name) return;
    bubble('[지역/' + name + (action ? '/' + action : '') + (potion ? '/포션' : '') + ']', 'user');
    const out = sim.command(name, action, potion);
    bubble(out.msg, 'bot');
    renderChoices(out.choices);
    if (out.ended) { renderChoices([]); bubble('— 탐사를 종료했습니다. [탐사 시작]으로 다시 체험할 수 있어요. —', 'bot'); }
    else if (out.status === 'SUCC') bubble('✅ 이 임무를 완료했습니다. 인접 지역(▶)으로 계속 가거나, 위에서 다른 지역으로 새로 시작할 수 있어요.', 'bot');
    else if (out.status === 'FAIL') bubble('❌ 탐사에 실패했습니다. ▶포기 하면 경험치를 조금 얻고 돌아갑니다.', 'bot');
    cmdIn.value = '';
  }

  function start() {
    const character = {
      ch_name: nameIn.value || '체험자', ch_class: parseInt(raceSel.value, 10) || 0,
      str: parseInt(strIn.value, 10) || 0, diy: parseInt(diyIn.value, 10) || 0, wis: parseInt(wisIn.value, 10) || 0,
      gold: parseInt(goldIn.value, 10) || 0, hp: 0, max_hp: 100, exp: 0,
      inventory: (invIn.value || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n)),
      personalFirst: firstCb.checked,
    };
    sim = createSim(data, { character, itemName: opts.itemName });
    chatWrap.innerHTML = ''; choicesBar.innerHTML = '';
    bubble(`[테스트 시작] ${character.ch_name} · 힘${character.str}/솜씨${character.diy}/지혜${character.wis}\n"${startSel.value}"(으)로 탐사를 시작합니다.`, 'bot');
    submit(startSel.value);
  }
  startBtn.addEventListener('click', start);
  sendBtn.addEventListener('click', () => cmdIn.value.trim() && submit(cmdIn.value.trim()));
  cmdIn.addEventListener('keydown', e => { if (e.key === 'Enter' && cmdIn.value.trim()) submit(cmdIn.value.trim()); });

  // 시작 지역 목록 채우기
  const tmp = createSim(data, {}); tmp.startAreas().sort().forEach(n => { const o = el('option', '', n); o.value = n; startSel.appendChild(o); });
}
