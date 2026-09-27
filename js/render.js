// ===========================================================================
// render.js — the ONLY code that reflects state into the DOM.
//
// Anti-flicker contract (hard requirement):
//   * The 5x5 grid of 25 cards is built ONCE (buildBoard) with stable,
//     index-keyed node references. We NEVER re-assign innerHTML of the board
//     or the roster on a state update.
//   * applyState(prev, next) is the single function allowed to mutate the
//     board DOM. It diffs prev vs next and toggles only the classes/text that
//     actually changed.
//   * Network sync is decoupled from rendering: incoming views are coalesced
//     and flushed inside ONE requestAnimationFrame.
//   * Controlled inputs (the Spymaster's clue field) are owned locally and
//     never clobbered by a state update; focus and scroll are preserved.
// ===========================================================================

import { UNLIMITED, GRID_COLS, TIMER, MEANINGS } from './config.js';
import { cap } from './rules.js';

const COLOR_CLASSES = ['card--red', 'card--blue', 'card--neutral', 'card--assassin'];
const HINT_CLASSES = ['card--hint-red', 'card--hint-blue', 'card--hint-neutral', 'card--hint-assassin'];

let cardNodes = [];
let boardBuilt = false;
let handlers = {};

// rAF coalescing
let pendingView = null;
let prevView = null;
let frameQueued = false;

// Client-local board mode. While on, a tap asks what a word MEANS instead of
// guessing it. It lives here rather than in the view because it is a private UI
// state — nothing about it should reach the host or the other players.
let lookupMode = false;

const $ = (id) => document.getElementById(id);

// --- init / board construction ------------------------------------------

export function initRender(h) {
  handlers = h || {};
}

export function buildBoard() {
  if (boardBuilt) return;
  const board = $('board');
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 25; i++) {
    const btn = document.createElement('button');
    btn.className = 'card';
    btn.type = 'button';
    btn.dataset.i = String(i);
    btn.setAttribute('role', 'gridcell');
    btn.style.setProperty('--col', String(i % GRID_COLS));

    const word = document.createElement('span');
    word.className = 'card__word';
    btn.appendChild(word);

    const mark = document.createElement('span');
    mark.className = 'card__mark';
    mark.setAttribute('aria-hidden', 'true');
    btn.appendChild(mark);

    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      // Lookup mode reuses the same 25 targets rather than adding a second
      // control per card — on a phone there is no room for both, and a mode is
      // easier to back out of than a mis-tapped icon.
      if (lookupMode) { handlers.onLookup?.(i); return; }
      handlers.onGuess?.(i);
    });

    cardNodes[i] = btn;
    frag.appendChild(btn);
  }
  board.appendChild(frag);
  boardBuilt = true;
}

// --- public entry: coalesce + flush in one frame -------------------------

export function render(view) {
  pendingView = view;
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(flush);
}

function flush() {
  frameQueued = false;
  const next = pendingView;
  if (!next) return;
  const prev = prevView;

  // Board cards (only when we're in a game and the grid exists).
  if (boardBuilt && next.game) applyState(prev, next);

  patchHud(prev, next);
  patchTimer(next);
  patchPanels(prev, next);
  patchGameOver(prev, next);

  prevView = next;
}

