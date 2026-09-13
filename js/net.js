// ===========================================================================
// net.js — WebRTC peer-to-peer transport over PeerJS (star topology).
//
//   * The HOST creates a Peer whose ID is derived from the room code
//     (codenames-<CODE>), holds all authoritative state, validates every
//     action through rules.js, and broadcasts a tailored view to each peer.
//   * Each CLIENT connects only to the host. It auto-reconnects with backoff,
//     always re-presenting its persistent token so the host can restore its
//     seat (team, role, private Spymaster view) with no re-picking.
//
// The signaling broker (PEER_BROKER) is only needed to set up the WebRTC
// handshake; once peers are connected, traffic is direct P2P over the LAN.
// See config.js for how to self-host a PeerServer for fully-offline play.
// ===========================================================================

import {
  PEER_BROKER, ROOM_ID_PREFIX, RECONNECT, ROOM_CODE_CHARSET, ROOM_CODE_LENGTH,
} from './config.js';
import * as Rules from './rules.js';
import * as Store from './storage.js';

const peerIdForRoom = (code) => ROOM_ID_PREFIX + code;

// Short, human-friendly room code (ambiguous glyphs already stripped in config).
export function randomRoomCode() {
  let out = '';
  const n = ROOM_CODE_CHARSET.length;
  const buf = new Uint32Array(ROOM_CODE_LENGTH);
  (crypto.getRandomValues ? crypto : { getRandomValues: (a) => a.forEach((_, i) => { a[i] = Math.floor(Math.random() * 0xffffffff); }) })
    .getRandomValues(buf);
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) out += ROOM_CODE_CHARSET[buf[i] % n];
  return out;
}

// Message types on the wire.
const T = {
  HELLO: 'hello',
  WELCOME: 'welcome',
  STATE: 'state',
  ERR: 'err',
  PING: 'ping',
  PONG: 'pong',
  SET_TEAM: 'setTeam',
  SET_ROLE: 'setRole',
  CLUE: 'clue',
  GUESS: 'guess',
  END_TURN: 'endTurn',
  START: 'start',
  AGAIN: 'again',
  NEW_GAME: 'newgame',
  // host-issued lobby control aimed at a specific seat (host moving a player)
  ADMIN_SET_TEAM: 'adminSetTeam',
  ADMIN_SET_ROLE: 'adminSetRole',
  SET_TIMER: 'setTimer',
  START_CLOCK: 'startClock',
};

// =========================================================================
// HOST
// =========================================================================
export class HostNet {
  // opts: { roomCode, resume, hostName, hostToken,
  //         onLocalView, onError, onStatus, onPlayerChange }
  constructor(opts) {
    this.opts = opts;
    this.roomCode = opts.roomCode;
    this.resume = !!opts.resume;
    this.peer = null;
    this.destroyed = false;

    // token -> live DataConnection
    this.conns = new Map();
    // connection.peer (id) -> token  (reverse lookup for close handling)
    this.connPeerToToken = new Map();
    // token -> grace timer id
    this.graceTimers = new Map();
    // token -> Date.now() of the last thing we heard on that connection.
    // A sleeping phone's data channel goes silent without ever firing 'close',
    // so silence is the only reliable signal that a player has dropped.
    this.lastRecvByToken = new Map();
    this.hbTimer = null;
    this.hbLastTick = 0;
    // The single authoritative turn-clock timeout. Only the host runs one.
    this.clockTimer = null;
    this.idRetry = 0;

    // Authoritative state: resume from snapshot, or start fresh.
    if (this.resume && opts.state) {
      this.state = opts.state;
      // Everyone is considered offline until they re-handshake.
      for (const s of Object.values(this.state.seats)) s.connected = false;
      // Snapshots written before the timer existed have no config.
      if (!this.state.timer) this.state.timer = Rules.defaultTimerConfig();
      this.hostToken = opts.hostToken;
    } else {
      this.hostToken = opts.hostToken || Store.uuid();
      this.state = Rules.createInitialState(this.roomCode, null);
      const seat = Rules.makeSeat(this.state, { token: this.hostToken, name: opts.hostName });
      this.state.hostSeatId = seat.seatId;
    }
    // The host is always "connected" to itself.
    if (this.state.seats[this.hostToken]) this.state.seats[this.hostToken].connected = true;
  }

