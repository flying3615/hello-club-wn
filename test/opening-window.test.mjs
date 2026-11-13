import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePollOptions,
  waitUntilOpeningWindow,
} from '../src/opening-window.mjs';

test('uses a bounded 2.5-second polling policy by default', () => {
  assert.deepEqual(normalizePollOptions({}), {
    pollMs: 2500,
    timeoutMs: 180000,
    leadMs: 15000,
  });
});

test('rejects unsafe polling intervals and unbounded timeouts', () => {
  assert.throws(() => normalizePollOptions({ pollMs: 500 }), /pollMs/);
  assert.throws(() => normalizePollOptions({ timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => normalizePollOptions({ leadMs: -1 }), /leadMs/);
});

test('waits until the pre-opening window instead of refreshing early', async () => {
  let now = 0;
  const sleeps = [];
  const result = await waitUntilOpeningWindow({
    openAtMs: 60_000,
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    leadMs: 15_000,
  });
  assert.equal(result.startedAtMs, 45_000);
  assert.deepEqual(sleeps, [45_000]);
  assert.equal(now, 45_000);
});