// =========================================================================
// applyState — the single board DOM mutator
// =========================================================================
export function applyState(prev, next) {
  const ng = next.game;
  if (!ng) return;
  const pg = prev && prev.game ? prev.game : null;

  const youOperative = next.you && next.you.role === 'operative';
  const yourTurn = next.you && ng.turn === next.you.team;
  const guessingOpen = next.phase === 'playing' && !!ng.clue;
  const canGuess = youOperative && yourTurn && guessingOpen;

  for (let i = 0; i < 25; i++) {
    const node = cardNodes[i];

    // --- word text (changes on a re-deal) ---
    const word = ng.words[i];
    if (!pg || pg.words[i] !== word) {
      node.firstChild.textContent = word;
      // Drives the one-line fit in CSS — see .card__word.
      node.style.setProperty('--len', String(word.length));
    }

    // Display color: known once the card is revealed (or at game over).
    const displayColor = (ng.revealed[i] || ng.fullKeyRevealed) ? ng.colors[i] : null;
    const prevDisplayColor = pg ? ((pg.revealed[i] || pg.fullKeyRevealed) ? pg.colors[i] : null) : undefined;

    // Spymaster-only muted tint for cards that are still hidden.
    const keyColor = next.key ? next.key[i] : null;
    const hint = (!ng.revealed[i] && !ng.fullKeyRevealed && keyColor) ? keyColor : null;
    const prevKeyColor = prev && prev.key ? prev.key[i] : null;
    const prevHint = pg ? ((!pg.revealed[i] && !pg.fullKeyRevealed && prevKeyColor) ? prevKeyColor : null) : undefined;

    const revealed = ng.revealed[i];
    const prevRevealed = pg ? pg.revealed[i] : undefined;

    if (revealed !== prevRevealed) {
      node.classList.toggle('card--revealed', revealed);
    }

    if (displayColor !== prevDisplayColor) {
      setOneClass(node, COLOR_CLASSES, displayColor ? `card--${displayColor}` : null);
      node.classList.toggle('card--assassin-mark', displayColor === 'assassin');
    }

    if (hint !== prevHint) {
      setOneClass(node, HINT_CLASSES, hint ? `card--hint-${hint}` : null);
      // Show the skull on the assassin for the Spymaster too.
      if (!revealed) node.classList.toggle('card--assassin-mark', hint === 'assassin');
    }

    // Clickability (board DOM, so it lives here).
    //
    // In lookup mode the usual turn/role gate does not apply: the whole point
    // is that an off-turn Spymaster, or an Operative waiting on the other team,
    // can find out what a word means. Only "already revealed" still blocks,
    // since a face-up card's meaning no longer matters.
    //
    // A word you already unlocked stays tappable even at zero allowance —
    // re-reading costs nothing, so greying it out would be a lie.
    const unlocked = !!(next.you && Array.isArray(next.you.lookups) && next.you.lookups.includes(i));
    const hasBudget = next.you
      && (next.you.lookupsLeft === UNLIMITED || Number(next.you.lookupsLeft) > 0);
    const clickable = lookupMode
      ? (lookupAvailable(next) && !revealed && (unlocked || hasBudget))
      : (canGuess && !revealed);
    // Marks the ones you have already paid for. Only while the mode is on, so
    // it never adds noise to the board during normal play.
    node.classList.toggle('card--known', lookupMode && unlocked && !revealed);
    if (node.disabled === clickable) { // disabled is the inverse of clickable
      node.disabled = !clickable;
    }
    node.classList.toggle('card--live', clickable);

    // Accessible label.
    const label = revealed || ng.fullKeyRevealed
      ? `${word}, ${displayColor}`
      : (hint ? `${word}, key ${hint}` : word);
    if (node.getAttribute('aria-label') !== label) node.setAttribute('aria-label', label);
  }
}

// Can this viewer use the meanings aid at all? Spectators are excluded the same
// way they are from every other control: a TV has nobody sitting at it.
function lookupAvailable(view) {
  return !!(view && view.phase === 'playing' && view.game
    && view.meanings && view.meanings.enabled
    && view.you && !view.you.spectator);
}

// Enter/leave lookup mode. Exported because the mode is driven by a button in
// main.js, but the board's clickability lives here.
export function setLookupMode(on) {
  const want = !!on;
  if (want === lookupMode) return;
  lookupMode = want;
  $('board')?.classList.toggle('board--lookup', lookupMode);
  // Re-run the two passes that read the mode. Passing prevView as both sides is
  // safe: every mode-dependent branch below recomputes unconditionally, and the
  // diff-guarded ones correctly no-op because nothing in the view changed.
  if (prevView) {
    if (boardBuilt && prevView.game) applyState(prevView, prevView);
    patchPanels(prevView, prevView);
  }
}

export function isLookupMode() { return lookupMode; }

// =========================================================================
// HUD (scores, turn, clue bar) — surgical text patches only
// =========================================================================
function patchHud(prev, next) {
  const ng = next.game;
  if (!ng) return;
  const pg = prev && prev.game ? prev.game : null;

  setText('count-red', ng.counts.red);
  setText('count-blue', ng.counts.blue);

  if (!pg || pg.turn !== ng.turn) {
    setText('turn-team', cap(ng.turn));
    const ti = $('turn-indicator');
    ti.classList.toggle('turn-indicator--red', ng.turn === 'red');
    ti.classList.toggle('turn-indicator--blue', ng.turn === 'blue');
  }

  // Clue + remaining guesses.
  const held = !!(ng.timer && ng.timer.pending);
  const clueText = ng.clue
    ? `${ng.clue.word.toUpperCase()} · ${ng.clue.count === UNLIMITED ? '∞' : ng.clue.count}`
    : (held ? 'Read the board — clock is paused.' : 'Waiting for a clue…');
  setText('clue-text', clueText);

  let guessText = '';
  if (ng.clue) {
    if (ng.guessesAllowed === UNLIMITED) guessText = `${ng.guessesUsed} guessed · ∞ left`;
    else guessText = `${Math.max(0, ng.guessesAllowed - ng.guessesUsed)} guesses left`;
  }
  setText('clue-guesses', guessText);
}

