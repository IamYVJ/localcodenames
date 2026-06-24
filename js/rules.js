// ===========================================================================
// rules.js — game rules + authoritative state machine (host-side).
//
// This module is pure logic: it owns the canonical state shape, the deal,
// clue validation, guess resolution, and win/lose detection. It also derives
// the per-recipient "view" so the hidden key card is only ever placed in a
// Spymaster's payload — never in an Operative's.
//
// All mutators take the authoritative `state` and return
// { ok, error?, warning? } so the host can decide whether to broadcast.
// ===========================================================================

import {
  KEY_DISTRIBUTION, BOARD_SIZE, EXTRA_GUESS, UNLIMITED, CARD, TEAMS, REQUIRED,
} from './config.js';
import { WORD_LIST } from './words.js';

// --- small utilities -----------------------------------------------------

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function otherTeam(team) {
  return team === 'red' ? 'blue' : 'red';
}

// --- fresh state ---------------------------------------------------------

export function createInitialState(roomCode, hostSeatId) {
  return {
    v: 1,
    phase: 'lobby', // 'lobby' | 'playing' | 'gameover'
    roomCode,
    hostSeatId,
    nextSeat: 1,
    seats: {}, // token -> seat
    game: null,
  };
}

export function makeSeat(state, { token, name }) {
  const seatId = `p${state.nextSeat++}`;
  const seat = {
    token,
    seatId,
    name,
    team: null, // 'red' | 'blue' | null (unassigned)
    role: 'operative', // 'spymaster' | 'operative'
    connected: true,
    lastSeen: Date.now(),
  };
  state.seats[token] = seat;
  return seat;
}

// --- dealing -------------------------------------------------------------

export function dealGame(state) {
  const words = shuffle(WORD_LIST).slice(0, BOARD_SIZE);

  // The team with 9 agents goes first; pick it at random.
  const startingTeam = Math.random() < 0.5 ? 'red' : 'blue';
  const second = otherTeam(startingTeam);

  const categories = [];
  for (let i = 0; i < KEY_DISTRIBUTION.firstTeamAgents; i++) categories.push(startingTeam);
  for (let i = 0; i < KEY_DISTRIBUTION.secondTeamAgents; i++) categories.push(second);
  for (let i = 0; i < KEY_DISTRIBUTION.neutral; i++) categories.push(CARD.NEUTRAL);
  for (let i = 0; i < KEY_DISTRIBUTION.assassin; i++) categories.push(CARD.ASSASSIN);

  const key = shuffle(categories); // length === BOARD_SIZE

  state.game = {
    words,
    key,
    revealed: new Array(BOARD_SIZE).fill(false),
    startingTeam,
    turn: startingTeam,
    clue: null, // { word, count }  count: integer | UNLIMITED
    guessesUsed: 0,
    guessesAllowed: null, // null until a clue is given; integer | UNLIMITED
    winner: null,
    endedByAssassin: false,
    lastEvent: `Game on. ${cap(startingTeam)} team goes first.`,
  };
  state.phase = 'playing';
  return state;
}

// --- composition validation ---------------------------------------------

export function teamComposition(state) {
  const out = {
    red: { spymasters: 0, operatives: 0 },
    blue: { spymasters: 0, operatives: 0 },
    unassigned: 0,
  };
  for (const seat of Object.values(state.seats)) {
    if (seat.team !== 'red' && seat.team !== 'blue') { out.unassigned++; continue; }
    if (seat.role === 'spymaster') out[seat.team].spymasters++;
    else out[seat.team].operatives++;
  }
  return out;
}

