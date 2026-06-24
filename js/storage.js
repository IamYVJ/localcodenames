// ===========================================================================
// storage.js — thin localStorage layer.
// Persists: display name, per-room client identity (token/name/team/role used
// for seamless reconnect), and the host's full authoritative game-state
// snapshot (so a host page reload resumes the same game on the same room ID).
// ===========================================================================

import { LS } from './config.js';

function read(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full / disabled — non-fatal */
  }
}

function remove(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

// --- display name --------------------------------------------------------
export function getName() {
  return read(LS.displayName, '');
}
export function setName(name) {
  write(LS.displayName, name);
}

// --- per-room client identity (for reconnect-by-token) -------------------
// Shape: { token, name, team, role }
export function getSeat(roomCode) {
  if (!roomCode) return null;
  return read(LS.seatPrefix + roomCode, null);
}
export function setSeat(roomCode, seat) {
  write(LS.seatPrefix + roomCode, seat);
}
export function clearSeat(roomCode) {
  remove(LS.seatPrefix + roomCode);
}

// --- host authoritative game-state snapshot ------------------------------
export function getHostState(roomCode) {
  return read(LS.hostPrefix + roomCode, null);
}
export function setHostState(roomCode, state) {
  write(LS.hostPrefix + roomCode, state);
}
export function clearHostState(roomCode) {
  remove(LS.hostPrefix + roomCode);
}

// Which room this device last hosted (used to offer "resume" on reload).
export function getLastHostRoom() {
  return read(LS.lastHostRoom, null);
}
export function setLastHostRoom(roomCode) {
  write(LS.lastHostRoom, roomCode);
}
export function clearLastHostRoom() {
  remove(LS.lastHostRoom);
}

// --- ids -----------------------------------------------------------------
export function uuid() {
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Fallback UUIDv4.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
