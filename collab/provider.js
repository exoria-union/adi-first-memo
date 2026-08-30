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

    this._onUpdate = this._onUpdate.bind(this);
    this._onAwareness = this._onAwareness.bind(this);
    this._onUnload = this._onUnload.bind(this);
  }

  async connect() {
    // 1) 영속에서 현재 상태 로드(대량은 DB로)
    await this._loadFromDb();

    // 2) 로컬 업데이트 관찰 -> 방송 + 영속
    this.ydoc.on('update', this._onUpdate);
    if (this.awareness) this.awareness.on('update', this._onAwareness);
    window.addEventListener('visibilitychange', this._onUnload);
    window.addEventListener('pagehide', this._onUnload);

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
    const ups = await this.supabase
      .from('doc_updates').select('id,update')
      .eq('project_id', this.projectId).gt('id', afterId).order('id', { ascending: true });
    if (ups.error) { this.loadFailed = true; console.warn('[collab] 업데이트 로드 오류', ups.error); }
    else if (ups.data && ups.data.length) {
      this.ydoc.transact(() => {
        for (const r of ups.data) Y.applyUpdate(this.ydoc, b64ToU8(r.update), this);
      }, this);
      this._lastLoadedId = ups.data[ups.data.length - 1].id;
    } else {
      this._lastLoadedId = afterId;
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
    Y.applyUpdate(this.ydoc, full, this);
    if (isSync && !this.synced) { this.synced = true; this.onFirstSync(); }
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
    if (ins && ins.data) this._lastLoadedId = ins.data.id;
    this.onStatus('connected');           // 저장 성공 → 상태 회복(직전 save-error 해제)
    if (++this._sinceSnapshot >= 150) this._snapshot();
  }

  // ---- 압축: 전체 상태 스냅샷 + 오래된 로그 정리 ----
  async _snapshot() {
    this._sinceSnapshot = 0;
    if (this.loadFailed) return;   // 서버 상태가 불확실하면 스냅샷/삭제 금지(실제 스냅샷 덮어쓰기 방지)
    const lastId = this._lastLoadedId || 0;
    let up;
    try {
      up = await this.supabase.from('doc_snapshots').upsert({
        project_id: this.projectId,
        snapshot: u8ToB64(Y.encodeStateAsUpdate(this.ydoc)),
        last_update_id: lastId,
      });
    } catch (e) { up = { error: e }; }
    // ★ 스냅샷 upsert가 실패했으면 doc_updates를 절대 지우지 않는다.
    //   (예전엔 upsert가 {error}로 실패해도 delete가 실행돼, 스냅샷 없이 로그가 사라질 수 있었다.)
    if (up && up.error) { console.warn('[collab] 스냅샷 저장 실패 — 업데이트 로그 유지', up.error); return; }
    try {
      await this.supabase.from('doc_updates')
        .delete().eq('project_id', this.projectId).lte('id', lastId);
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

  async destroy() {
    this._destroyed = true;
    clearTimeout(this._saveLocalTimer); this._saveLocal();
    await this._flush();
    if (this.awareness) {
      try { removeAwarenessStates(this.awareness, [this.awareness.clientID], 'local'); } catch (e) {}
      this.awareness.off('update', this._onAwareness);
    }
    this.ydoc.off('update', this._onUpdate);
    window.removeEventListener('visibilitychange', this._onUnload);
    window.removeEventListener('pagehide', this._onUnload);
    if (this.channel) { try { await this.supabase.removeChannel(this.channel); } catch (e) {} this.channel = null; }
  }
}