// =========================================================================
// Turn countdown
//
// The wire carries a duration, never a timestamp: each view re-anchors the
// countdown on THIS device's monotonic clock, so a device with a wrong
// wall-clock still counts down correctly. The host remains the only authority
// on expiry — this is display only.
// =========================================================================
let timerAnchor = null;
let timerTotal = 0;
let timerTick = null;

function patchTimer(next) {
  const t = next.phase === 'playing' && next.game ? next.game.timer : null;
  const el = $('clue-timer');
  const bar = $('clue-progress');
  if (!t) { stopTimerTick(); hide(el); hide(bar); return; }
  show(el);
  show(bar);

  // Held by the host: show the full dial frozen, so the room can see what the
  // first Spymaster is about to get without it already draining.
  if (t.pending) {
    stopTimerTick();
    paintClock(t.totalMs);
    el.classList.remove('clue-bar__timer--urgent');
    el.classList.add('clue-bar__timer--held');
    paintBar(1, false, true);
    return;
  }

  el.classList.remove('clue-bar__timer--held');
  timerTotal = t.totalMs;
  timerAnchor = performance.now() + t.remainingMs;
  paintTimer();
  if (!timerTick) timerTick = setInterval(paintTimer, 250);
}

function paintTimer() {
  const el = $('clue-timer');
  if (!el || timerAnchor == null) return;
  const left = Math.max(0, timerAnchor - performance.now());
  paintClock(left);
  const urgent = left <= 10000;
  el.classList.toggle('clue-bar__timer--urgent', urgent);
  paintBar(timerTotal > 0 ? left / timerTotal : 0, urgent, false);
}

function paintClock(ms) {
  const secs = Math.ceil(ms / 1000);
  setText('clue-timer', `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`);
}

function paintBar(frac, urgent, held) {
  const fill = $('clue-progress-fill');
  if (!fill) return;
  fill.style.transform = `scaleX(${Math.min(1, Math.max(0, frac))})`;
  fill.classList.toggle('clue-bar__progress-fill--urgent', urgent);
  fill.classList.toggle('clue-bar__progress-fill--held', held);
}

function stopTimerTick() {
  if (timerTick) { clearInterval(timerTick); timerTick = null; }
  timerAnchor = null;
  timerTotal = 0;
}

// =========================================================================
// Panels (spymaster composer / operative actions / waiting) + live region
// =========================================================================
function patchPanels(prev, next) {
  const ng = next.game;
  const you = next.you;
  const playing = next.phase === 'playing';

  const sm = $('spymaster-panel');
  const op = $('operative-panel');
  const wait = $('waiting-panel');

  if (you && you.spectator) {
    // A TV is purely read-only: it never composes clues, guesses, or waits.
    hide(sm); hide(op); hide(wait);
  } else if (!playing || !ng || !you) {
    hide(sm); hide(op); hide(wait);
  } else {
    const yourTurn = ng.turn === you.team;
    const isSpymaster = you.role === 'spymaster';
    const clueGiven = !!ng.clue;

    // Active Spymaster, no clue yet → compose a clue.
    const showSpymaster = isSpymaster && yourTurn && !clueGiven;
    // Active Operative, clue given → guess / end turn.
    const showOperative = !isSpymaster && yourTurn && clueGiven;

    toggle(sm, showSpymaster);
    toggle(op, showOperative);
    setText('operative-hint', next.extraGuess
      ? 'Tap a card to guess. You get one extra guess beyond the clue number.'
      : 'Tap a card to guess. You get exactly as many guesses as the clue number.');

    if (!showSpymaster && !showOperative) {
      show(wait);
      setText('waiting-text', waitingMessage(ng, you));
    } else {
      hide(wait);
    }
  }

  // Host-only gate on the opening clock. A TV is never the host, but guard
  // anyway so a spectator can never be shown a control.
  const held = playing && ng && ng.timer && ng.timer.pending;
  const hostPlaying = !!(playing && ng && you && you.isHost && !you.spectator);
  toggle($('clock-gate'), !!(held && you && you.isHost && !you.spectator));

  // Skip turn. Hidden while the opening clock is still held so the host is only
  // ever offered one turn action at a time.
  toggle($('host-turn'), hostPlaying && !held);

  patchMeaningPanel(next);

  // aria-live announcement when the narrative event changes.
  if (ng && (!prev || !prev.game || prev.game.lastEvent !== ng.lastEvent)) {
    setText('live', ng.lastEvent || '');
  }
}