  start() {
    // A resumed snapshot carries a deadline from a session that died with the
    // tab. Give the turn its full time back rather than resuming mid-tick.
    Rules.restartTurnClock(this.state);
    this._syncClock();
    this._startHeartbeat();
    this._createPeer();
  }

  _createPeer() {
    if (this.destroyed) return;
    this.opts.onStatus?.('connecting');
    const id = peerIdForRoom(this.roomCode);
    const peer = new Peer(id, PEER_BROKER);
    this.peer = peer;

    peer.on('open', () => {
      this.idRetry = 0;
      this.opts.onStatus?.('online');
      this._persist();
      this._emitLocal();
    });

    peer.on('connection', (conn) => this._wireIncoming(conn));

    peer.on('disconnected', () => {
      // Lost the broker link (not peers). Try to restore it.
      if (this.destroyed) return;
      this.opts.onStatus?.('reconnecting');
      try { peer.reconnect(); } catch { /* will be recreated on error */ }
    });

    peer.on('error', (err) => this._onPeerError(err));
  }

  _onPeerError(err) {
    if (this.destroyed) return;
    const type = err && err.type;
    if (type === 'unavailable-id') {
      try { this.peer.destroy(); } catch { /* ignore */ }
      if (this.resume) {
        // After a host reload the broker still thinks our old (dead) session
        // owns this ID. Retry the SAME id so reconnecting clients find us —
        // we never silently change the room code out from under them.
        this.idRetry++;
        const delay = Math.min(RECONNECT.maxDelayMs, RECONNECT.baseDelayMs * this.idRetry);
        this.opts.onStatus?.('reconnecting');
        setTimeout(() => this._createPeer(), delay);
      } else {
        // Fresh host: the random code collided with a live game. Pick a new
        // code and tell the UI so the displayed/sharable code stays in sync.
        const code = randomRoomCode();
        this.roomCode = code;
        this.state.roomCode = code;
        this.opts.onRoomCodeChange?.(code);
        setTimeout(() => this._createPeer(), 200);
      }
      return;
    }
    if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
      this.opts.onStatus?.('reconnecting');
      // PeerJS will emit 'disconnected'; reconnect handled there. As a
      // backstop, recreate after a delay if the peer is fully dead.
      setTimeout(() => {
        if (!this.destroyed && (!this.peer || this.peer.destroyed)) this._createPeer();
      }, RECONNECT.baseDelayMs);
      return;
    }
    if (type === 'browser-incompatible') {
      this.opts.onError?.('This browser does not support WebRTC.');
      return;
    }
    // peer-unavailable on the host side just means a transient client issue.
    this.opts.onError?.(friendlyPeerError(err));
  }

  _wireIncoming(conn) {
    conn.on('open', () => { /* wait for HELLO before trusting it */ });
    conn.on('data', (msg) => this._onData(conn, msg));
    conn.on('close', () => this._onConnClose(conn));
    conn.on('error', () => this._onConnClose(conn));
  }

  _onConnClose(conn) {
    const token = this.connPeerToToken.get(conn.peer);
    if (!token) return;
    // A superseded connection closing must never evict the seat's live one.
    // Still drop its reverse mapping, or reconnect churn leaks an entry per
    // attempt — and a sleeping phone can generate a lot of attempts.
    if (this.conns.get(token) !== conn) {
      this.connPeerToToken.delete(conn.peer);
      return;
    }
    this._dropConn(token, conn);
  }

  // Single exit path for a connection going away, whether PeerJS told us
  // ('close'/'error') or the heartbeat noticed it had gone quiet.
  _dropConn(token, conn) {
    this.conns.delete(token);
    this.lastRecvByToken.delete(token);
    this.connPeerToToken.delete(conn.peer);
    // Re-entrant: this may fire 'close', but the map entry is already gone,
    // so _onConnClose takes the superseded branch above and stops there.
    try { conn.close(); } catch { /* ignore */ }
    const seat = this.state.seats[token];
    if (seat) {
      seat.connected = false;
      seat.lastSeen = Date.now();
      // Keep the seat as "reconnecting" — never give the turn away on a
      // transient drop. A grace timer only flips the roster label later.
      this._startGrace(token);
    }
    this._persist();
    this._broadcast();
    this.opts.onPlayerChange?.();
  }

  _startGrace(token) {
    this._clearGrace(token);
    const id = setTimeout(() => {
      // Player still gone after the grace window — leave the seat in place
      // (so they can still reclaim by token) but it stays flagged offline.
      this.graceTimers.delete(token);
      this._broadcast();
      this.opts.onPlayerChange?.();
    }, RECONNECT.graceMs);
    this.graceTimers.set(token, id);
  }

  _clearGrace(token) {
    const id = this.graceTimers.get(token);
    if (id) { clearTimeout(id); this.graceTimers.delete(token); }
  }

  _onData(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    // Any traffic at all proves the channel is alive — including a PONG, which
    // is the only thing an idle client sends.
    const seen = this.connPeerToToken.get(conn.peer);
    if (seen) this.lastRecvByToken.set(seen, Date.now());
    switch (msg.t) {
      case T.HELLO: return this._onHello(conn, msg);
      case T.PING: return safeSend(conn, { t: T.PONG });
      case T.PONG: return; // keepalive ack
      default: return this._onAction(conn, msg);
    }
  }

  _onHello(conn, msg) {
    const spectator = !!msg.spectator;
    // Players must choose a name; a spectator (TV) may stay anonymous.
    const name = sanitizeName(msg.name) || (spectator ? 'TV' : '');
    if (!name) { safeSend(conn, { t: T.ERR, m: 'A name is required.' }); return; }

    let token = msg.token && this.state.seats[msg.token] ? msg.token : null;
    // Mode must match the seat: never let a spectator bind to a player's seat
    // (or vice-versa), or a TV could inherit a Spymaster's key entitlement.
    if (token && !!this.state.seats[token].spectator !== spectator) token = null;

    if (!token && !spectator) {
      // No valid token — try to recover a player's seat by name. Spectators are
      // anonymous, interchangeable, read-only seats and never reclaim by name.
      const byName = Object.values(this.state.seats).find(
        (s) => !s.spectator && s.name.toLowerCase() === name.toLowerCase() && s.token !== this.hostToken,
      );
      if (byName) {
        if (byName.connected) {
          safeSend(conn, { t: T.ERR, m: 'That name is already in use in this room.' });
          return;
        }
        token = byName.token; // reclaim the disconnected seat by name
      }
    }

    if (!token) {
      // Brand-new player/spectator → new seat (host issues the authoritative token).
      const seat = Rules.makeSeat(this.state, { token: msg.token || Store.uuid(), name, spectator });
      token = seat.token;
    } else {
      // Reclaiming: keep team/role/private entitlement; refresh name + status.
      const seat = this.state.seats[token];
      seat.name = name;
    }

    // Bind this connection to the token; drop any stale connection.
    const prev = this.conns.get(token);
    if (prev && prev !== conn) { try { prev.close(); } catch { /* ignore */ } }
    this.conns.set(token, conn);
    this.connPeerToToken.set(conn.peer, token);
    this.lastRecvByToken.set(token, Date.now());
    this._clearGrace(token);

    const seat = this.state.seats[token];
    seat.connected = true;
    seat.lastSeen = Date.now();

    // Tell the client its authoritative identity so it can persist the token.
    safeSend(conn, { t: T.WELCOME, token, seatId: seat.seatId, roomCode: this.roomCode });
    this._persist();
    this._broadcast();
    this.opts.onPlayerChange?.();
  }

  _onAction(conn, msg) {
    const token = this.connPeerToToken.get(conn.peer);
    if (!token) { safeSend(conn, { t: T.ERR, m: 'Re-join required.' }); return; }
    // Remote clients may never invoke host-only controls.
    if (msg.t === T.START || msg.t === T.AGAIN || msg.t === T.NEW_GAME
        || msg.t === T.ADMIN_SET_TEAM || msg.t === T.ADMIN_SET_ROLE
        || msg.t === T.SET_TIMER || msg.t === T.START_CLOCK) {
      safeSend(conn, { t: T.ERR, m: 'Only the host can do that.' });
      return;
    }
    const res = this._apply(token, msg);
    if (res && !res.ok) safeSend(conn, { t: T.ERR, m: res.error || 'Action rejected.' });
    else if (res && res.warning) safeSend(conn, { t: T.ERR, m: res.warning });
  }

  // Apply an action through rules.js, then persist + broadcast on success.
  _apply(token, msg) {
    let res = { ok: true };
    switch (msg.t) {
      case T.SET_TEAM: res = Rules.setTeam(this.state, token, msg.team); break;
      case T.SET_ROLE: res = Rules.setRole(this.state, token, msg.role); break;
      case T.CLUE: res = Rules.giveClue(this.state, token, { word: msg.word, count: msg.count }); break;
      case T.GUESS: res = Rules.guess(this.state, token, msg.index); break;
      case T.END_TURN: res = Rules.endTurn(this.state, token); break;
      case T.SET_TIMER: res = Rules.setTimerConfig(this.state, msg.patch); break;
      case T.START_CLOCK: res = Rules.startClock(this.state); break;
      default: return { ok: false, error: 'Unknown action.' };
    }
    if (res.ok) {
      this._persist();
      this._broadcast();
      this.opts.onPlayerChange?.();
    }
    return res;
  }

  // ---- host-local actions (the host is also a player / the admin) -------
  localSetTeam(team) { return this._apply(this.hostToken, { t: T.SET_TEAM, team }); }
  localSetRole(role) { return this._apply(this.hostToken, { t: T.SET_ROLE, role }); }
  localClue(word, count) { return this._apply(this.hostToken, { t: T.CLUE, word, count }); }
  localGuess(index) { return this._apply(this.hostToken, { t: T.GUESS, index }); }
  localEndTurn() { return this._apply(this.hostToken, { t: T.END_TURN }); }
  localSetTimer(patch) { return this._apply(this.hostToken, { t: T.SET_TIMER, patch }); }
  localStartClock() { return this._apply(this.hostToken, { t: T.START_CLOCK }); }

  // host-only admin moves (assign any seat from the lobby)
  adminSetTeam(seatId, team) {
    const token = this._tokenForSeat(seatId);
    if (!token) return { ok: false, error: 'No such player.' };
    return this._apply(token, { t: T.SET_TEAM, team });
  }
  adminSetRole(seatId, role) {
    const token = this._tokenForSeat(seatId);
    if (!token) return { ok: false, error: 'No such player.' };
    return this._apply(token, { t: T.SET_ROLE, role });
  }

  startGame() {
    const chk = Rules.canStart(this.state);
    if (!chk.ok) return { ok: false, error: chk.problems.join(' ') };
    Rules.dealGame(this.state);
    this._persist();
    this._broadcast();
    return { ok: true };
  }

  playAgain() { Rules.playAgain(this.state); this._persist(); this._broadcast(); return { ok: true }; }
  newGame() { Rules.newGame(this.state); this._persist(); this._broadcast(); return { ok: true }; }

  _tokenForSeat(seatId) {
    const seat = Object.values(this.state.seats).find((s) => s.seatId === seatId);
    return seat ? seat.token : null;
  }

  _broadcast() {
    if (this.destroyed) return;
    // Every mutation funnels through here, so this is the one place the turn
    // clock needs re-arming.
    this._syncClock();
    for (const [token, conn] of this.conns) {
      if (conn && conn.open) safeSend(conn, { t: T.STATE, view: Rules.viewFor(this.state, token) });
    }
    this._emitLocal();
  }

  // The host is the sole timekeeper: it alone performs the expiry transition,
  // then broadcasts, which is what moves every client's UI on.
  _syncClock() {
    clearTimeout(this.clockTimer);
    this.clockTimer = null;
    if (this.destroyed) return;
    const g = this.state.game;
    if (this.state.phase !== 'playing' || !g || g.deadlineAt == null) return;
    this.clockTimer = setTimeout(() => {
      this.clockTimer = null;
      if (this.destroyed || !Rules.timeExpired(this.state)) return;
      Rules.timeout(this.state);
      this._persist();
      this._broadcast();
      this.opts.onPlayerChange?.();
    }, Math.max(0, g.deadlineAt - Date.now()));
  }

  // -----------------------------------------------------------------------
  // Liveness
  //
  // WebRTC does not reliably fire 'close' when the peer's device goes to
  // sleep — the channel just stops carrying anything while still reporting
  // open. Without this the host would keep broadcasting into a dead channel
  // and show a departed player as present indefinitely.
  // -----------------------------------------------------------------------
  _startHeartbeat() {
    this._stopHeartbeat();
    this.hbLastTick = Date.now();
    this.hbTimer = setInterval(() => this._heartbeatTick(), RECONNECT.heartbeatMs);
  }

  _stopHeartbeat() {
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
  }

  _heartbeatTick() {
    if (this.destroyed) return;
    const now = Date.now();
    const gap = now - this.hbLastTick;
    this.hbLastTick = now;

    // The host itself was frozen or throttled (screen off, app backgrounded).
    // Every client looks stale on the wall clock, but that says nothing about
    // whether they're actually gone — so give them a fresh window to answer
    // instead of evicting the whole room on the first tick back.
    if (gap > RECONNECT.heartbeatMs * 2) {
      for (const token of this.conns.keys()) this.lastRecvByToken.set(token, now);
      this._pingAll();
      return;
    }

    // Collect first: _dropConn mutates this.conns.
    const dead = [];
    for (const [token, conn] of this.conns) {
      const last = this.lastRecvByToken.get(token) ?? now;
      if (now - last > RECONNECT.heartbeatMs * 2.5) dead.push([token, conn]);
    }
    for (const [token, conn] of dead) this._dropConn(token, conn);
    this._pingAll();
  }

  _pingAll() {
    for (const [, conn] of this.conns) safeSend(conn, { t: T.PING });
  }

  // Called when the tab becomes visible again (see main.js). A backgrounded
  // host comes back with a throttled turn clock, a possibly-dead broker link,
  // and connections of unknown health — settle all three at once.
  wake() {
    if (this.destroyed) return;

    // setTimeout was throttled while we were away, so the turn deadline may
    // already have passed. Re-arming recomputes it from the real clock.
    this._syncClock();

    if (!this.peer || this.peer.destroyed) { this._createPeer(); return; }
    if (this.peer.disconnected) {
      this.opts.onStatus?.('reconnecting');
      try { this.peer.reconnect(); } catch { this._createPeer(); }
    }

    const now = Date.now();
    this.hbLastTick = now;
    for (const token of this.conns.keys()) this.lastRecvByToken.set(token, now);
    this._pingAll();
  }

  _emitLocal() {
    this.opts.onLocalView?.(Rules.viewFor(this.state, this.hostToken));
  }

  _persist() {
    Store.setHostState(this.roomCode, this.state);
    Store.setLastHostRoom(this.roomCode);
    // The host also keeps a client-style seat record so a reload knows "me".
    Store.setSeat(this.roomCode, {
      token: this.hostToken,
      name: this.state.seats[this.hostToken]?.name,
      isHost: true,
    });
  }

  endGameForAll() {
    // Tell everyone the host is closing the room.
    for (const [, conn] of this.conns) {
      if (conn && conn.open) safeSend(conn, { t: T.ERR, m: 'Host closed the room.' });
    }
  }

  destroy() {
    this.destroyed = true;
    this._stopHeartbeat();
    clearTimeout(this.clockTimer);
    this.clockTimer = null;
    for (const id of this.graceTimers.values()) clearTimeout(id);
    this.graceTimers.clear();
    this.lastRecvByToken.clear();
    try { this.peer?.destroy(); } catch { /* ignore */ }
  }
}

