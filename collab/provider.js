// ============================================================================
// Supabase 기반 Yjs 프로바이더 (전송 + 영속 + 프레즌스)
// ----------------------------------------------------------------------------
// 별도 websocket 서버를 세우지 않고, 앱이 이미 쓰는 Supabase만으로 협업을 굴린다.
//   - 전송(live): Realtime "broadcast" 채널로 Yjs 바이너리 업데이트를 주고받음.
//                 CRDT 업데이트는 순서·중복에 강하므로 broadcast로 충분.
//   - 영속:       doc_updates(append 로그) + doc_snapshots(주기적 압축).
//   - 프레즌스:   y-protocols Awareness를 같은 채널로 방송(누가 어느 칸을 편집 중인지).
//
// broadcast 페이로드 한도(~256KB) 때문에 큰 업데이트는 청크로 쪼개 보낸다.
// 초기 대량 상태는 broadcast가 아니라 DB(load)에서 받으므로 실제 방송은 대개 작다.
// ============================================================================

import { Y, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from './deps.js';

// ---- base64 <-> Uint8Array (큰 배열도 안전하게) ----
export function u8ToB64(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  }
  return btoa(s);
}
export function b64ToU8(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

// ---- 서버 따라잡기 ----
// broadcast는 보장 전송이 아니다(소켓 끊김·백그라운드 탭·한도 초과 시 조용히 유실). 예전엔 연결 직후 한 번만
// DB를 읽고 이후엔 방송에만 의존해서, 방송 하나를 놓치면 그 뒤로 영영 최신을 못 받았다(화면·SQL 내보내기가 옛 내용).
// → 놓친 조각이 보이면 즉시, 그 밖엔 재연결·탭 복귀·주기적으로 doc_updates 로그를 따라잡는다.
const CATCHUP_OVERLAP = 50;      // id는 늦게 커밋된 행이 앞 번호일 수 있어, 커서 앞쪽도 이만큼 다시 확인
const DEFAULT_POLL_MS = 20000;   // 주기적 따라잡기(탭이 보일 때만). 0이면 끔

// 원격 업데이트가 내 문서에 아직 없는 조각(그 사람의 앞선 편집, 기대는 남의 항목)에 의존하면 true.
// 그대로 적용하면 Yjs가 "삭제"는 바로 반영하고 "삽입"은 보류해서, 시트 행의 칸이 한 칸씩 밀린 반쪽 상태가
// 화면·SQL 내보내기에 드러나고 그 행을 편집하면 엉뚱한 칸에 저장됐다. → 빠진 조각이 올 때까지 통째로 보류한다.
export function missingDependencies(ydoc, update) {
  let dec;
  try { dec = Y.decodeUpdate(update); } catch (e) { return false; }   // 해석 못 하면 Yjs 기본 동작에 맡김
  const known = Y.decodeStateVector(Y.encodeStateVector(ydoc));
  for (const s of dec.structs) {                                       // 1) 각 사람의 편집이 끊김 없이 이어지는가
    if (!(s instanceof Y.Item) && !(s instanceof Y.GC)) continue;      // Skip(의도된 빈칸)
    const have = known.get(s.id.client) || 0;
    if (s.id.clock > have) return true;
    known.set(s.id.client, Math.max(have, s.id.clock + s.length));
  }
  const has = (id) => !id || (known.get(id.client) || 0) > id.clock;
  for (const s of dec.structs) {                                       // 2) 기대는 항목(왼쪽/오른쪽/부모)이 있는가
    if (!(s instanceof Y.Item)) continue;
    if (!has(s.origin) || !has(s.rightOrigin)) return true;
    if (s.parent && typeof s.parent === 'object' && !has(s.parent)) return true;
  }
  return false;
}

// ---- broadcast 청크 분할/재조립 ----
const CHUNK_B64 = 180 * 1024; // base64 기준 상한(256KB 여유)
let _mid = 0;
export function splitForBroadcast(u8) {
  const b64 = u8ToB64(u8);
  if (b64.length <= CHUNK_B64) return [{ id: 0, i: 0, n: 1, d: b64 }];
  const id = ++_mid + '_' + Date.now();
  const n = Math.ceil(b64.length / CHUNK_B64);
  const out = [];
  for (let i = 0; i < n; i++) out.push({ id, i, n, d: b64.slice(i * CHUNK_B64, (i + 1) * CHUNK_B64) });
  return out;
}

export class SupabaseYjsProvider {
  constructor(supabase, projectId, ydoc, opts = {}) {
    this.supabase = supabase;
    this.projectId = projectId;
    this.ydoc = ydoc;
    this.awareness = opts.awareness || null;
    this.onStatus = opts.onStatus || (() => {});
    this.onFirstSync = opts.onFirstSync || (() => {}); // 원격/영속 상태를 처음 반영했을 때
    this.channel = null;
    this.synced = false;
    this._reasm = new Map();          // 청크 재조립 버퍼
    this._pending = [];               // 영속 대기 업데이트
    this._flushTimer = null;
    this._sinceSnapshot = 0;
    this._destroyed = false;
    this._lsKey = 'ydoc_local_' + projectId; // Yjs 상태 로컬 캐시(부팅 복구용). localStorage는 동기라 이탈 시에도 남는다.
    this._saveLocalTimer = null;
    this._recoveredDelta = null;
    this.loadFailed = false;   // DB 읽기 오류 여부(참이면 스냅샷/삭제 금지 — 실제 데이터 덮어쓰기 방지)
    this._retryMs = 0;         // flush 실패 시 지수 백오프
    // 서버 따라잡기 상태
    this._dbCursor = 0;        // DB에서 읽어 반영한 doc_updates 최대 id(내 insert로는 안 올린다 — 그사이 남의 행을 건너뛰지 않게)
    this._seenIds = new Set(); // 반영했거나 내가 기록한 doc_updates id(스냅샷 압축은 이 행들만 지운다)
    this._held = [];           // 앞선 조각이 없어 보류한 원격 업데이트
    this._catchUpPromise = null;
    this._catchUpTimer = null;
    this._catchUpFails = 0;
    this._lastSync1 = 0;
    this._subscribedOnce = false;
    this._pollMs = opts.pollMs == null ? DEFAULT_POLL_MS : opts.pollMs;
    this._pollTimer = null;

    this._onUpdate = this._onUpdate.bind(this);
    this._onAwareness = this._onAwareness.bind(this);
    this._onUnload = this._onUnload.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
    this._onOnline = this._onOnline.bind(this);
  }

  async connect() {
    // 1) 영속에서 현재 상태 로드(대량은 DB로)
    await this._loadFromDb();

    // 2) 로컬 업데이트 관찰 -> 방송 + 영속
    this.ydoc.on('update', this._onUpdate);
    if (this.awareness) this.awareness.on('update', this._onAwareness);
    window.addEventListener('visibilitychange', this._onVisibility);
    window.addEventListener('pagehide', this._onUnload);
    window.addEventListener('online', this._onOnline);

    // 3) 채널 구독
    this.channel = this.supabase.channel('ydoc:' + this.projectId, {
      config: { broadcast: { self: false } },
    });
    this.channel
      .on('broadcast', { event: 'y-update' }, (m) => this._recv(m.payload, false))
      .on('broadcast', { event: 'y-sync1' }, (m) => this._onSync1(m.payload))
      .on('broadcast', { event: 'y-sync2' }, (m) => this._recv(m.payload, true))
      .on('broadcast', { event: 'awareness' }, (m) => this._recvAwareness(m.payload));

    await new Promise((resolve) => {
      this.channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          this.onStatus('connected');
          // 4) 동기화 핸드셰이크: 내 state vector를 알리고 부족분을 받는다.
          this._send('y-sync1', { sv: u8ToB64(Y.encodeStateVector(this.ydoc)) });
          if (this.awareness) this._broadcastAwareness([this.awareness.clientID]);
          // 재연결(재가입)이면 끊긴 동안의 편집을 서버 로그에서 받는다. y-sync1은 지금 접속해 있는 사람만
          // 답하므로, 편집한 사람이 이미 나갔으면 그것만으로는 영영 못 받았다.
          if (this._subscribedOnce) this.catchUp();
          this._subscribedOnce = true;
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          this.onStatus('error');
        } else if (status === 'CLOSED') {
          this.onStatus('closed');
        }
      });
    });

    // 부팅 시 복구한 로컬 전용 편집을 공유+영속한다(다른 클라이언트/서버에도 반영).
    if (this._recoveredDelta) {
      this._sendUpdate('y-update', this._recoveredDelta);
      this._pending.push(this._recoveredDelta);
      if (!this._flushTimer) this._flushTimer = setTimeout(() => this._flush(), 400);
      this._recoveredDelta = null;
    }

    // 5) 주기적 따라잡기(탭이 보일 때만) — 놓친 방송의 마지막 안전망
    if (this._pollMs > 0) {
      this._pollTimer = setInterval(() => {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') this.catchUp();
      }, this._pollMs);
    }
  }

  // ---- 영속 로드: 스냅샷 + 이후 업데이트 로그 ----
  async _loadFromDb() {
    let afterId = 0;
    this.loadFailed = false;
    const snap = await this.supabase
      .from('doc_snapshots').select('snapshot,last_update_id')
      .eq('project_id', this.projectId).maybeSingle();
    // Supabase는 RLS/네트워크 오류를 throw가 아니라 {error}로 돌려준다 → 반드시 검사.
    if (snap.error) { this.loadFailed = true; console.warn('[collab] 스냅샷 로드 오류', snap.error); }
    else if (snap.data && snap.data.snapshot) {
      Y.applyUpdate(this.ydoc, b64ToU8(snap.data.snapshot), this);
      afterId = snap.data.last_update_id || 0;
    }
    // 스냅샷 기준보다 조금 앞부터 읽는다: 압축이 "반영한 행만" 지우므로, 늦게 커밋돼 남은 앞 번호 행도 받는다.
    const ups = await this.supabase
      .from('doc_updates').select('id,update')
      .eq('project_id', this.projectId).gt('id', Math.max(0, afterId - CATCHUP_OVERLAP)).order('id', { ascending: true });
    this._dbCursor = afterId;
    if (ups.error) { this.loadFailed = true; console.warn('[collab] 업데이트 로드 오류', ups.error); }
    else if (ups.data && ups.data.length) {
      this.ydoc.transact(() => {
        for (const r of ups.data) Y.applyUpdate(this.ydoc, b64ToU8(r.update), this);
      }, this);
      for (const r of ups.data) { this._seenIds.add(r.id); if (r.id > this._dbCursor) this._dbCursor = r.id; }
    }
    if (!this.loadFailed && (snap.data || (ups.data && ups.data.length))) this.synced = true;
    // ★ 로컬 캐시된 Yjs 상태를 덧입혀, Supabase에 flush 안 된 마지막 편집을 복구한다.
    //    CRDT라 이미 반영된 업데이트는 무시되고 로컬 전용 편집만 병합된다(원격 되돌림 없음).
    try {
      const local = localStorage.getItem(this._lsKey);
      if (local) {
        const sv0 = Y.encodeStateVector(this.ydoc);
        Y.applyUpdate(this.ydoc, b64ToU8(local), this);       // origin=this: 로드 중 재방송 방지
        const delta = Y.encodeStateAsUpdate(this.ydoc, sv0);  // 로컬 전용(미영속) 편집분
        if (delta && delta.length > 2) this._recoveredDelta = delta; // 있으면 connect 후 영속+공유
        this.synced = true;
      }
    } catch (e) { console.warn('[collab] 로컬 캐시 복구 실패', e); }
    // ★ 서버 읽기가 실패했고 로컬 캐시로도 문서를 채우지 못했다면(빈 문서), 시드가 실제(못 읽은)
    //    데이터를 덮어쓰지 못하도록 연결을 중단한다. 상위 startCollab이 localStorage 최신본으로 복구.
    if (this.loadFailed && this.ydoc.getMap('project').size === 0) {
      throw new Error('문서 로드 실패(서버 읽기 오류) — 로컬 저장본을 사용합니다.');
    }
    if (this.synced) this.onFirstSync();
  }

  // ---- 로컬 Y 변경 -> 방송 + 영속 큐 ----
  _onUpdate(update, origin) {
    if (origin === this) return;      // 원격/영속에서 적용한 것 -> 되쏘지 않음
    this._sendUpdate('y-update', update);
    this._pending.push(update);
    if (!this._flushTimer) this._flushTimer = setTimeout(() => this._flush(), 400);
    if (!this._saveLocalTimer) this._saveLocalTimer = setTimeout(() => this._saveLocal(), 1000);
  }

  // 현재 Yjs 전체 상태를 localStorage에 동기 저장. 페이지 이탈 시에도 확실히 남아 부팅 복구의 근거가 된다.
  _saveLocal() {
    this._saveLocalTimer = null;
    try { localStorage.setItem(this._lsKey, u8ToB64(Y.encodeStateAsUpdate(this.ydoc))); }
    catch (e) { /* 용량 초과 등은 무시(Supabase가 주 저장) */ }
  }

  // 큰 업데이트는 broadcast 256KB 한도 때문에 청크를 "각각 다른 메시지"로 보낸다.
  // (예전엔 청크 배열을 한 메시지에 다 담아, 대용량이면 broadcast가 통째로 실패해 실시간 전파가 끊겼다.)
  _sendUpdate(event, u8) {
    const chunks = splitForBroadcast(u8);
    for (const ch of chunks) this._send(event, { c: ch });
  }

  // ---- 수신: 여러 메시지로 온 청크를 id별로 모아 재조립 ----
  _recv(payload, isSync) {
    const ch = payload && payload.c;
    if (!ch || ch.d == null) return;
    let full;
    if (!ch.n || ch.n === 1) {
      full = b64ToU8(ch.d);
    } else {
      let buf = this._reasm.get(ch.id);
      if (!buf) { buf = { n: ch.n, parts: [], count: 0 }; this._reasm.set(ch.id, buf); }
      if (buf.parts[ch.i] === undefined) { buf.parts[ch.i] = ch.d; buf.count++; }
      if (buf.count < buf.n) return;                 // 아직 다 안 옴
      this._reasm.delete(ch.id);
      full = b64ToU8(buf.parts.join(''));
    }
    this._applyRemote(full);
    if (isSync && !this.synced) { this.synced = true; this.onFirstSync(); }
  }

  // 원격 업데이트 적용. 빠진 앞 조각이 있으면 보류하고 채우러 간다(반쪽 상태를 문서에 넣지 않는다).
  _applyRemote(u8) {
    if (missingDependencies(this.ydoc, u8)) {
      this._held.push(u8);
      this._requestMissing();
      return;
    }
    Y.applyUpdate(this.ydoc, u8, this);
    this._retryHeld();
  }

  // 보류해 둔 업데이트 중 이제 적용 가능한 것을 차례로 적용(서로 기대는 순서가 있어 진전이 없을 때까지 반복)
  _retryHeld() {
    let progress = true;
    while (progress && this._held.length) {
      progress = false;
      for (let i = 0; i < this._held.length; i++) {
        if (missingDependencies(this.ydoc, this._held[i])) continue;
        const u = this._held.splice(i, 1)[0];
        Y.applyUpdate(this.ydoc, u, this);
        progress = true;
        break;
      }
    }
  }

  // 빠진 조각 요청: 접속 중인 사람에게 y-sync1(바로 응답)을 보내고, 응답이 없으면 서버 로그에서 가져온다.
  _requestMissing() {
    const now = Date.now();
    if (now - this._lastSync1 > 2000) {
      this._lastSync1 = now;
      this._send('y-sync1', { sv: u8ToB64(Y.encodeStateVector(this.ydoc)) });
    }
    this._scheduleCatchUp(1200);   // 보낸 사람의 서버 저장(0.4초 디바운스)이 끝날 시간을 둔다
  }

  _scheduleCatchUp(ms) {
    if (this._catchUpTimer || this._destroyed) return;
    this._catchUpTimer = setTimeout(() => { this._catchUpTimer = null; this.catchUp(); }, ms);
  }

  // ---- 서버 로그 따라잡기. 끝났을 때 문서가 빠진 조각 없이 서버 최신을 담고 있으면 true ----
  catchUp() {
    if (this._destroyed) return Promise.resolve(false);
    if (!this._catchUpPromise) {
      this._catchUpPromise = this._doCatchUp()
        .catch((e) => { console.warn('[collab] 서버 따라잡기 실패', e); return false; })
        .then((ok) => {
          this._catchUpPromise = null;
          if (ok) this._catchUpFails = 0;
          else if (!this._destroyed) {            // 아직 빠진 조각 → 점점 간격을 늘려 재시도
            this._catchUpFails++;
            this._scheduleCatchUp(Math.min(30000, 1000 * Math.pow(2, this._catchUpFails)));
          }
          return ok;
        });
    }
    return this._catchUpPromise;
  }

  async _doCatchUp() {
    const pid = this.projectId;
    // 1) 내가 못 본 사이 압축으로 로그가 지워졌을 수 있다 → 더 새 스냅샷이면 그것부터(CRDT라 중복 적용 무해)
    const meta = await this.supabase.from('doc_snapshots').select('last_update_id').eq('project_id', pid).maybeSingle();
    if (meta.error) throw meta.error;
    const snapLast = (meta.data && meta.data.last_update_id) || 0;
    if (snapLast > this._dbCursor) {
      const snap = await this.supabase.from('doc_snapshots').select('snapshot,last_update_id').eq('project_id', pid).maybeSingle();
      if (snap.error) throw snap.error;
      if (snap.data && snap.data.snapshot) {
        this.ydoc.transact(() => { Y.applyUpdate(this.ydoc, b64ToU8(snap.data.snapshot), this); }, this);
        this._dbCursor = Math.max(this._dbCursor, snap.data.last_update_id || 0);
      }
    }
    // 2) 커서 이후(겹침 창 포함) 행 중 아직 반영 안 한 것만 내용을 받아 적용
    const from = Math.max(0, this._dbCursor - CATCHUP_OVERLAP);
    const idsRes = await this.supabase.from('doc_updates').select('id')
      .eq('project_id', pid).gt('id', from).order('id', { ascending: true });
    if (idsRes.error) throw idsRes.error;
    const ids = (idsRes.data || []).map((r) => r.id);
    const unseen = ids.filter((id) => !this._seenIds.has(id));
    if (unseen.length) {
      const rows = await this.supabase.from('doc_updates').select('id,update')
        .eq('project_id', pid).gt('id', unseen[0] - 1).lte('id', unseen[unseen.length - 1]).order('id', { ascending: true });
      if (rows.error) throw rows.error;
      const fresh = (rows.data || []).filter((r) => !this._seenIds.has(r.id));
      if (fresh.length) {
        // 한 트랜잭션으로: 행끼리 기대는 순서가 뒤바뀌어 있어도 끝에서 모두 맞물린 상태로 알림이 나간다
        this.ydoc.transact(() => { for (const r of fresh) Y.applyUpdate(this.ydoc, b64ToU8(r.update), this); }, this);
        for (const r of fresh) this._seenIds.add(r.id);
      }
    }
    for (const id of ids) if (this._seenIds.has(id) && id > this._dbCursor) this._dbCursor = id;
    this._retryHeld();
    if (this._seenIds.size > 5000) {               // 오래된 id는 커서 앞 겹침 창 밖이면 잊는다
      for (const id of this._seenIds) if (id < this._dbCursor - CATCHUP_OVERLAP * 2) this._seenIds.delete(id);
    }
    return !this._held.length && !this.ydoc.store.pendingStructs;
  }

  _onSync1(payload) {
    // 상대가 모르는 부분만 골라 응답(청크로 나눠 전송)
    const remoteSv = b64ToU8(payload.sv);
    const diff = Y.encodeStateAsUpdate(this.ydoc, remoteSv);
    if (diff && diff.length) this._sendUpdate('y-sync2', diff);
  }

  // ---- 영속 flush: 대기 업데이트를 하나로 합쳐 append ----
  async _flush() {
    this._flushTimer = null;
    if (!this._pending.length || this._destroyed) return;
    const merged = Y.mergeUpdates(this._pending.splice(0));
    // Supabase는 DB/RLS 오류를 throw가 아니라 {error}로 돌려준다. 예전엔 try/catch만 있어
    // insert가 {error}로 실패하면 이미 splice한 pending이 조용히 사라졌다(→ 데이터 유실).
    let ins;
    try {
      ins = await this.supabase
        .from('doc_updates').insert({ project_id: this.projectId, update: u8ToB64(merged) })
        .select('id').single();
    } catch (e) { ins = { error: e }; }
    if (ins && ins.error) {
      this._pending.unshift(merged);      // 되돌려 보존(유실 금지)
      this._saveLocal();                  // 로컬에도 즉시 확정(브라우저 이탈 대비)
      this.onStatus('save-error');
      console.warn('[collab] 서버 저장 실패 — 재시도합니다.', ins.error);
      this._retryMs = Math.min((this._retryMs || 2000) * 1.6, 30000); // 지수 백오프
      if (!this._flushTimer && !this._destroyed) this._flushTimer = setTimeout(() => this._flush(), this._retryMs);
      return;
    }
    this._retryMs = 0;
    // 내 행은 내용이 이미 내 문서에 있다(따라잡기 때 다시 받지 않음). 커서는 옮기지 않는다 — 그사이 들어온
    // 남의 행(더 작은 id)을 건너뛰게 되기 때문(예전 _lastLoadedId가 그래서 압축 때 남의 편집을 지웠다).
    if (ins && ins.data) this._seenIds.add(ins.data.id);
    this.onStatus('connected');           // 저장 성공 → 상태 회복(직전 save-error 해제)
    if (++this._sinceSnapshot >= 150) this._snapshot();
  }

  // ---- 압축: 전체 상태 스냅샷 + 오래된 로그 정리 ----
  async _snapshot() {
    this._sinceSnapshot = 0;
    if (this.loadFailed) return;   // 서버 상태가 불확실하면 스냅샷/삭제 금지(실제 스냅샷 덮어쓰기 방지)
    // ★ 압축 전에 서버 로그를 끝까지 따라잡는다. 방송을 놓친 클라이언트가 자기 상태로 스냅샷을 쓰고 로그를
    //   지우면, 놓친 남의 편집이 서버에서 영영 사라졌다. 빠진 조각이 남아 있으면 압축하지 않는다.
    if (!(await this.catchUp()) || this._destroyed) return;
    const pid = this.projectId;
    const lastId = this._dbCursor;
    if (!lastId) return;
    const snapshot = u8ToB64(Y.encodeStateAsUpdate(this.ydoc));
    // 더 새 스냅샷을 옛 상태로 덮지 않게: 기존 기준(last_update_id)이 내 것보다 작을 때만 갱신, 없으면 새로 넣는다.
    let wrote = false;
    try {
      const upd = await this.supabase.from('doc_snapshots').update({ snapshot, last_update_id: lastId })
        .eq('project_id', pid).lt('last_update_id', lastId).select('project_id');
      if (upd.error) throw upd.error;
      if (upd.data && upd.data.length) wrote = true;
      else {
        const ins = await this.supabase.from('doc_snapshots').insert({ project_id: pid, snapshot, last_update_id: lastId });
        if (!ins.error) wrote = true;    // 같거나 더 새 스냅샷이 이미 있으면 충돌 → 쓰지 않음
      }
    } catch (e) { console.warn('[collab] 스냅샷 저장 실패 — 업데이트 로그 유지', e); return; }
    // ★ 스냅샷을 못 썼으면 doc_updates를 절대 지우지 않는다(스냅샷 없이 로그가 사라지면 유실).
    if (!wrote) return;
    // 지우는 건 "스냅샷에 확실히 들어간(내가 반영한) 행"까지만 — 못 본 행(늦게 커밋됨)이 끼어 있으면 그 앞까지.
    try {
      const present = await this.supabase.from('doc_updates').select('id')
        .eq('project_id', pid).lte('id', lastId).order('id', { ascending: true });
      if (present.error) return;
      let upto = lastId;
      for (const r of present.data || []) if (!this._seenIds.has(r.id)) { upto = r.id - 1; break; }
      if (upto > 0) await this.supabase.from('doc_updates').delete().eq('project_id', pid).lte('id', upto);
    } catch (e) { /* 로그 정리는 다음 스냅샷 때 다시 시도 */ }
  }

  // ---- 프레즌스(awareness) ----
  _onAwareness({ added, updated, removed }, origin) {
    if (origin === this) return;
    this._broadcastAwareness(added.concat(updated, removed));
  }
  _broadcastAwareness(clients) {
    if (!this.awareness) return;
    const u = encodeAwarenessUpdate(this.awareness, clients);
    this._send('awareness', { u: u8ToB64(u) });
  }
  _recvAwareness(payload) {
    if (!this.awareness) return;
    applyAwarenessUpdate(this.awareness, b64ToU8(payload.u), this);
  }

  _send(event, payload) {
    if (!this.channel) return;
    this.channel.send({ type: 'broadcast', event, payload });
  }

  _onUnload() {
    this._saveLocal();                                        // 항상 로컬에 동기 확정(이탈 시 유실 방지)
    if (document.visibilityState === 'hidden') this._flush(); // Supabase는 best-effort
  }
  // 탭을 숨기면 확정 저장, 다시 보이면 숨어 있던 동안(백그라운드 탭은 소켓이 끊기기 쉽다)의 편집을 따라잡는다.
  _onVisibility() {
    if (document.visibilityState === 'hidden') this._onUnload();
    else this.catchUp();
  }
  _onOnline() { this.catchUp(); }

  async destroy() {
    clearTimeout(this._saveLocalTimer); this._saveLocal();
    // 마지막 편집을 서버에 확정한 "뒤에" 종료 표시. 예전엔 _destroyed를 먼저 세워 _flush가 바로 return —
    // 프로젝트 전환·로그아웃 직전(0.4초 안)의 편집이 서버에 안 올라가고 이 브라우저 캐시에만 남았다.
    clearTimeout(this._flushTimer); this._flushTimer = null;
    try { await this._flush(); } catch (e) {}
    this._destroyed = true;
    clearTimeout(this._flushTimer); this._flushTimer = null;   // 실패 시 걸린 재시도 취소(캐시엔 이미 저장됨)
    clearTimeout(this._catchUpTimer); this._catchUpTimer = null;
    clearInterval(this._pollTimer); this._pollTimer = null;
    if (this.awareness) {
      try { removeAwarenessStates(this.awareness, [this.awareness.clientID], 'local'); } catch (e) {}
      this.awareness.off('update', this._onAwareness);
    }
    this.ydoc.off('update', this._onUpdate);
    window.removeEventListener('visibilitychange', this._onVisibility);
    window.removeEventListener('pagehide', this._onUnload);
    window.removeEventListener('online', this._onOnline);
    if (this.channel) { try { await this.supabase.removeChannel(this.channel); } catch (e) {} this.channel = null; }
  }
}