// The meanings aid: one button plus a running budget. Visible to every seated
// player for the whole game, because the moment you need a definition is rarely
// the moment it is your turn.
function patchMeaningPanel(next) {
  const available = lookupAvailable(next);
  toggle($('meaning-panel'), available);
  if (!available) {
    // Leaving the mode armed while the panel is gone would strand the board in
    // a state the player has no control to exit. Clear the flag directly rather
    // than via setLookupMode(): we are already inside a render pass, and its
    // re-render would re-patch the panels from the PREVIOUS view and undo the
    // work this pass has just done.
    //
    // The board is safe for this frame either way — applyState ran first, and
    // its lookup branch is gated on the same lookupAvailable() that just failed,
    // so every card is already disabled.
    if (lookupMode) {
      lookupMode = false;
      $('board')?.classList.toggle('board--lookup', false);
    }
    return;
  }

  const left = next.you.lookupsLeft;
  const unlimited = left === UNLIMITED;
  const used = Array.isArray(next.you.lookups) ? next.you.lookups.length : 0;
  const spent = !unlimited && Number(left) <= 0;

  const btn = $('btn-meaning');
  btn.textContent = lookupMode ? 'Done' : 'Check a meaning';
  btn.classList.toggle('btn--on', lookupMode);
  // Only truly dead when there is nothing left to spend AND nothing to re-read.
  btn.disabled = spent && used === 0;

  let hint;
  if (lookupMode) hint = 'Tap any face-down card to see what it means.';
  else if (unlimited) hint = 'Unlimited checks.';
  else if (spent) hint = used ? 'None left — you can still re-read yours.' : 'No checks left.';
  else hint = `${left} of ${Number(left) + used} left.`;
  setText('meaning-hint', hint);
}

function waitingMessage(ng, you) {
  const yourTurn = ng.turn === you.team;
  if (you.role === 'spymaster') {
    return yourTurn
      ? 'Your Operatives are guessing…'
      : `Waiting for ${cap(ng.turn)}'s turn.`;
  }
  // operative
  if (!yourTurn) return `Waiting for ${cap(ng.turn)} team.`;
  return `Waiting for your Spymaster's clue…`;
}

// =========================================================================
// Game over overlay
// =========================================================================
function patchGameOver(prev, next) {
  const over = next.phase === 'gameover' && next.game;
  const el = $('gameover');
  if (!over) { hide(el); return; }
  show(el);

  const g = next.game;
  const winner = g.winner;
  setText('winner-banner', `${cap(winner)} team wins`);
  const sub = g.endedByAssassin
    ? `The assassin was revealed — instant loss for ${cap(winner === 'red' ? 'blue' : 'red')}.`
    : `All ${cap(winner)} agents have been found.`;
  setText('gameover-sub', sub);

  // Host sees Play Again / Back to lobby; players wait. A spectator (TV) can do
  // neither — it just displays the result, so hide both control rows (and the
  // .tv CSS turns this overlay into a banner so the revealed board stays
  // visible behind it).
  const spectator = next.you && next.you.spectator;
  const isHost = next.you && next.you.isHost;
  toggle($('gameover-actions'), !spectator && !!isHost);
  toggle($('gameover-wait'), !spectator && !isHost);
}

// =========================================================================
// Roster (lobby) — keyed reconciliation, never innerHTML rebuild
// =========================================================================
const rosterNodes = new Map(); // seatId -> <li>

