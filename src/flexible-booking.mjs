import { submitBooking, verifySubmittedBookings } from './booking-submit.mjs';
import { readRemoteBookings } from './remote-bookings.mjs';
import { reloadTargetGrid } from './opening-watch.mjs';
import { maskGrid, planContinuation, planFlexibleBooking, segmentsOverlap, toMinutes } from './flexible-plan.mjs';
import { normalizedParticipantSet } from './booking-intent.mjs';
import { listDateIntentFences, reconcileIntentFence } from './intent-fence.mjs';
import { peakWindowForDate } from './peak-time.mjs';

export const FLEXIBLE_MAX_SEGMENTS = 2;
const MAX_FLEXIBLE_ATTEMPTS = 10;
const RETRYABLE_CODES = new Set(['pre_confirm_failed', 'slot_not_actionable']);

function deadlinePassed(deadline, now) {
  return !Number.isFinite(deadline) || now() > deadline;
}

/** The latest time a weekend/weekday booking may end without crossing into the peak window. */
export function flexibleLatestEnd(job) {
  const peak = peakWindowForDate(job.date);
  return toMinutes(job.end) <= toMinutes(peak.start) ? peak.start : '23:30';
}

function sameParticipants(left, right) {
  try {
    return JSON.stringify(normalizedParticipantSet(left)) === JSON.stringify(normalizedParticipantSet(right));
  } catch {
    return false;
  }
}

/** Remote bookings by the same people on the job date that overlap the flexible search range. */
export function ownBookingsInRange(records, job, latestEnd = flexibleLatestEnd(job)) {
  const range = { start: job.start, end: latestEnd };
  return (records || []).filter((record) => record?.date === job.date
    && String(record.bookingType || '').trim() === job.bookingType
    && sameParticipants(record.participants, job.participants)
    && /^\d{2}:\d{2}$/.test(record.start || '') && /^\d{2}:\d{2}$/.test(record.end || '')
    && segmentsOverlap(record, range));
}

/**
 * Before any new flexible submission: resolve fences left by an earlier attempt for this
 * date and refuse to book again when these participants already hold time in the range.
 */
export async function existingFlexibleBookings({ job, read, listFences = listDateIntentFences, reconcile = reconcileIntentFence }) {
  const fences = await listFences({ date: job.date });
  for (const fence of fences) {
    const segmentJob = { ...job, start: fence.segment.start, end: fence.segment.end };
    const outcome = await reconcile({ job: segmentJob, read });
    if (outcome.state === 'blocked') {
      throw new Error('Booking intent requires authenticated reconciliation before any new submission');
    }
  }
  return ownBookingsInRange(await read(), job);
}

/**
 * Books up to FLEXIBLE_MAX_SEGMENTS contiguous bookings that best cover job.start–job.end,
 * following planFlexibleBooking's preference order. Every submission re-reads the grid
 * first. Remote verification of all submitted bookings happens at the end so the second
 * booking is not delayed by the first one's calendar check.
 */
export async function submitFlexiblePlan({
  context,
  opening,
  job,
  deadline,
  now = () => Date.now(),
  priorBookings = null,
  latestEnd = flexibleLatestEnd(job),
  maxSegments = FLEXIBLE_MAX_SEGMENTS,
  submit = submitBooking,
  read = readRemoteBookings,
  verifyAll = verifySubmittedBookings,
  reload = reloadTargetGrid,
  log = () => {},
  mark = () => {},
}) {
  const page = opening.page;
  let { grid, gridRoot } = opening;
  const windowMinutes = toMinutes(job.end) - toMinutes(job.start);
  const booked = [];
  const failures = new Map();
  const blocked = [];
  let lastError = null;
  let tier = null;
  const bookedMinutes = () => booked.reduce((total, item) => total + toMinutes(item.segment.end) - toMinutes(item.segment.start), 0);

  for (let attempt = 1; attempt <= MAX_FLEXIBLE_ATTEMPTS; attempt += 1) {
    if (deadlinePassed(deadline, now)) {
      if (booked.length) break;
      throw new Error('latest start deadline has passed');
    }
    const usable = maskGrid(grid, blocked);
    let next;
    if (!booked.length) {
      const plan = planFlexibleBooking(usable, {
        windowStart: job.start, windowEnd: job.end, latestEnd, courtOrder: job.courtOrder, maxSegments,
      });
      if (!plan) {
        const reason = `No available court time on ${job.date} from ${job.start} before ${latestEnd}`;
        throw new Error(lastError ? `${reason}; previous attempt: ${lastError.message}` : reason);
      }
      tier = plan.tier;
      next = plan.segments[0];
      log({ status: 'flexible_plan', tier: plan.tier, segments: plan.segments });
    } else {
      next = planContinuation(usable, {
        from: booked.at(-1).segment.end, remainingMinutes: windowMinutes - bookedMinutes(), latestEnd, courtOrder: job.courtOrder,
      });
      if (!next) break;
    }

    const segmentJob = { ...job, start: next.start, end: next.end };
    try {
      const outcome = await submit({
        context, page, job: segmentJob, grid, gridRoot, court: next.court, priorBookings, deferVerification: true, mark, read,
        assertDeadline: () => { if (deadlinePassed(deadline, now)) throw new Error('latest start deadline has passed'); },
      });
      booked.push({ segment: next, job: segmentJob, outcome });
      log({ status: 'segment_submitted', ...next });
    } catch (error) {
      if (!RETRYABLE_CODES.has(error?.code)) {
        // Never lose an already-submitted booking: stop adding more and verify what exists.
        if (booked.length) { lastError = error; break; }
        throw error;
      }
      lastError = error;
      const key = `${next.court}|${next.start}|${next.end}`;
      const count = (failures.get(key) || 0) + 1;
      failures.set(key, count);
      if (count >= 2) blocked.push(next);
      log({ status: 'segment_attempt_failed', ...next, attempt, error: String(error.message).slice(0, 300) });
    }

    if (booked.length && (booked.length >= maxSegments || bookedMinutes() >= windowMinutes)) break;
    if (booked.length && deadlinePassed(deadline, now)) break;
    try {
      ({ grid, gridRoot } = await reload({ page, date: job.date }));
    } catch (error) {
      if (booked.length) { lastError = error; break; }
      throw error;
    }
  }

  if (!booked.length) throw lastError || new Error('Flexible booking attempts exhausted');

  // One remote read verifies every submitted booking.
  const results = await verifyAll({ pendings: booked.map((item) => item.outcome.pending), read });
  const segments = [];
  const unverified = [];
  booked.forEach((item, index) => {
    const result = results[index];
    if (result?.ok) segments.push({ ...item.segment, paymentStatus: result.paymentStatus, remoteBookingId: result.remoteBookingId || null });
    else unverified.push({ ...item.segment, error: String(result?.error || 'unverified').slice(0, 200) });
  });
  return {
    tier,
    segments,
    unverified,
    minutes: segments.reduce((total, item) => total + toMinutes(item.end) - toMinutes(item.start), 0),
    incompleteReason: lastError ? String(lastError.message).slice(0, 300) : null,
  };
}
