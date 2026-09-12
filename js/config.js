// ===========================================================================
// config.js — single source of truth for every tunable constant.
// Rule constants (card distribution, max-guess rule), networking/broker
// config, palette, and room-code charset all live here on purpose.
// ===========================================================================

// --- Networking / signaling broker --------------------------------------
//
// PeerJS performs the WebRTC handshake through a small "broker" (signaling)
// server. With the default config below, PeerJS uses its free public cloud
// broker at 0.peerjs.com. That broker is ONLY needed to set up the
// connection — once two peers have shaken hands, all game traffic flows
// directly peer-to-peer over the LAN, so it keeps working with no internet.
//
// FOR FULLY-OFFLINE LAN PLAY (no internet at all), run your own PeerServer
// on the host machine or any device on the LAN:
//
//     npx peerjs --port 9000 --key peerjs --path /codenames
//
// then point this constant at it (use the host's LAN IP):
//
//     export const PEER_BROKER = {
//       host: '192.168.1.50', port: 9000, path: '/codenames', secure: false,
//     };
//
// Leaving it as an empty object uses the public cloud broker.
export const PEER_BROKER = {
  // Empty => PeerJS public cloud broker (0.peerjs.com). See note above.
  // Bump connection reliability a little:
  debug: 1,
};

// Every room maps deterministically to a Peer ID so joiners can reconstruct
// the host's ID from just the room code — no discovery service needed.
export const ROOM_ID_PREFIX = 'codenames-';

// --- Room code -----------------------------------------------------------
// Short, human-friendly, tappable. Ambiguous glyphs (O/0/I/1) removed.
export const ROOM_CODE_LENGTH = 4;
export const ROOM_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// --- Reconnection behaviour ---------------------------------------------
export const RECONNECT = {
  // Backoff schedule (ms) for a client trying to re-reach the host.
  baseDelayMs: 800,
  maxDelayMs: 8000,
  // How long (ms) the host keeps a dropped player as "reconnecting" before
  // relabelling them "offline". Their seat/turn is NEVER given away on a
  // transient drop — this only affects the roster label.
  graceMs: 45000,
  // Heartbeat so we notice silent drops quickly.
  heartbeatMs: 5000,
};

// --- Game rules (the exact Codenames distribution) -----------------------
// 9 + 8 + 7 + 1 = 25. The team with 9 agents goes first.
export const KEY_DISTRIBUTION = {
  firstTeamAgents: 9,
  secondTeamAgents: 8,
  neutral: 7,
  assassin: 1,
};
export const BOARD_SIZE = 25; // 5 x 5
export const GRID_COLS = 5;

// A team may guess up to (clue number + 1) times. Clue 0 or unlimited (∞)
// grants effectively unlimited guesses for that turn.
export const EXTRA_GUESS = 1;
export const UNLIMITED = 'inf'; // sentinel for the ∞ clue option

// --- Turn timer ----------------------------------------------------------
// Off by default; the host turns it on in the lobby. Two separate clocks: one
// while the Spymaster composes a clue, one while their Operatives guess.
// `presets` drives the lobby buttons, so adding a length here is enough.
export const TIMER = {
  defaultEnabled: false,
  clueSeconds: 60,
  guessSeconds: 60,
  presets: [60, 120, 240, 300],
};

// Team composition required before a game may start.
export const REQUIRED = {
  spymastersPerTeam: 1,
  minOperativesPerTeam: 1,
};

// --- Card categories -----------------------------------------------------
export const CARD = {
  RED: 'red',
  BLUE: 'blue',
  NEUTRAL: 'neutral',
  ASSASSIN: 'assassin',
};

export const TEAMS = ['red', 'blue'];
export const ROLES = ['spymaster', 'operative'];

// --- Persistence keys ----------------------------------------------------
export const LS = {
  displayName: 'cn.name',
  // Per-room client identity: cn.seat.<ROOM> => {token, name, team, role}
  seatPrefix: 'cn.seat.',
  // Host authoritative game state snapshot: cn.host.<ROOM> => full state
  hostPrefix: 'cn.host.',
  // The room the host last hosted (for reload restore).
  lastHostRoom: 'cn.lastHostRoom',
};
