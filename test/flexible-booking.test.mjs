import test from 'node:test';
import assert from 'node:assert/strict';
import { planFlexibleBooking, planContinuation, maskGrid } from '../src/flexible-plan.mjs';
import { submitFlexiblePlan, ownBookingsInRange, flexibleLatestEnd, existingFlexibleBookings } from '../src/flexible-booking.mjs';
import { PreConfirmBookingError } from '../src/booking-submit.mjs';

const COURTS = ['Court 1', 'Court 2', 'Court 3', 'Court 4', 'Court 5', 'Court 6'];
const ORDER = ['Court 4', 'Court 5', 'Court 6', 'Court 1', 'Court 2', 'Court 3'];
const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

function makeGrid(free) {
  return COURTS.map((court) => ({
    court,
    slots: Array.from({ length: 48 }, (_, index) => {
      const start = index * 30;
      const available = (free[court] || []).some(([from, to]) => start >= mins(from) && start < mins(to));
      return { start: fmt(start), end: fmt(start + 30), available };
    }),
  }));
}

const window = { windowStart: '08:00', windowEnd: '10:00', latestEnd: '13:00', courtOrder: ORDER };

test('books one court for the whole window, honouring court priority', () => {
  const plan = planFlexibleBooking(makeGrid({ 'Court 1': [['08:00', '10:00']], 'Court 5': [['08:00', '10:00']] }), window);
  assert.equal(plan.tier, 'full_window');
  assert.deepEqual(plan.segments, [{ court: 'Court 5', start: '08:00', end: '10:00' }]);
});

test('prefers one lower-priority court over switching courts', () => {
  const plan = planFlexibleBooking(makeGrid({
    'Court 4': [['08:00', '09:00']], 'Court 5': [['09:00', '10:00']], 'Court 2': [['08:00', '10:00']],
  }), window);
  assert.deepEqual(plan.segments, [{ court: 'Court 2', start: '08:00', end: '10:00' }]);
});

test('covers the window with two courts when no single court is free throughout', () => {
  const plan = planFlexibleBooking(makeGrid({ 'Court 4': [['08:00', '09:00']], 'Court 5': [['08:30', '10:00']] }), window);
  assert.equal(plan.tier, 'full_window');
  assert.deepEqual(plan.segments, [
    { court: 'Court 4', start: '08:00', end: '09:00' },
    { court: 'Court 5', start: '09:00', end: '10:00' },
  ]);
});

test('never uses more than two bookings', () => {
  const plan = planFlexibleBooking(makeGrid({
    'Court 4': [['08:00', '08:30']], 'Court 5': [['08:30', '09:00']], 'Court 6': [['09:00', '10:00']],
  }), window);
  assert.equal(plan.segments.length, 2);
  assert.equal(plan.tier, 'longest_from_start');
  assert.equal(plan.minutes, 60);
});

test('books the longest time from 08:00 even when it is under 1.5 hours', () => {
  const plan = planFlexibleBooking(makeGrid({ 'Court 1': [['08:00', '09:00']], 'Court 3': [['09:30', '12:00']] }), window);
  assert.equal(plan.tier, 'longest_from_start');
  assert.deepEqual(plan.segments, [{ court: 'Court 1', start: '08:00', end: '09:00' }]);
});

test('when 08:00 is fully taken, looks later and prefers a full two hours', () => {
  const plan = planFlexibleBooking(makeGrid({ 'Court 2': [['08:30', '10:00']], 'Court 3': [['09:00', '11:00']] }), window);
  assert.equal(plan.tier, 'later_start');
  assert.deepEqual(plan.segments, [{ court: 'Court 3', start: '09:00', end: '11:00' }]);
});

test('a later start never crosses the 13:00 weekend peak', () => {
  const plan = planFlexibleBooking(makeGrid({ 'Court 6': [['11:30', '15:00']] }), window);
  assert.deepEqual(plan.segments, [{ court: 'Court 6', start: '11:30', end: '13:00' }]);
});

test('returns null when nothing is free before the peak', () => {
  assert.equal(planFlexibleBooking(makeGrid({ 'Court 6': [['13:00', '15:00']] }), window), null);
});

