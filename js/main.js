// ===========================================================================
// main.js — app entry. Wires the screens, the host/client networking, local
// persistence (name / room / token / host snapshot), and the input controls.
// This is the only module that talks to BOTH the network layer and the UI.
// ===========================================================================

import { UNLIMITED } from './config.js';
import { HostNet, ClientNet, randomRoomCode } from './net.js';
import * as Store from './storage.js';
import * as UI from './ui.js';
import * as View from './render.js';
import { keepAwake } from './wakelock.js';
import { getHostState } from './storage.js';

const $ = (id) => document.getElementById(id);

// --- app state -----------------------------------------------------------
const app = {
  mode: null, // 'host' | 'client'
  host: null,
  client: null,
  roomCode: null,
  view: null,
  screen: null, // currently shown screen (so we only switch when it changes)
  clueCount: 1, // local stepper value: integer | UNLIMITED
  spectator: false, // joining as a read-only TV?
};

// =========================================================================
// boot
// =========================================================================
function boot() {
  registerServiceWorker();

  // Restore remembered name.
  const name = Store.getName();
  if (name) {
    $('home-name').value = name;
    $('join-name').value = name;
  }

  // Offer to resume a previously hosted game (host reload safety).
  const lastRoom = Store.getLastHostRoom();
  if (lastRoom && getHostState(lastRoom)) {
    $('home-resume').hidden = false;
    $('btn-resume').textContent = `Resume your hosted game (${lastRoom})`;
  }

  wireHome();
  wireJoin();
  wireLobby();
  wireGame();
  wireLifecycle();

  View.initRender({
    onGuess: doGuess,
    onAdmin: doAdmin,
    onUnkick: doUnkick,
    onTimer: setTimer,
  });

  UI.showScreen('home');
  app.screen = 'home';
}

// =========================================================================
// page lifecycle
//
// Phones freeze a backgrounded tab: timers stop and the WebRTC data channel
// dies without firing 'close'. Nothing inside net.js can observe that from the
// inside, so the moment we're visible again is the cue to re-check the link.
// Waiting for the next heartbeat instead would leave the user staring at a
// stale board for seconds after they've already come back.
// =========================================================================
function wireLifecycle() {
  const wake = () => {
    if (document.visibilityState !== 'visible') return;
    try { app.host?.wake(); } catch { /* ignore */ }
    try { app.client?.wake(); } catch { /* ignore */ }
  };
  document.addEventListener('visibilitychange', wake);
  // Coming back from the bfcache (Safari's back/forward gesture).
  window.addEventListener('pageshow', wake);
  // The radio may return well after the tab does, e.g. leaving airplane mode.
  window.addEventListener('online', wake);
}

// =========================================================================
// service worker
// =========================================================================
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    // Relative path → works under the GitHub Pages subpath.
    await navigator.serviceWorker.register('sw.js');
  } catch {
    /* SW needs a secure context (https/localhost). Plain http on the LAN
       still runs the app fine, just without offline caching. */
  }
}

// =========================================================================
// HOME
// =========================================================================
function wireHome() {
  $('home-name').addEventListener('input', (e) => Store.setName(e.target.value.trim()));

  $('btn-host').addEventListener('click', () => {
    const name = $('home-name').value.trim();
    if (!name) { UI.toast('Enter your name first.'); $('home-name').focus(); return; }
    Store.setName(name);
    startHosting(randomRoomCode(), false, name);
  });

  $('btn-show-join').addEventListener('click', () => openJoin(false));
  $('btn-show-tv').addEventListener('click', () => openJoin(true));

  $('btn-resume').addEventListener('click', () => {
    const room = Store.getLastHostRoom();
    if (!room) return;
    const seat = Store.getSeat(room);
    const name = seat?.name || Store.getName() || 'Host';
    startHosting(room, true, name);
  });
}

