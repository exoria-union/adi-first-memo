// ============================================================================
// 편집기 시트 → 자동봇(bot_area)이 실제로 읽는 모양으로 바꾸는 규칙.
// SQL 내보내기(index.html)와 테스트 모드(area-sim.js)가 함께 쓰는 단일 원본 — 규칙은 여기서만 고칠 것.
// 편집기 데이터는 바꾸지 않고, 내보낼/시뮬레이션할 때만 적용한다.
//
// 왜 필요한가(2026-10-03):
//  - 봇은 [지역/이름/스탯]에서 첫 '/' 앞만 지역명으로 찾는다(공백 무시). 편집기는 선택지와 노드를
//    "이름 완전 일치"로 잇기 때문에, 선택지에 스탯을 보이려고 노드 이름을 "정산 작업/지혜"처럼 쓰면
//    편집기에선 연결되지만 봇은 "정산 작업"을 못 찾았다. → 다이스 노드 이름 끝의 /힘·/솜씨·/지혜는 뗀다.
//  - 다이스 노드로 가는 선택지에는 종류 코드(_STR/_DEX/_WIS, ALL은 셋 다)에 맞는 스탯을 자동으로 붙인다.
//    선택지에 이미 허용된 스탯이 있으면 그대로, 코드와 다르면 코드 기준으로 바꾸고 경고한다.
//  - 편집기 선택지 입력은 항상 ▶[지역/…]로 쓰므로 "재도전"을 고르면 ▶[지역/재도전]이 된다. 봇의 재도전
//    명령은 [재도전/지역]이라 그대로면 "재도전"이라는 지역을 찾다 실패했다. → ▶[재도전/지역]으로 바꾼다.
// ============================================================================
(function (root) {
  'use strict';
  // 봇 _required_stats_from_code와 같은 판정(부분 문자열). ALL(무관)은 아무 스탯이나 통과 → 셋 다 제시.
  var STAT_BY_CODE = [['STR', '힘'], ['WIS', '지혜'], ['DEX', '솜씨']];
  var ALL_STATS = ['힘', '솜씨', '지혜'];
  var SUFFIX_RE = /\s*\/\s*(힘|솜씨|지혜)\s*$/;
  var RETRY_CHOICE = '▶[재도전/지역]';
  var CHOICE_RE = /▶\[지역\/([^\]\n]+)\]([ \t]*:[A-Za-z0-9_]+:)?/g;

  function str(v) { return v == null ? '' : String(v); }
  function diceStats(code) {
    var s = str(code).toUpperCase();
    if (s.indexOf('INCUNTR_03') === -1) return [];
    var out = [];
    STAT_BY_CODE.forEach(function (p) { if (s.indexOf(p[0]) !== -1) out.push(p[1]); });
    if (s.indexOf('ALL') !== -1) ALL_STATS.forEach(function (x) { if (out.indexOf(x) === -1) out.push(x); });
    return out;
  }
  function nameKey(s) { return str(s).replace(/\s/g, ''); }   // 봇은 공백을 무시하고 지역명을 비교한다

  // rows/headers(편집기 sheet1) → 변환기
  function create(rows, headers) {
    var ix = {}; (headers || []).forEach(function (h, i) { ix[h] = i; });
    function col(r, h) { var i = ix[h]; return i == null ? null : r[i]; }
    var nodes = [], byId = {}, byRow = new Map();
    (rows || []).forEach(function (r) {
      var id = str(col(r, '지역ID')).trim(); if (!id) return;
      var name = str(col(r, '지역명')), code = str(col(r, '종류 코드'));
      var stats = diceStats(code), m = stats.length ? SUFFIX_RE.exec(name) : null;
      var n = { id: id, parent: str(col(r, '상위지역ID(부모ID)')).trim(), name: name, code: code, stats: stats,
                botName: m ? name.replace(SUFFIX_RE, '') : name, nameStat: m ? m[1] : '' };
      nodes.push(n); if (!byId[id]) byId[id] = n; byRow.set(r, n);
    });
    nodes.forEach(function (n) {           // 최상위 조상(지역 블록) — 같은 블록 안의 노드를 먼저 고른다
      var cur = n, g = 0;
      while (cur.parent && byId[cur.parent] && g++ < 100) cur = byId[cur.parent];
      n.top = cur.id;
    });
    var byExact = {}, byKey = {};
    nodes.forEach(function (n) {
      (byExact[n.name] = byExact[n.name] || []).push(n);
      var k = nameKey(n.botName); (byKey[k] = byKey[k] || []).push(n);
    });
    function pick(list, top) {
      if (!list || !list.length) return null;
      for (var i = 0; i < list.length; i++) if (list[i].top === top) return list[i];
      return list[0];
    }
    // 선택지 대상 이름 → 노드. 완전 일치(편집기 연결) → 공백 무시(봇) → 끝 스탯 뗀 이름 순.
    function resolve(target, top) {
      return pick(byExact[target], top) || pick(byKey[nameKey(target)], top) ||
        (SUFFIX_RE.test(target) ? pick(byKey[nameKey(target.replace(SUFFIX_RE, ''))], top) : null);
    }

    var counts = { names: 0, choices: 0, retry: 0 }, warnings = [], warned = {};
    function warn(key, msg) { if (warned[key]) return; warned[key] = true; warnings.push(msg); }
    nodes.forEach(function (n) {
      if (n.botName !== n.name) counts.names++;
      if (n.nameStat && n.stats.indexOf(n.nameStat) === -1)
        warn('ns:' + n.id, '[' + n.id + '] ' + n.name + ': 이름의 스탯(' + n.nameStat + ')이 종류 코드(' + n.code + ' → ' + n.stats.join('·') + ')와 달라요 — 선택지는 종류 코드 기준(' + n.stats.join('·') + ')으로 내보내요');
    });
    // 이름 꼬리표를 떼서 같은 블록의 다른 노드와 이름이 겹치면 봇이 엉뚱한 노드를 찾을 수 있다
    nodes.forEach(function (n) {
      if (n.botName === n.name) return;
      (byKey[nameKey(n.botName)] || []).forEach(function (o) {
        if (o !== n && o.top === n.top) warn('dup:' + n.id + ':' + o.id, '[' + n.id + '] ' + n.name + ': 스탯을 뗀 이름 "' + n.botName + '"이 같은 지역의 [' + o.id + '] ' + o.name + '와 겹쳐요');
      });
    });

    // 스크립트 안의 선택지를 봇 모양으로. fromRow = 이 스크립트가 들어 있는 행(같은 블록 우선 해석용).
    function script(text, fromRow) {
      if (text == null || text === '') return text;
      var from = fromRow ? byRow.get(fromRow) : null, top = from ? from.top : '';
      return str(text).replace(CHOICE_RE, function (full, target, cmd) {
        cmd = cmd || '';
        if (target.trim() === '재도전') { counts.retry++; return RETRY_CHOICE + cmd; }
        var n = resolve(target, top);
        if (!n || !n.stats.length) return full;
        var m = n.name === target ? null : SUFFIX_RE.exec(target);   // 선택지에 직접 쓴 스탯(이름 꼬리표 제외)
        var want = m ? m[1] : '';
        var use = want && n.stats.indexOf(want) !== -1 ? [want] : n.stats;
        if (want && use[0] !== want && from)
          warn('cs:' + from.id + ':' + target, '[' + from.id + '] 선택지 ▶[지역/' + target + ']: ' + want + '은(는) [' + n.id + '] 종류 코드(' + n.code + ')와 달라 ' + use.join('·') + '(으)로 내보내요');
        var out = use.map(function (st) { return '▶[지역/' + n.botName + '/' + st + ']' + cmd; }).join('\n');
        if (out !== full) counts.choices++;
        return out;
      });
    }
    function areaName(row) { var n = byRow.get(row); return n ? n.botName : str(col(row, '지역명')); }
    return { areaName: areaName, script: script, counts: counts, warnings: warnings };
  }

  root.BotShape = { create: create, diceStats: diceStats, RETRY_CHOICE: RETRY_CHOICE };
})(typeof window !== 'undefined' ? window : globalThis);