test('14 Nov real availability: Court 6 was free for the whole 08:00–10:00', () => {
  const grid = makeGrid({
    'Court 1': [['04:00', '09:30']], 'Court 2': [['04:00', '09:30']], 'Court 3': [['04:00', '07:00'], ['09:00', '09:30']],
    'Court 4': [['04:00', '09:30']], 'Court 5': [['04:00', '09:00']], 'Court 6': [['04:00', '17:00']],
  });
  assert.deepEqual(planFlexibleBooking(grid, window).segments, [{ court: 'Court 6', start: '08:00', end: '10:00' }]);
});

test('continuation books from the exact end of the first booking', () => {
  const next = planContinuation(makeGrid({ 'Court 5': [['09:00', '12:00']], 'Court 4': [['09:30', '10:00']] }), {
    from: '09:00', remainingMinutes: 60, latestEnd: '13:00', courtOrder: ORDER,
  });
  assert.deepEqual(next, { court: 'Court 5', start: '09:00', end: '10:00' });
});

test('masking removes repeatedly failing slots from planning', () => {
  const grid = maskGrid(makeGrid({ 'Court 4': [['08:00', '10:00']], 'Court 5': [['08:00', '10:00']] }), [{ court: 'Court 4', start: '08:00', end: '10:00' }]);
  assert.equal(planFlexibleBooking(grid, window).segments[0].court, 'Court 5');
});

test('weekend latest end is the 13:00 peak start', () => {
  assert.equal(flexibleLatestEnd({ date: '2026-11-21', end: '10:00' }), '13:00');
});

const job = {
  id: '2026-11-21-0800', date: '2026-11-21', start: '08:00', end: '10:00', bookingType: 'Stadium Pass - Singles',
  participants: ['Yufei Liu', 'Zijia Liu'], courtOrder: ORDER, flexible: true,
};

function harness({ grids, submitBehaviour = () => {} }) {
  const calls = [];
  let gridIndex = 0;
  return {
    calls,
    options: {
      context: {}, job, deadline: 1_000_000, now: () => 0, priorBookings: [],
      opening: { page: {}, grid: grids[0], gridRoot: 'root' },
      submit: async ({ job: segmentJob, court, deferVerification, priorBookings }) => {
        assert.equal(deferVerification, true);
        assert.deepEqual(priorBookings, []);
        calls.push(`submit ${court} ${segmentJob.start}-${segmentJob.end}`);
        submitBehaviour({ court, start: segmentJob.start, end: segmentJob.end });
        return { court, paymentStatus: 'unpaid_hold', pending: { court, start: segmentJob.start } };
      },
      read: async () => [],
      verifyAll: async ({ pendings }) => pendings.map((pending) => {
        calls.push(`verify ${pending.court} ${pending.start}`);
        return { ok: true, paymentStatus: 'unpaid_hold', remoteBookingId: `id-${pending.court}` };
      }),
      reload: async () => {
        gridIndex = Math.min(gridIndex + 1, grids.length - 1);
        calls.push('reload');
        return { grid: grids[gridIndex], gridRoot: 'root' };
      },
    },
  };
}

test('submits both bookings back to back and verifies them only afterwards', async () => {
  const first = makeGrid({ 'Court 4': [['08:00', '09:00']], 'Court 5': [['08:30', '10:00']] });
  const afterFirst = makeGrid({ 'Court 5': [['08:30', '10:00']] });
  const { calls, options } = harness({ grids: [first, afterFirst] });
  const result = await submitFlexiblePlan(options);
  assert.deepEqual(calls, ['submit Court 4 08:00-09:00', 'reload', 'submit Court 5 09:00-10:00', 'verify Court 4 08:00', 'verify Court 5 09:00']);
  assert.equal(result.minutes, 120);
  assert.equal(result.segments.length, 2);
});

test('keeps the first booking when the second court is taken before it can be booked', async () => {
  const first = makeGrid({ 'Court 4': [['08:00', '09:00']], 'Court 5': [['09:00', '10:00']] });
  const sniped = makeGrid({});
  const { calls, options } = harness({ grids: [first, sniped] });
  const result = await submitFlexiblePlan(options);
  assert.deepEqual(calls, ['submit Court 4 08:00-09:00', 'reload', 'verify Court 4 08:00']);
  assert.deepEqual(result.segments.map((item) => item.court), ['Court 4']);
});

