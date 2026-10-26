import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForOpenSelection } from '../src/launchd-runner.mjs';

const job = {
  date: '2026-11-09', start: '15:30', end: '16:30', openAt: '2026-11-02T07:00:00+13:00',
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
