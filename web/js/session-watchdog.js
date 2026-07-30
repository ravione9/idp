/**
 * Client-side idle / absolute session timeout.
 * Server still enforces; this logs out when the tab sits idle without API traffic.
 */
import { api } from './api.js';

let idleTimer = null;
let absoluteTimer = null;
let started = false;
let idleMs = 8 * 3600_000;

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'];

function clearTimers() {
  if (idleTimer) clearTimeout(idleTimer);
  if (absoluteTimer) clearTimeout(absoluteTimer);
  idleTimer = null;
  absoluteTimer = null;
}

async function forceLogout(reason) {
  clearTimers();
  started = false;
  ACTIVITY_EVENTS.forEach((ev) => window.removeEventListener(ev, onActivity, { capture: true }));
  try { await api.logout(); } catch { /* ignore */ }
  const q = new URLSearchParams({ reason: reason || 'timeout' });
  location.href = `/login?${q}`;
}

function armIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => forceLogout('idle'), idleMs);
}

function onActivity() {
  armIdle();
}

/**
 * @param {object} me — /api/me payload
 */
export function startSessionWatchdog(me) {
  if (started || !me?.session) return;
  started = true;

  const idleHours = Number(me.session.idleTimeoutHours) || 8;
  const absoluteHours = Number(me.session.absoluteTimeoutHours) || Math.max(idleHours, 24);
  idleMs = Math.max(60_000, idleHours * 3600_000); // floor 1 min for sanity

  ACTIVITY_EVENTS.forEach((ev) =>
    window.addEventListener(ev, onActivity, { capture: true, passive: true }),
  );
  armIdle();

  const createdAt = me.session.createdAt ? new Date(me.session.createdAt).getTime() : Date.now();
  const absoluteDeadline = createdAt + absoluteHours * 3600_000;
  const absRemain = absoluteDeadline - Date.now();
  if (absRemain <= 0) {
    forceLogout('absolute');
    return;
  }
  absoluteTimer = setTimeout(() => forceLogout('absolute'), absRemain);
}