export function renderRoster(view) {
  const roster = view.roster || [];
  const groups = { red: $('roster-red'), blue: $('roster-blue'), bench: $('roster-bench') };
  const isHost = view.you && view.you.isHost;

  const seen = new Set();
  for (const p of roster) {
    seen.add(p.seatId);
    let li = rosterNodes.get(p.seatId);
    if (!li) {
      li = buildRosterItem(p, isHost);
      rosterNodes.set(p.seatId, li);
    }
    updateRosterItem(li, p, view);
    const target = groups[p.team === 'red' ? 'red' : p.team === 'blue' ? 'blue' : 'bench'];
    if (li.parentNode !== target) target.appendChild(li);
  }
  // Remove seats that disappeared (e.g., after New Game reset elsewhere).
  for (const [seatId, li] of rosterNodes) {
    if (!seen.has(seatId)) { li.remove(); rosterNodes.delete(seatId); }
  }

  // Team composition help.
  const c = view.composition || { red: {}, blue: {} };
  setText('head-red', `${c.red.spymasters || 0} SM · ${c.red.operatives || 0} OP`);
  setText('head-blue', `${c.blue.spymasters || 0} SM · ${c.blue.operatives || 0} OP`);

  renderKicked(view);

  // Host start button + validation message.
  const hostControls = $('host-controls');
  toggle(hostControls, !!isHost);
  if (isHost) {
    const chk = view.canStart || { ok: false, problems: [] };
    $('btn-start').disabled = !chk.ok;
    setText('start-help', chk.ok ? 'Ready when you are.' : chk.problems.join(' '));
    patchTimerControls(view.timer);
    patchGuessControls(view.extraGuess);
    patchMeaningControls(view.meanings);
  }

  // Reflect my current team/role on the segmented controls.
  if (view.you) {
    markSeg('[data-team]', 'team', view.you.team || 'none');
    markSeg('[data-role]', 'role', view.you.role);
  }
}

// One button per configured preset, so config.js stays the only place the
// available lengths are listed.
let timerBuilt = false;

export function buildTimerControls() {
  if (timerBuilt) return;
  for (const group of document.querySelectorAll('#timer-lengths .seg[data-timer]')) {
    const field = group.dataset.timer;
    for (const secs of TIMER.presets) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg__btn';
      b.textContent = secs % 60 === 0 ? `${secs / 60}m` : `${secs}s`;
      b.dataset.secs = String(secs);
      b.addEventListener('click', () => handlers.onTimer?.({ [field]: secs }));
      group.appendChild(b);
    }
  }
  timerBuilt = true;
}

function patchTimerControls(t) {
  if (!t) return;
  $('timer-off').classList.toggle('seg__btn--on', !t.enabled);
  $('timer-on').classList.toggle('seg__btn--on', !!t.enabled);
  toggle($('timer-lengths'), !!t.enabled);
  for (const group of document.querySelectorAll('#timer-lengths .seg[data-timer]')) {
    const want = String(t[group.dataset.timer]);
    for (const b of group.children) b.classList.toggle('seg__btn--on', b.dataset.secs === want);
  }
}

function patchGuessControls(extraGuess) {
  $('guesses-exact').classList.toggle('seg__btn--on', !extraGuess);
  $('guesses-plus').classList.toggle('seg__btn--on', !!extraGuess);
}

// One button per configured allowance, same pattern as the timer presets.
let meaningsBuilt = false;

export function buildMeaningControls() {
  if (meaningsBuilt) return;
  const group = $('meanings-limit-group');
  if (!group) return;
  for (const limit of MEANINGS.limits) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg__btn';
    b.textContent = limit === UNLIMITED ? '∞' : String(limit);
    // dataset stringifies anyway; being explicit keeps the compare below honest.
    b.dataset.limit = String(limit);
    b.addEventListener('click', () => handlers.onMeanings?.({ limit }));
    group.appendChild(b);
  }
  meaningsBuilt = true;
}

function patchMeaningControls(m) {
  if (!m) return;
  $('meanings-off').classList.toggle('seg__btn--on', !m.enabled);
  $('meanings-on').classList.toggle('seg__btn--on', !!m.enabled);
  toggle($('meanings-limits'), !!m.enabled);
  const group = $('meanings-limit-group');
  if (!group) return;
  const want = String(m.limit);
  for (const b of group.children) b.classList.toggle('seg__btn--on', b.dataset.limit === want);
}

