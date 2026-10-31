import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDeadline, bookingFingerprint, selectActionableCourt, waitForOpenSelection } from '../src/launchd-runner.mjs';

const job = {
  date: '2026-11-09', start: '15:30', end: '16:30', openAt: '2026-11-02T07:00:00+13:00', latestStart: '2026-11-02T07:05:00+13:00',
  bookingType: 'Stadium Pass - Singles', participants: ['Yufei Liu', 'Zijia Liu'],
  courtOrder: ['Court 4', 'Court 5'],
};

test('execute path waits for an opening watcher result before selecting a court', async () => {
  const calls = [];
  const result = await waitForOpenSelection({
    context: { id: 'browser' }, job, now: () => 42,
    watch: async (options) => {
      calls.push(options);
      return { poll: { ready: true }, grid: [{ court: 'Court 4' }], selection: { court: 'Court 4' } };
    },
  });
  assert.equal(result.selection.court, 'Court 4');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].openAtMs, Date.parse(job.openAt));
  assert.equal(calls[0].leadMs, 15_000);
});

test('execute path refuses to select before an opening grid is ready', async () => {
  await assert.rejects(
    waitForOpenSelection({ context: {}, job, watch: async () => ({ poll: { ready: false }, grid: null, selection: null }) }),
    /opening grid/i,
  );
});

test('refuses an opening result that arrives after latestStart', async () => {
  let current = Date.parse(job.latestStart) - 1;
  await assert.rejects(
    waitForOpenSelection({
      context: {}, job, now: () => current,
      watch: async () => {
        current = Date.parse(job.latestStart) + 1;
        return { poll: { ready: true }, grid: [{}], selection: { court: 'Court 4' } };
      },
    }),
    /latest start/i,
  );
});

test('tries the next scanned-available court when rendered-slot preflight is intercepted', async () => {
  const grid = ['Court 4', 'Court 5', 'Court 6'].map((court) => ({
    court,
    slots: [
      { start: '15:30', end: '16:00', available: true },
      { start: '16:00', end: '16:30', available: true },
    ],
  }));
  const calls = [];
  const selection = await selectActionableCourt({
    scope: {}, grid, job,
    preflight: async ({ court }) => {
      calls.push(court);
      if (court === 'Court 4') {
        const error = new Error('slot blocked');
        error.code = 'slot_not_actionable';
        throw error;
      }
    },
  });
  assert.deepEqual(calls, ['Court 4', 'Court 5']);
  assert.deepEqual(selection, { court: 'Court 5', checked: ['Court 4', 'Court 5'] });
});

test('rejects every operation at an expired absolute deadline', () => {
  assert.doesNotThrow(() => assertDeadline(100, 100));
  assert.throws(() => assertDeadline(100, 101), /latest start/i);
});

test('uses one execution lock key for one intent despite different fallback courts', () => {
  const alternate = { ...job, id: 'alternate', courtOrder: ['Court 1', 'Court 2'] };
  assert.equal(bookingFingerprint(job), bookingFingerprint(alternate));
});
