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

  View.initRender({
    onGuess: doGuess,
    onAdmin: doAdmin,
  });

  UI.showScreen('home');
  app.screen = 'home';
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

  $('btn-show-join').addEventListener('click', () => {
    if (!$('join-name').value) $('join-name').value = $('home-name').value.trim();
    UI.showScreen('join'); app.screen = 'join';
    $('join-code').focus();
  });

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

  setLobbyCode(roomCode);
  UI.showScreen('lobby');
  app.screen = 'lobby';
}

function setLobbyCode(code) {
  $('lobby-code').textContent = code;
}

// =========================================================================
// JOIN (client)
// =========================================================================
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
  const name = $('join-name').value.trim();
  const err = $('join-error');
  err.textContent = '';

  if (code.length !== 4) { err.textContent = 'Room code is 4 characters.'; return; }
  if (!name) { err.textContent = 'Enter your name.'; return; }
  Store.setName(name);

  teardownNet();
  app.mode = 'client';
  app.roomCode = code;

  // Auto-reclaim: if we have a stored token for this room, present it.
  const seat = Store.getSeat(code);

  app.client = new ClientNet({
    roomCode: code,
    token: seat?.token,
    name,
    onView: handleView,
    onWelcome: (msg) => {
      // Persist our authoritative identity so reloads/reconnects restore us.
      Store.setSeat(code, { token: msg.token, name });
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
  });
  app.client.start();

  UI.setNetStatus('connecting');
  // We stay on the join screen until the first view arrives, so a bad code
  // surfaces inline rather than dumping the user into an empty lobby.
}

// =========================================================================
// view routing — called on every state update from host or client
// =========================================================================
function handleView(view) {
  app.view = view;

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

// host-only: move another player from the lobby
function doAdmin(seatId, kind, val) {
  if (app.mode !== 'host') return;
  let r;
  if (kind === 'team') r = app.host.adminSetTeam(seatId, val === 'none' ? null : val);
  else r = app.host.adminSetRole(seatId, val);
  if (r && !r.ok) UI.toast(r.error);
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

  $('btn-again').addEventListener('click', () => app.host?.playAgain());
  $('btn-newgame').addEventListener('click', () => app.host?.newGame());

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
  try { app.host?.destroy(); } catch { /* ignore */ }
  try { app.client?.destroy(); } catch { /* ignore */ }
  app.host = null;
  app.client = null;
  app.mode = null;
  app.view = null;
  View.resetRenderState();
}

// =========================================================================
boot();
