// ===========================================================================
// ui.js — imperative "chrome": screen switching, toasts, the network-status
// banner, and clipboard. Deliberately stateless about the game itself; render.js
// owns reflecting game state into the DOM.
// ===========================================================================

const $ = (id) => document.getElementById(id);

const SCREENS = ['home', 'join', 'lobby', 'game'];

export function showScreen(name) {
  for (const s of SCREENS) {
    const el = document.getElementById(`screen-${s}`);
    if (el) el.hidden = s !== name;
  }
  window.scrollTo({ top: 0 });
}

// --- toast ---------------------------------------------------------------
let toastTimer = null;
export function toast(message, ms = 2600) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  el.classList.add('toast--show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('toast--show');
    setTimeout(() => { el.hidden = true; }, 250);
  }, ms);
}

// --- network status banner ----------------------------------------------
// status: 'online' | 'connecting' | 'connected' | 'reconnecting' | 'hostgone'
const STATUS_TEXT = {
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  hostgone: 'Host left — game ended',
};

export function setNetStatus(status, { onRetry } = {}) {
  const bar = $('netbar');
  const text = $('netbar-text');
  const retry = $('netbar-retry');
  if (!bar) return;

  bar.classList.remove('netbar--ok', 'netbar--warn', 'netbar--bad');

  if (status === 'online' || status === 'connected') {
    // Briefly confirm, then hide.
    bar.classList.add('netbar--ok');
    text.textContent = 'Connected';
    retry.hidden = true;
    bar.hidden = false;
    clearTimeout(bar._t);
    bar._t = setTimeout(() => { bar.hidden = true; }, 1200);
    return;
  }

  clearTimeout(bar._t);
  bar.hidden = false;
  text.textContent = STATUS_TEXT[status] || 'Reconnecting…';

  if (status === 'hostgone') {
    bar.classList.add('netbar--bad');
    retry.hidden = false;
    retry.onclick = () => onRetry?.();
  } else {
    bar.classList.add('netbar--warn');
    retry.hidden = true;
  }
}

export function hideNetStatus() {
  const bar = $('netbar');
  if (bar) { clearTimeout(bar._t); bar.hidden = true; }
}

// --- clipboard -----------------------------------------------------------
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  // Fallback for non-secure contexts (plain http:// on the LAN).
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function $id(id) { return document.getElementById(id); }