// =========================================================================
// HOST
// =========================================================================
function startHosting(roomCode, resume, name) {
  teardownNet();
  app.mode = 'host';
  app.roomCode = roomCode;

  const stored = resume ? getHostState(roomCode) : null;
  const seat = Store.getSeat(roomCode);

  app.host = new HostNet({
    roomCode,
    resume,
    state: stored,
    hostName: name,
    hostToken: seat?.token,
    onLocalView: handleView,
    onStatus: (s) => UI.setNetStatus(s),
    onError: (m) => UI.toast(m),
    onRoomCodeChange: (code) => {
      app.roomCode = code;
      setLobbyCode(code);
      UI.toast(`Room code updated to ${code}`);
    },
  });
  app.host.start();
  // The host is the one device that must not sleep — it owns the state and the
  // turn clock, so its screen locking stalls the whole room.
  keepAwake(true);

  setLobbyCode(roomCode);
  UI.showScreen('lobby');
  app.screen = 'lobby';
}

function setLobbyCode(code) {
  $('lobby-code').textContent = code;
}

// Guarded: this runs on every in-game state update, and the renderer's contract
// is to never touch DOM that hasn't actually changed.
function setGameCode(code) {
  const el = $('game-code');
  const text = code || '----';
  if (el.textContent !== text) el.textContent = text;
}

// =========================================================================
// JOIN (client)
// =========================================================================

// Open the join screen in either player mode or read-only TV/spectator mode.
// TV mode hides the name field (a TV is anonymous) and relabels the screen.
function openJoin(spectator) {
  app.spectator = !!spectator;
  const nameField = $('join-name-field');
  const title = $('join-title');
  const connect = $('btn-join');
  if (spectator) {
    nameField.hidden = true;
    title.textContent = 'Watch on this TV';
    connect.textContent = 'Connect TV';
  } else {
    nameField.hidden = false;
    title.textContent = 'Enter a room';
    connect.textContent = 'Connect';
    if (!$('join-name').value) $('join-name').value = $('home-name').value.trim();
  }
  $('join-error').textContent = '';
  UI.showScreen('join'); app.screen = 'join';
  $('join-code').focus();
}

function wireJoin() {
  const codeInput = $('join-code');
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  });
  $('join-name').addEventListener('input', (e) => Store.setName(e.target.value.trim()));

  $('btn-join-back').addEventListener('click', () => { UI.showScreen('home'); app.screen = 'home'; });
  $('btn-join').addEventListener('click', joinGame);
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinGame(); });
  $('join-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinGame(); });
}

function joinGame() {
  const code = $('join-code').value.trim().toUpperCase();
  const spectator = !!app.spectator;
  // A TV is anonymous (its name field is hidden); players must name themselves.
  const name = spectator ? 'TV' : $('join-name').value.trim();
  const err = $('join-error');
  err.textContent = '';

  if (code.length !== 4) { err.textContent = 'Room code is 4 characters.'; return; }
  if (!spectator && !name) { err.textContent = 'Enter your name.'; return; }
  if (!spectator) Store.setName(name);

  teardownNet();
  app.mode = 'client';
  app.roomCode = code;

  // Players auto-reclaim their seat by token; a TV is always a fresh, read-only
  // seat and must never present (or persist over) a player's stored token.
  const seat = spectator ? null : Store.getSeat(code);

  app.client = new ClientNet({
    roomCode: code,
    token: seat?.token,
    name,
    spectator,
    onView: handleView,
    onWelcome: (msg) => {
      // Only players persist identity; a TV must never clobber the player seat
      // token stored for this room on the same device.
      if (!spectator) Store.setSeat(code, { token: msg.token, name });
    },
    onStatus: (s) => UI.setNetStatus(s),
    onError: (m) => {
      // While still on the join screen, surface inline; otherwise toast.
      if (app.screen === 'join') err.textContent = m;
      else UI.toast(m);
    },
    onUnreachable: () => {
      err.textContent = 'Couldn\'t reach that room — check the code and try again.';
      UI.hideNetStatus();
      teardownNet();
      UI.showScreen('join'); app.screen = 'join';
    },
    onHostLeft: () => {
      UI.setNetStatus('hostgone', { onRetry: () => app.client && app.client.retryNow() });
    },
    onKicked: (m) => {
      // Deliberately keep the stored seat token. Clearing it would let the
      // client walk straight back in as a brand-new player on the next join,
      // which is exactly what the host just said they didn't want.
      teardownNet();
      UI.hideNetStatus();
      UI.showScreen('home');
      app.screen = 'home';
      UI.toast(m);
    },
  });
  app.client.start();
  // Operatives can go a long while without tapping anything; without this their
  // screen locks mid-turn and drops them.
  keepAwake(true);

  UI.setNetStatus('connecting');
  // We stay on the join screen until the first view arrives, so a bad code
  // surfaces inline rather than dumping the user into an empty lobby.
}

