// ===========================================================================
// wakelock.js — hold the Screen Wake Lock while a room is open.
//
// A locked screen is the single biggest cause of dropped games: the OS freezes
// the page, the WebRTC data channel dies silently, and the player comes back to
// a stalled board. Keeping the screen awake while someone is actually in a room
// avoids most of that; net.js handles the drops we can't prevent.
//
// The lock is a best-effort nicety, not a guarantee:
//   * Unsupported on Firefox and iOS Safari before 16.4 — no-ops there.
//   * The OS revokes it whenever the page is hidden, so we re-take it on
//     every return to visible.
//   * It can be refused outright (low battery), which is not an error.
// ===========================================================================

let lock = null;
// What the app wants, independent of what the OS has granted us right now.
let wanted = false;

export function keepAwake(on) {
  wanted = !!on;
  if (wanted) acquire();
  else release();
}

export function isHeld() {
  return !!lock;
}

function acquire() {
  if (!wanted || lock) return;
  if (!('wakeLock' in navigator)) return;
  // Requesting while hidden always rejects, and we re-request on visibility.
  if (document.visibilityState !== 'visible') return;
  navigator.wakeLock.request('screen').then((l) => {
    // keepAwake(false) may have landed while the request was in flight.
    if (!wanted) { try { l.release(); } catch { /* ignore */ } return; }
    lock = l;
    // Fires on OS revocation too, so this is the one place lock is cleared.
    l.addEventListener('release', () => { lock = null; });
  }).catch(() => { lock = null; });
}

function release() {
  const l = lock;
  lock = null;
  // release() is async: swallow the promise too, or a revoked lock surfaces as
  // an unhandled rejection.
  try { l?.release()?.catch(() => {}); } catch { /* ignore */ }
}

// The OS drops the lock every time the page is hidden — take it back on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') acquire();
});
