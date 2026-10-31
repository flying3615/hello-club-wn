import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTargetDateLabel,
  isTargetPageReady,
  locateTargetCalendarGridRoot,
  selectCompleteTargetGridIndex,
  waitForOpeningInstant,
} from '../src/opening-watch.mjs';

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

test('binds the target card to the sole visible complete 6-court grid', () => {
  const cards = [
    { index: 0, visible: false, containsVenue: true, containsTargetDate: true, courtCount: 6, slotCount: 0 },
    { index: 1, visible: true, containsVenue: true, containsTargetDate: true, courtCount: 6, slotCount: 0 },
    { index: 2, visible: true, containsVenue: true, containsTargetDate: true, courtCount: 6, slotCount: 0 },
    { index: 3, visible: true, containsVenue: true, containsTargetDate: true, courtCount: 6, slotCount: 288 },
  ];
  assert.equal(selectCompleteTargetGridIndex(cards), 3);
});

test('rejects ambiguous complete target grids rather than picking one', () => {
  const card = { visible: true, containsVenue: true, containsTargetDate: true, courtCount: 6, slotCount: 288 };
  assert.throws(() => selectCompleteTargetGridIndex([{ ...card, index: 0 }, { ...card, index: 1 }]), /exactly one complete/i);
});

test('keeps a hidden complete grid out of the selected target', () => {
  const card = { containsVenue: true, containsTargetDate: true, courtCount: 6, slotCount: 288 };
  assert.equal(selectCompleteTargetGridIndex([
    { ...card, index: 0, visible: false },
    { ...card, index: 1, visible: true },
  ]), 1);
});

test('binds the selected grid through its nearest Card or the grid itself', async () => {
  const calls = [];
  const root = { count: async () => 1 };
  const grids = {
    evaluateAll: async () => [{
      index: 3,
      visible: true,
      containsVenue: true,
      containsTargetDate: true,
      courtCount: 6,
      slotCount: 288,
    }],
    nth: (index) => ({
      locator: (query) => {
        calls.push({ index, query });
        return root;
      },
    }),
  };
  const page = { locator: (query) => {
    assert.equal(query, '.BookingGrid');
    return grids;
  } };
  assert.equal(await locateTargetCalendarGridRoot(page, '2026-11-05'), root);
  assert.equal(calls[0].index, 3);
  assert.match(calls[0].query, /^xpath=ancestor-or-self::\*/);
});

test('requires the exact target date and rendered venue grid', () => {
  const readyBody = 'Wellington North Badminton Stadium\nSaturday 31 October\nCourt 1\nCourt 2\nCourt 3\nCourt 4\nCourt 5\nCourt 6';
  assert.equal(isTargetPageReady(readyBody, '2026-10-31'), true);
  assert.equal(isTargetPageReady(`Loading...\n${readyBody}`, '2026-10-31'), false);
  assert.equal(isTargetPageReady(readyBody.replace('Saturday 31 October', 'Friday 30 October'), '2026-10-31'), false);
  assert.equal(isTargetPageReady('Saturday 31 October\nCourt 1\nCourt 2', '2026-10-31'), false);
});
