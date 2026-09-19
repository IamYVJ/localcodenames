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

// --- confirmation modal ---------------------------------------------------
// A promise-returning stand-in for window.confirm(). Two reasons it exists:
// the native dialog sits outside the app's visual language entirely, and — the
// part that actually matters — browsers let a user tick "prevent this page from
// creating more dialogs", after which window.confirm() returns false forever
// and every guarded action in the app silently stops working.
//
// Unlike the native call this does NOT freeze the page, so callers must assume
// the game state can move while the prompt is open. Re-check before acting.
let openConfirm = null;

export function confirm({
  title = 'Are you sure?',
  body = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
} = {}) {
  const box = $('confirm');
  // No modal in the document (a stripped-down embed?) — fail open rather than
  // hanging on a promise that can never settle.
  if (!box) return Promise.resolve(true);

  // A second prompt supersedes the first. Settle the old one as a cancel so its
  // caller isn't left awaiting forever.
  if (openConfirm) openConfirm.settle(false);

  const card = box.querySelector('.modal__card');
  const okBtn = $('confirm-ok');
  const cancelBtn = $('confirm-cancel');

  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  okBtn.textContent = confirmLabel;
  cancelBtn.textContent = cancelLabel;
  okBtn.classList.toggle('btn--danger', !!danger);
  okBtn.classList.toggle('btn--primary', !danger);
  card.classList.toggle('modal__card--danger', !!danger);

  const prevFocus = document.activeElement;
  box.hidden = false;

  return new Promise((resolve) => {
    const state = {
      settle(value) {
        if (openConfirm !== state) return; // already settled
        openConfirm = null;
        box.hidden = true;
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        box.removeEventListener('mousedown', onBackdrop);
        document.removeEventListener('keydown', onKey, true);
        try { prevFocus && prevFocus.focus && prevFocus.focus(); } catch { /* gone */ }
        resolve(value);
      },
    };

    const onOk = () => state.settle(true);
    const onCancel = () => state.settle(false);
    // Tapping the scrim cancels; taps inside the card must not.
    const onBackdrop = (e) => { if (e.target === box) state.settle(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); state.settle(false); return; }
      // Keep focus inside the dialog. Enter/Space are left alone so the focused
      // button activates natively.
      if (e.key !== 'Tab') return;
      const first = cancelBtn;
      const last = okBtn;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };

    openConfirm = state;
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    box.addEventListener('mousedown', onBackdrop);
    // Capture phase: the game screen binds its own key handlers, and a modal has
    // to swallow keys before they reach the board underneath it.
    document.addEventListener('keydown', onKey, true);

    // Destructive prompts focus Cancel, so a reflexive Enter is harmless.
    // Ordinary ones focus Confirm to keep a fast game loop fast.
    (danger ? cancelBtn : okBtn).focus();
  });
}

// Drop any open prompt — used when the room goes away underneath the player.
export function closeConfirm() {
  if (openConfirm) openConfirm.settle(false);
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
