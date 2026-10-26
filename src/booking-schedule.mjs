import { openingInstantForTargetDate } from './opening-window.mjs';

const PREWARM_MS = 3 * 60_000;
const LATEST_START_GRACE_MS = 5 * 60_000;

export function planBookingRun(targetDate, {
  nowMs = Date.now(),
  prewarmMs = PREWARM_MS,
  latestStartGraceMs = LATEST_START_GRACE_MS,
} = {}) {
  if (!Number.isFinite(nowMs)) throw new Error('nowMs must be a finite timestamp');
  if (!Number.isFinite(prewarmMs) || prewarmMs < 0) throw new Error('prewarmMs must be non-negative');
  if (!Number.isFinite(latestStartGraceMs) || latestStartGraceMs <= 0) {
    throw new Error('latestStartGraceMs must be positive');
  }

  const openAtMs = openingInstantForTargetDate(targetDate);
  if (nowMs < openAtMs) {
    return {
      action: 'schedule',
      openAtMs,
      prepareAtMs: openAtMs - prewarmMs,
      latestStartMs: openAtMs + latestStartGraceMs,
    };
  }

  return {
    action: 'execute_now',
    openAtMs,
    prepareAtMs: null,
    latestStartMs: nowMs + latestStartGraceMs,
  };
}

export { PREWARM_MS, LATEST_START_GRACE_MS };