// =========================================================================
// view routing — called on every state update from host or client
// =========================================================================
function handleView(view) {
  app.view = view;

  // A spectator's view is read-only; the `tv` body class drives the CSS that
  // hides player controls and enlarges the board for across-the-room viewing.
  document.body.classList.toggle('tv', !!(view.you && view.you.spectator));

  const target = view.phase === 'lobby' ? 'lobby' : 'game';

  // Only switch screens when it actually changes — switching resets scroll,
  // and we must never reset scroll on a mid-game state update.
  if (app.screen !== target) {
    if (target === 'game') View.buildBoard();
    UI.showScreen(target);
    app.screen = target;
  }

  if (target === 'lobby') {
    setLobbyCode(view.roomCode);
    View.renderRoster(view);
  } else {
    setGameCode(view.roomCode);
  }

  // Board + HUD + panels + game-over overlay, coalesced into one frame.
  View.render(view);
}

// =========================================================================
// LOBBY controls
// =========================================================================
function wireLobby() {
  $('lobby-code').addEventListener('click', async () => {
    const ok = await UI.copyText($('lobby-code').textContent);
    UI.toast(ok ? 'Room code copied' : $('lobby-code').textContent);
  });

  document.querySelectorAll('#my-controls [data-team]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.team === 'none' ? null : btn.dataset.team;
      setMyTeam(t);
    });
  });
  document.querySelectorAll('#my-controls [data-role]').forEach((btn) => {
    btn.addEventListener('click', () => setMyRole(btn.dataset.role));
  });

  View.buildTimerControls();
  $('timer-off').addEventListener('click', () => setTimer({ enabled: false }));
  $('timer-on').addEventListener('click', () => setTimer({ enabled: true }));

  $('btn-start').addEventListener('click', () => {
    const res = app.host?.startGame();
    if (res && !res.ok) UI.toast(res.error);
  });

  $('btn-leave-lobby').addEventListener('click', leaveRoom);
}

function setMyTeam(team) {
  if (app.mode === 'host') { const r = app.host.localSetTeam(team); if (r && !r.ok) UI.toast(r.error); }
  else app.client?.chooseTeam(team);
}
function setMyRole(role) {
  if (app.mode === 'host') { const r = app.host.localSetRole(role); if (r && !r.ok) UI.toast(r.error); }
  else app.client?.chooseRole(role);
}

// host-only: the timer is a room setting, so only the host can change it
function setTimer(patch) {
  if (app.mode !== 'host') return;
  const r = app.host.localSetTimer(patch);
  if (r && !r.ok) UI.toast(r.error);
}

// host-only: move another player from the lobby
function doAdmin(seatId, kind, val) {
  if (app.mode !== 'host') return;
  let r;
  if (kind === 'team') r = app.host.adminSetTeam(seatId, val === 'none' ? null : val);
  else if (kind === 'kick') r = doKick(seatId);
  else r = app.host.adminSetRole(seatId, val);
  if (r && !r.ok) UI.toast(r.error);
}

// The kick button sits inches from the team buttons and is the same size, so a
// mis-tap is likely — confirm by name before removing anyone.
function doKick(seatId) {
  const p = (app.view?.roster || []).find((s) => s.seatId === seatId);
  const name = p?.name || 'this player';
  if (!window.confirm(`Remove ${name} from the room?`)) return null;
  const r = app.host.adminKick(seatId);
  if (r && r.ok) UI.toast(`${r.name} was removed.`);
  return r;
}

function doUnkick(token) {
  if (app.mode !== 'host') return;
  const r = app.host.adminUnkick(token);
  if (r && !r.ok) { UI.toast(r.error); return; }
  UI.toast(`${r.name} can rejoin with the room code.`);
}