// =========================================================================
// CLIENT
// =========================================================================
export class ClientNet {
  // opts: { roomCode, token, name, spectator,
  //         onView, onWelcome, onStatus, onError, onHostLeft }
  constructor(opts) {
    this.opts = opts;
    this.roomCode = opts.roomCode;
    this.token = opts.token || null;
    this.name = opts.name;
    // A spectator (TV) is a read-only seat. The host uses this to deny it a
    // team/role and — critically — to never include the key in its view.
    this.spectator = !!opts.spectator;

    this.peer = null;
    this.conn = null;
    this.destroyed = false;

    this.attempt = 0;
    this.reconnectTimer = null;
    this.watchdog = null;
    this.heartbeat = null;
    this.lastRecv = 0;
    // When the watchdog last ran. Compared against the interval to tell a dead
    // channel apart from a tab that was simply frozen — see _startHeartbeat.
    this.wdLastTick = 0;
    this.unavailableStreak = 0;
    this.connectedOnce = false;
  }

  start() {
    this._createPeer();
  }

  _createPeer() {
    if (this.destroyed) return;
    this._status('connecting');
    const peer = new Peer(undefined, PEER_BROKER);
    this.peer = peer;

    peer.on('open', () => { this.unavailableStreak = 0; this._connectToHost(); });

    peer.on('disconnected', () => {
      if (this.destroyed) return;
      this._status('reconnecting');
      try { peer.reconnect(); } catch { this._scheduleReconnect(); }
    });

    peer.on('error', (err) => this._onPeerError(err));
  }

