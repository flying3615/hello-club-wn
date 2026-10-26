import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePollOptions,
  waitUntilOpeningWindow,
  pollUntilReady,
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

test('refreshes until the real target page is ready, then stops', async () => {
  let checks = 0;
  const refreshed = [];
  const result = await pollUntilReady({
    isReady: async () => {
      checks += 1;
      return checks === 3;
    },
    refresh: async () => { refreshed.push(checks); },
    sleep: async () => {},
    now: (() => {
      let value = 0;
      return () => { value += 100; return value; };
    })(),
    pollMs: 2500,
    timeoutMs: 10_000,
  });
  assert.equal(result.ready, true);
  assert.equal(result.attempts, 3);
  assert.deepEqual(refreshed, [1, 2]);
});

test('returns a bounded timeout result instead of polling forever', async () => {
  let now = 0;
  let refreshes = 0;
  const result = await pollUntilReady({
    isReady: async () => false,
    refresh: async () => { refreshes += 1; },
    sleep: async (ms) => { now += ms; },
    now: () => now,
    pollMs: 2500,
    timeoutMs: 5000,
  });
  assert.equal(result.ready, false);
  assert.equal(result.timedOut, true);
  assert.equal(refreshes, 2);
});