// =========================================================================
// GAME controls
// =========================================================================
function wireGame() {
  // Clue number stepper.
  $('clue-minus').addEventListener('click', () => stepClue(-1));
  $('clue-plus').addEventListener('click', () => stepClue(+1));
  $('clue-inf').addEventListener('click', toggleInfinite);
  renderClueCount();

  $('clue-word').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitClue(); });
  $('btn-clue').addEventListener('click', submitClue);

  $('btn-end-turn').addEventListener('click', () => {
    if (app.mode === 'host') app.host.localEndTurn();
    else app.client?.endTurn();
  });

  $('btn-start-clock').addEventListener('click', () => {
    const r = app.host?.localStartClock();
    if (r && !r.ok) UI.toast(r.error);
  });

  $('btn-skip-turn').addEventListener('click', () => {
    const turn = app.view?.game?.turn;
    if (!window.confirm(`Skip ${turn ? turn.toUpperCase() : 'this'} team's turn?`)) return;
    const r = app.host?.localSkipTurn();
    if (r && !r.ok) UI.toast(r.error);
  });

  $('btn-again').addEventListener('click', () => app.host?.playAgain());
  $('btn-newgame').addEventListener('click', () => app.host?.newGame());

  $('game-code').addEventListener('click', async () => {
    const code = $('game-code').textContent;
    const ok = await UI.copyText(code);
    UI.toast(ok ? 'Room code copied' : code);
  });

  $('btn-leave-game').addEventListener('click', leaveRoom);
}

function stepClue(delta) {
  if (app.clueCount === UNLIMITED) app.clueCount = delta > 0 ? 1 : 0;
  else app.clueCount = Math.max(0, app.clueCount + delta);
  renderClueCount();
}
function toggleInfinite() {
  app.clueCount = app.clueCount === UNLIMITED ? 1 : UNLIMITED;
  renderClueCount();
}
function renderClueCount() {
  $('clue-count').textContent = app.clueCount === UNLIMITED ? '∞' : String(app.clueCount);
  $('clue-inf').classList.toggle('stepper__inf--on', app.clueCount === UNLIMITED);
}

function submitClue() {
  const wordEl = $('clue-word');
  const word = wordEl.value.trim();
  const warnEl = $('clue-warn');
  warnEl.textContent = '';
  if (!word) { warnEl.textContent = 'Enter a clue word.'; wordEl.focus(); return; }
  if (/\s/.test(word)) { warnEl.textContent = 'Clue must be a single word.'; return; }

  // Soft warning: clue matches a word still on the board → confirm.
  const g = app.view && app.view.game;
  if (g) {
    const dup = g.words.some((bw, i) => !g.revealed[i] && bw.toLowerCase() === word.toLowerCase());
    if (dup && !window.confirm('That clue matches a word still on the board. Give it anyway?')) return;
  }

  if (app.mode === 'host') {
    const r = app.host.localClue(word, app.clueCount);
    if (r && !r.ok) { warnEl.textContent = r.error; return; }
    if (r && r.warning) UI.toast(r.warning);
  } else {
    app.client?.giveClue(word, app.clueCount);
  }
  // Clear the local input only after a successful submit.
  wordEl.value = '';
  app.clueCount = 1;
  renderClueCount();
}

function doGuess(index) {
  if (app.mode === 'host') app.host.localGuess(index);
  else app.client?.guess(index);
}

// =========================================================================
// leave / teardown
// =========================================================================
function leaveRoom() {
  if (app.mode === 'host') {
    if (!window.confirm('Leave and end the game for everyone?')) return;
    app.host.endGameForAll();
    Store.clearHostState(app.roomCode);
    Store.clearLastHostRoom();
  }
  teardownNet();
  UI.hideNetStatus();
  UI.showScreen('home');
  app.screen = 'home';

  // Refresh the resume hint.
  const lastRoom = Store.getLastHostRoom();
  $('home-resume').hidden = !(lastRoom && getHostState(lastRoom));
}

function teardownNet() {
  // Nobody is in a room any more — stop holding the user's screen awake.
  keepAwake(false);
  try { app.host?.destroy(); } catch { /* ignore */ }
  try { app.client?.destroy(); } catch { /* ignore */ }
  app.host = null;
  app.client = null;
  app.mode = null;
  app.view = null;
  app.spectator = false;
  document.body.classList.remove('tv');
  View.resetRenderState();
}

// =========================================================================
boot();