  _onPeerError(err) {
    if (this.destroyed) return;
    const type = err && err.type;
    if (type === 'peer-unavailable') {
      this.unavailableStreak++;
      this._status('reconnecting');
      if (!this.connectedOnce) {
        // We never reached the host — most likely a wrong/expired code.
        // Give up quickly with a clear message instead of spinning forever.
        if (this.unavailableStreak >= 4) {
          this.opts.onUnreachable?.();
          return;
        }
      } else if (this.unavailableStreak >= 12) {
        // We were connected and the host has been gone a while → host left.
        this._status('hostgone');
        this.opts.onHostLeft?.();
      }
      this._scheduleReconnect();
      return;
    }
    if (type === 'browser-incompatible') {
      this.opts.onError?.('This browser does not support WebRTC.');
      return;
    }
    if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
      this._status('reconnecting');
      this._scheduleReconnect(true);
      return;
    }
    this.opts.onError?.(friendlyPeerError(err));
    this._scheduleReconnect();
  }

  _connectToHost() {
    if (this.destroyed || !this.peer || this.peer.disconnected) return;
    try {
      const conn = this.peer.connect(peerIdForRoom(this.roomCode), { reliable: true });
      this.conn = conn;
      conn.on('open', () => {
        this.attempt = 0;
        this.unavailableStreak = 0;
        this.connectedOnce = true;
        this._status('connected');
        this._sendHello();
        this._startHeartbeat();
      });
      conn.on('data', (msg) => this._onData(msg));
      conn.on('close', () => { this._status('reconnecting'); this._scheduleReconnect(); });
      conn.on('error', () => { this._status('reconnecting'); this._scheduleReconnect(); });
    } catch {
      this._scheduleReconnect();
    }
  }

  _sendHello() {
    this.send({ t: T.HELLO, token: this.token, name: this.name, room: this.roomCode, spectator: this.spectator });
  }

  _onData(msg) {
    this.lastRecv = Date.now();
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case T.WELCOME:
        this.token = msg.token; // adopt the host's authoritative token
        this.opts.onWelcome?.(msg);
        break;
      case T.STATE:
        this.opts.onView?.(msg.view);
        break;
      case T.PING:
        this.send({ t: T.PONG });
        break;
      case T.PONG:
        break;
      case T.ERR:
        this.opts.onError?.(msg.m || 'Action rejected.');
        if (msg.m && /closed the room/i.test(msg.m)) this.opts.onHostLeft?.();
        break;
      default:
        break;
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.lastRecv = Date.now();
    this.wdLastTick = Date.now();
    this.heartbeat = setInterval(() => {
      if (this.conn && this.conn.open) this.send({ t: T.PING });
    }, RECONNECT.heartbeatMs);
    // Watchdog: if we hear nothing for a while, force a reconnect.
    this.watchdog = setInterval(() => {
      if (this.destroyed) return;
      const now = Date.now();
      const gap = now - this.wdLastTick;
      this.wdLastTick = now;

      // The interval should fire every heartbeatMs. A much longer gap means
      // this tab was frozen or throttled (screen off, backgrounded), not that
      // the host went quiet — the silence is our fault, and tearing down a
      // perfectly good channel over it causes the very drop we're avoiding.
      // Re-arm, probe, and let the next tick judge on honest evidence.
      if (gap > RECONNECT.heartbeatMs * 2) {
        this.lastRecv = now;
        this.send({ t: T.PING });
        return;
      }

      if (now - this.lastRecv > RECONNECT.heartbeatMs * 2.5) {
        this._status('reconnecting');
        try { this.conn?.close(); } catch { /* ignore */ }
        this._scheduleReconnect();
      }
    }, RECONNECT.heartbeatMs);
  }

  _stopHeartbeat() {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
  }

  _scheduleReconnect(recreatePeer = false) {
    if (this.destroyed || this.reconnectTimer) return;
    this._stopHeartbeat();
    this.attempt++;
    const delay = Math.min(RECONNECT.maxDelayMs, RECONNECT.baseDelayMs * Math.pow(1.6, this.attempt));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.destroyed) return;
      if (recreatePeer || !this.peer || this.peer.destroyed) {
        try { this.peer?.destroy(); } catch { /* ignore */ }
        this._createPeer();
      } else if (this.peer.disconnected) {
        try { this.peer.reconnect(); } catch { this._createPeer(); }
        // give the broker a moment, then re-dial the host
        setTimeout(() => this._connectToHost(), 400);
      } else {
        this._connectToHost();
      }
    }, delay);
  }

  // Called when the tab becomes visible again (see main.js). Waking is the one
  // moment we know a drop is likely, so skip the backoff entirely: sitting out
  // up to maxDelayMs after the user is already looking at the screen is what
  // makes a reconnect feel like a hang.
  wake() {
    if (this.destroyed) return;
    this.attempt = 0;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }

    if (!this.peer || this.peer.destroyed) { this._createPeer(); return; }
    if (this.peer.disconnected) {
      this._status('reconnecting');
      try { this.peer.reconnect(); } catch { this._createPeer(); return; }
      // Give the broker a moment to take us back before re-dialling the host.
      setTimeout(() => this._connectToHost(), 400);
      return;
    }
    if (!this.conn || !this.conn.open) {
      this._status('reconnecting');
      this._connectToHost();
      return;
    }
    // Channel still claims to be open. It may be half-open, so don't trust it
    // blindly — but don't tear it down either. Probe and let the watchdog rule.
    this.lastRecv = Date.now();
    this.wdLastTick = Date.now();
    this.send({ t: T.PING });
  }

  // Public: manually retry (e.g. user taps "Retry" after host-left).
  retryNow() {
    this.unavailableStreak = 0;
    this.attempt = 0;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (!this.peer || this.peer.destroyed) this._createPeer();
    else this._connectToHost();
  }

  send(msg) {
    try {
      if (this.conn && this.conn.open) this.conn.send(msg);
    } catch { /* dropped; watchdog will recover */ }
  }

  // --- action helpers ----------------------------------------------------
  chooseTeam(team) { this.send({ t: T.SET_TEAM, team }); }
  chooseRole(role) { this.send({ t: T.SET_ROLE, role }); }
  giveClue(word, count) { this.send({ t: T.CLUE, word, count }); }
  guess(index) { this.send({ t: T.GUESS, index }); }
  endTurn() { this.send({ t: T.END_TURN }); }

  _status(s) { this.opts.onStatus?.(s); }

  destroy() {
    this.destroyed = true;
    this._stopHeartbeat();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { this.conn?.close(); } catch { /* ignore */ }
    try { this.peer?.destroy(); } catch { /* ignore */ }
  }
}

// =========================================================================
// helpers
// =========================================================================
function safeSend(conn, msg) {
  try { if (conn && conn.open) conn.send(msg); } catch { /* ignore */ }
}

function sanitizeName(name) {
  return String(name ?? '').trim().slice(0, 24);
}

function friendlyPeerError(err) {
  const type = err && err.type;
  if (type === 'peer-unavailable') return 'Couldn\'t reach that room — check the code.';
  if (type === 'network' || type === 'server-error') {
    return 'Couldn\'t reach the connection server. Check your internet, then retry.';
  }
  return 'Connection problem. Retrying…';
}