export function canStart(state) {
  const c = teamComposition(state);
  const problems = [];
  for (const team of TEAMS) {
    if (c[team].spymasters !== REQUIRED.spymastersPerTeam) {
      problems.push(`${cap(team)} needs exactly ${REQUIRED.spymastersPerTeam} Spymaster.`);
    }
    if (c[team].operatives < REQUIRED.minOperativesPerTeam) {
      problems.push(`${cap(team)} needs at least ${REQUIRED.minOperativesPerTeam} Operative.`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// --- lobby mutations -----------------------------------------------------

export function setTeam(state, token, team) {
  const seat = state.seats[token];
  if (!seat) return { ok: false, error: 'No such seat.' };
  if (state.phase !== 'lobby') return { ok: false, error: 'Teams are locked once the game starts.' };
  if (team !== 'red' && team !== 'blue' && team !== null) return { ok: false, error: 'Bad team.' };
  seat.team = team;
  // Leaving a team also drops the Spymaster role to avoid orphaned masters.
  if (team === null) seat.role = 'operative';
  return { ok: true };
}

export function setRole(state, token, role) {
  const seat = state.seats[token];
  if (!seat) return { ok: false, error: 'No such seat.' };
  if (state.phase !== 'lobby') return { ok: false, error: 'Roles are locked once the game starts.' };
  if (role !== 'spymaster' && role !== 'operative') return { ok: false, error: 'Bad role.' };
  if (role === 'spymaster') {
    if (!seat.team) return { ok: false, error: 'Pick a team before becoming Spymaster.' };
    // Only one Spymaster per team — demote any existing one.
    for (const s of Object.values(state.seats)) {
      if (s.team === seat.team && s.role === 'spymaster' && s.token !== token) {
        s.role = 'operative';
      }
    }
  }
  seat.role = role;
  return { ok: true };
}

// --- clue ----------------------------------------------------------------

export function validateClue(game, board, { word, count }) {
  const w = String(word ?? '').trim();
  if (!w) return { ok: false, error: 'Clue word is required.' };
  if (/\s/.test(w)) return { ok: false, error: 'Clue must be a single word (no spaces).' };

  let normCount = count;
  if (count !== UNLIMITED) {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, error: 'Clue number must be 0 or a positive whole number.' };
    }
    normCount = n;
  }

  // Soft warning only: clue duplicates a word still on the board.
  let warning = null;
  if (board && board.words) {
    const hit = board.words.some(
      (bw, i) => !board.revealed[i] && bw.toLowerCase() === w.toLowerCase(),
    );
    if (hit) warning = 'That clue matches a word still on the board.';
  }
  return { ok: true, word: w, count: normCount, warning };
}

export function giveClue(state, token, payload) {
  const seat = state.seats[token];
  const game = state.game;
  if (state.phase !== 'playing' || !game) return { ok: false, error: 'No active game.' };
  if (!seat || seat.role !== 'spymaster') return { ok: false, error: 'Only a Spymaster may give a clue.' };
  if (seat.team !== game.turn) return { ok: false, error: 'It is not your team\'s turn.' };
  if (game.clue) return { ok: false, error: 'A clue has already been given this turn.' };

  const v = validateClue(game, game, payload);
  if (!v.ok) return v;

  game.clue = { word: v.word, count: v.count };
  game.guessesUsed = 0;
  // Clue 0 or ∞ => unlimited guesses this turn. Otherwise number + 1.
  game.guessesAllowed = (v.count === UNLIMITED || v.count === 0) ? UNLIMITED : v.count + EXTRA_GUESS;
  const shown = v.count === UNLIMITED ? '∞' : v.count;
  game.lastEvent = `${cap(seat.team)} Spymaster's clue: ${v.word.toUpperCase()} ${shown}.`;
  return { ok: true, warning: v.warning };
}

// --- guessing ------------------------------------------------------------

function agentsRemaining(game, team) {
  let n = 0;
  for (let i = 0; i < game.key.length; i++) {
    if (game.key[i] === team && !game.revealed[i]) n++;
  }
  return n;
}

export function countsRemaining(game) {
  return { red: agentsRemaining(game, 'red'), blue: agentsRemaining(game, 'blue') };
}

function endTurnInternal(game) {
  game.turn = otherTeam(game.turn);
  game.clue = null;
  game.guessesUsed = 0;
  game.guessesAllowed = null;
}

function finishGame(state, winner, byAssassin) {
  state.game.winner = winner;
  state.game.endedByAssassin = byAssassin;
  state.phase = 'gameover';
}

export function guess(state, token, index) {
  const seat = state.seats[token];
  const game = state.game;
  if (state.phase !== 'playing' || !game) return { ok: false, error: 'No active game.' };
  if (!seat || seat.role !== 'operative') return { ok: false, error: 'Only an Operative may guess.' };
  if (seat.team !== game.turn) return { ok: false, error: 'It is not your team\'s turn.' };
  if (!game.clue) return { ok: false, error: 'Wait for your Spymaster\'s clue.' };
  if (typeof index !== 'number' || index < 0 || index >= BOARD_SIZE) {
    return { ok: false, error: 'Bad card.' };
  }
  if (game.revealed[index]) return { ok: false, error: 'That card is already revealed.' };
  if (game.guessesAllowed !== UNLIMITED && game.guessesUsed >= game.guessesAllowed) {
    return { ok: false, error: 'No guesses left this turn.' };
  }

  game.revealed[index] = true;
  game.guessesUsed += 1;
  const color = game.key[index];
  const word = game.words[index].toUpperCase();
  const team = game.turn;

  // Assassin → immediate loss for the guessing team.
  if (color === CARD.ASSASSIN) {
    game.lastEvent = `${cap(team)} revealed the ASSASSIN — ${word}. ${cap(otherTeam(team))} wins!`;
    finishGame(state, otherTeam(team), true);
    return { ok: true };
  }

  // Did this reveal complete a team's whole set of agents?
  if (color === 'red' || color === 'blue') {
    if (agentsRemaining(game, color) === 0) {
      game.lastEvent = `${cap(team)} revealed ${word} (${cap(color)}). ${cap(color)} wins!`;
      finishGame(state, color, false);
      return { ok: true };
    }
  }

  if (color === team) {
    // Correct guess — may keep going.
    game.lastEvent = `${cap(team)} revealed ${word} — a ${cap(team)} agent. Keep going.`;
    if (game.guessesAllowed !== UNLIMITED && game.guessesUsed >= game.guessesAllowed) {
      game.lastEvent = `${cap(team)} revealed ${word} — a ${cap(team)} agent. No guesses left; turn passes.`;
      endTurnInternal(game);
    }
    return { ok: true };
  }

  if (color === CARD.NEUTRAL) {
    game.lastEvent = `${cap(team)} revealed ${word} — a bystander. Turn passes.`;
    endTurnInternal(game);
    return { ok: true };
  }

  // Must be the OTHER team's agent: it helps them; turn passes.
  game.lastEvent = `${cap(team)} revealed ${word} — a ${cap(color)} agent. Turn passes.`;
  endTurnInternal(game);
  return { ok: true };
}

export function endTurn(state, token) {
  const seat = state.seats[token];
  const game = state.game;
  if (state.phase !== 'playing' || !game) return { ok: false, error: 'No active game.' };
  if (!seat || seat.role !== 'operative') return { ok: false, error: 'Only an Operative may end the turn.' };
  if (seat.team !== game.turn) return { ok: false, error: 'It is not your team\'s turn.' };
  if (!game.clue) return { ok: false, error: 'Wait for your Spymaster\'s clue.' };
  game.lastEvent = `${cap(seat.team)} ended their turn.`;
  endTurnInternal(game);
  return { ok: true };
}

// --- restart -------------------------------------------------------------

export function playAgain(state) {
  // Re-deal, keep everyone's seats/teams/roles.
  dealGame(state);
  return { ok: true };
}

export function newGame(state) {
  // Back to the lobby; keep the roster so teams can be re-shuffled.
  state.game = null;
  state.phase = 'lobby';
  return { ok: true };
}

// --- views (what each recipient is allowed to see) -----------------------

// Roster without secrets (no tokens).
function publicRoster(state) {
  return Object.values(state.seats).map((s) => ({
    seatId: s.seatId,
    name: s.name,
    team: s.team,
    role: s.role,
    connected: s.connected,
    isHost: s.seatId === state.hostSeatId,
  }));
}

// Public game projection. Card colors are exposed ONLY for revealed cards
// (or all cards once the game is over).
function publicGame(state) {
  const g = state.game;
  if (!g) return null;
  const over = state.phase === 'gameover';
  const colors = g.key.map((c, i) => (g.revealed[i] || over ? c : null));
  const counts = countsRemaining(g);
  return {
    words: g.words,
    revealed: g.revealed.slice(),
    colors, // null where still hidden (operative-safe)
    startingTeam: g.startingTeam,
    turn: g.turn,
    clue: g.clue,
    guessesUsed: g.guessesUsed,
    guessesAllowed: g.guessesAllowed, // integer | UNLIMITED | null
    winner: g.winner,
    endedByAssassin: g.endedByAssassin,
    counts,
    fullKeyRevealed: over,
    lastEvent: g.lastEvent,
  };
}

// Build the exact message payload a given seat is entitled to receive.
// The hidden key is attached ONLY for Spymasters (and only while playing —
// once the game is over the full key is public anyway via publicGame()).
export function viewFor(state, token) {
  const seat = state.seats[token];
  const view = {
    phase: state.phase,
    roomCode: state.roomCode,
    hostSeatId: state.hostSeatId,
    roster: publicRoster(state),
    game: publicGame(state),
    composition: teamComposition(state),
    canStart: canStart(state),
    you: seat ? {
      seatId: seat.seatId,
      name: seat.name,
      team: seat.team,
      role: seat.role,
      connected: seat.connected,
      isHost: seat.seatId === state.hostSeatId,
    } : null,
  };
  if (seat && seat.role === 'spymaster' && state.game && state.phase === 'playing') {
    view.key = state.game.key.slice(); // entitled private view
  }
  return view;
}

// --- helpers exported for callers ---------------------------------------

export function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
