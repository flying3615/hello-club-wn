import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTargetDateLabel, isTargetPageReady, waitForOpeningInstant } from '../src/opening-watch.mjs';

test("formats the target date using the venue's local calendar label", () => {
  assert.equal(formatTargetDateLabel('2026-10-31'), 'Saturday 31 October');
});

test('does not permit an opening grid scan before the opening instant', async () => {
  const waits = [];
  await waitForOpeningInstant({
    openAtMs: 10_000,
    now: () => 8_000,
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.deepEqual(waits, [2_000]);
});

test('requires the exact target date and rendered venue grid', () => {
  const readyBody = 'Wellington North Badminton Stadium\nSaturday 31 October\nCourt 1\nCourt 2\nCourt 3\nCourt 4\nCourt 5\nCourt 6';
  assert.equal(isTargetPageReady(readyBody, '2026-10-31'), true);
  assert.equal(isTargetPageReady(readyBody.replace('Saturday 31 October', 'Friday 30 October'), '2026-10-31'), false);
  assert.equal(isTargetPageReady('Saturday 31 October\nCourt 1\nCourt 2', '2026-10-31'), false);
});