function buildRosterItem(p, isHost) {
  const li = document.createElement('li');
  li.className = 'roster__item';
  li.dataset.seat = p.seatId;

  const dot = document.createElement('span');
  dot.className = 'roster__status';
  li.appendChild(dot);

  const name = document.createElement('span');
  name.className = 'roster__name';
  li.appendChild(name);

  const role = document.createElement('span');
  role.className = 'roster__role';
  li.appendChild(role);

  // Host-only admin buttons to move a player.
  if (isHost) {
    const admin = document.createElement('span');
    admin.className = 'roster__admin';
    admin.innerHTML = ''; // built once, static structure
    const controls = [
      ['R', 'team', 'red'], ['B', 'team', 'blue'], ['·', 'team', 'none'],
      ['SM', 'role', 'spymaster'],
    ];
    // The host can't remove themselves, so they never get the button.
    if (!p.isHost) controls.push(['✕', 'kick', '']);
    for (const [label, kind, val] of controls) {
      const b = document.createElement('button');
      b.className = kind === 'kick' ? 'minibtn minibtn--danger' : 'minibtn';
      b.textContent = label;
      b.dataset.kind = kind;
      b.dataset.val = val;
      if (kind === 'kick') b.title = `Remove ${p.name} from the room`;
      b.addEventListener('click', () => handlers.onAdmin?.(p.seatId, kind, val));
      admin.appendChild(b);
    }
    li.appendChild(admin);
  }
  return li;
}

// Host-only list of removed players, each with a way back in. Small enough that
// a plain rebuild is fine — unlike the roster, nothing here is interactive
// mid-typing and it is empty in the overwhelming majority of rooms.
function renderKicked(view) {
  const section = $('kicked-controls');
  const list = $('kicked-list');
  if (!section || !list) return;
  const kicked = (view.you && view.you.isHost && view.kicked) || [];
  toggle(section, kicked.length > 0);
  if (!kicked.length) { list.textContent = ''; return; }

  list.textContent = '';
  for (const k of kicked) {
    const li = document.createElement('li');
    li.className = 'roster__item roster__item--kicked';

    const name = document.createElement('span');
    name.className = 'roster__name';
    name.textContent = k.name;
    li.appendChild(name);

    const b = document.createElement('button');
    b.className = 'minibtn';
    b.textContent = 'Allow back';
    b.title = `Let ${k.name} rejoin this room`;
    b.addEventListener('click', () => handlers.onUnkick?.(k.token));
    li.appendChild(b);

    list.appendChild(li);
  }
}

function updateRosterItem(li, p, view) {
  const dot = li.querySelector('.roster__status');
  dot.classList.toggle('is-online', p.connected);
  dot.classList.toggle('is-offline', !p.connected);
  dot.title = p.connected ? 'online' : 'reconnecting…';

  const nameEl = li.querySelector('.roster__name');
  const meTag = view.you && view.you.seatId === p.seatId ? ' (you)' : '';
  const hostTag = p.isHost ? ' ★' : '';
  const nameText = `${p.name}${hostTag}${meTag}`;
  if (nameEl.textContent !== nameText) nameEl.textContent = nameText;

  const roleEl = li.querySelector('.roster__role');
  const roleText = p.role === 'spymaster' ? 'SPYMASTER' : '';
  if (roleEl.textContent !== roleText) roleEl.textContent = roleText;
  li.classList.toggle('roster__item--offline', !p.connected);
}

// =========================================================================
// small DOM helpers
// =========================================================================
function setText(id, value) {
  const el = $(id);
  if (!el) return;
  const s = String(value);
  if (el.textContent !== s) el.textContent = s;
}

function setOneClass(node, group, wanted) {
  for (const c of group) {
    if (c === wanted) node.classList.add(c);
    else node.classList.remove(c);
  }
  if (wanted && !group.includes(wanted)) node.classList.add(wanted);
}

function markSeg(selector, attr, value) {
  document.querySelectorAll(`#my-controls ${selector}`).forEach((b) => {
    b.classList.toggle('seg__btn--on', b.dataset[attr] === value);
  });
}

function hide(el) { if (el && !el.hidden) el.hidden = true; }
function show(el) { if (el && el.hidden) el.hidden = false; }
function toggle(el, on) { if (el) el.hidden = !on; }

export function resetRenderState() {
  prevView = null;
  pendingView = null;
  stopTimerTick();
  // Client-local mode, so nothing else clears it: without this, leaving a room
  // mid-lookup would arm the board in the next room the player joins.
  lookupMode = false;
  $('board')?.classList.remove('board--lookup');
  // Seat ids restart at p1 in every room, so these nodes would be reused by the
  // next room the user enters — carrying host-only admin buttons (and a title
  // naming a player from the previous room) into a room they don't host.
  for (const li of rosterNodes.values()) li.remove();
  rosterNodes.clear();
}