test('replans on another court when the first choice fails before CONFIRM BOOKING', async () => {
  const grid = makeGrid({ 'Court 4': [['08:00', '10:00']], 'Court 5': [['08:00', '10:00']] });
  const taken = makeGrid({ 'Court 5': [['08:00', '10:00']] });
  const { calls, options } = harness({
    grids: [grid, taken],
    submitBehaviour: ({ court }) => { if (court === 'Court 4') throw new PreConfirmBookingError(court, new Error('modal')); },
  });
  const result = await submitFlexiblePlan(options);
  assert.deepEqual(calls, ['submit Court 4 08:00-10:00', 'reload', 'submit Court 5 08:00-10:00', 'verify Court 5 08:00']);
  assert.equal(result.segments[0].court, 'Court 5');
});

test('a second-booking failure after CONFIRM never discards the first booking', async () => {
  const grid = makeGrid({ 'Court 4': [['08:00', '09:00']], 'Court 5': [['09:00', '10:00']] });
  const { calls, options } = harness({
    grids: [grid, grid],
    submitBehaviour: ({ court }) => { if (court === 'Court 5') throw new Error('Post-confirmation state is unknown'); },
  });
  const result = await submitFlexiblePlan(options);
  assert.deepEqual(result.segments.map((item) => item.court), ['Court 4']);
  assert.match(result.incompleteReason, /Post-confirmation/);
  assert.ok(calls.includes('verify Court 4 08:00'));
});

test('detects own bookings already in the range so a retry never double-books', async () => {
  const records = [
    { date: '2026-11-21', start: '08:00', end: '09:00', court: 'Court 4', bookingType: 'Stadium Pass - Singles', participants: ['Zijia Liu', 'Yufei Liu'] },
    { date: '2026-11-21', start: '19:00', end: '20:00', court: 'Court 1', bookingType: 'Stadium Pass - Singles', participants: ['Zijia Liu', 'Yufei Liu'] },
    { date: '2026-11-21', start: '09:00', end: '10:00', court: 'Court 2', bookingType: 'Stadium Pass - Singles', participants: ['Someone Else', 'Yufei Liu'] },
  ];
  assert.deepEqual(ownBookingsInRange(records, job).map((item) => item.court), ['Court 4']);
  const existing = await existingFlexibleBookings({ job, read: async () => records, listFences: async () => [] });
  assert.equal(existing.length, 1);
});

test('an unresolved fence from an earlier attempt blocks new submissions', async () => {
  await assert.rejects(existingFlexibleBookings({
    job,
    read: async () => [],
    listFences: async () => [{ segment: { date: job.date, start: '08:00', end: '09:00' }, phase: 'confirmation_unknown' }],
    reconcile: async () => ({ state: 'blocked' }),
  }), /reconciliation/);
});

test('verifies several bookings with one remote read per attempt', async () => {
  const { verifySubmittedBookings } = await import('../src/booking-submit.mjs');
  const base = { bookingType: 'Stadium Pass - Singles', participants: ['Yufei Liu', 'Zijia Liu'], date: '2026-11-21' };
  const pendings = [
    { job: { ...base, start: '08:00', end: '09:00' }, court: 'Court 4', paymentStatus: 'free', priorBookingIds: new Set(), remoteBookingId: null },
    { job: { ...base, start: '09:00', end: '10:00' }, court: 'Court 5', paymentStatus: 'free', priorBookingIds: new Set(), remoteBookingId: null },
  ];
  const record = (id, court, start, end) => ({ id, date: '2026-11-21', start, end, court, bookingType: base.bookingType, participants: base.participants, paymentStatus: 'free' });
  let reads = 0;
  const cleared = [];
  const results = await verifySubmittedBookings({
    pendings,
    read: async () => { reads += 1; return reads === 1 ? [record('a', 'Court 4', '08:00', '09:00')] : [record('a', 'Court 4', '08:00', '09:00'), record('b', 'Court 5', '09:00', '10:00')]; },
    clearFence: async ({ job }) => cleared.push(job.start),
    sleep: async () => {},
  });
  assert.equal(reads, 2);
  assert.deepEqual(results.map((r) => r.remoteBookingId), ['a', 'b']);
  assert.deepEqual(cleared, ['08:00', '09:00']);
});

test('a remote reader for one date only loads that month', async () => {
  const { remoteBookingReaderForDate, monthAnchorFor } = await import('../src/remote-bookings.mjs');
  assert.equal(monthAnchorFor('2026-11-21'), '2026-11-01');
  const seen = [];
  await remoteBookingReaderForDate('2026-12-05', async (options) => { seen.push(options.months); return []; })();
  assert.deepEqual(seen, [['2026-12-01']]);
});
