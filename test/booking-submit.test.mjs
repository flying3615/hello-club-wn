import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSlotsActionable, bodyColumnIndexForCourt, remoteRecordMatchesIntent, selectRenderedSlotRange,
  SlotActionabilityError, preflightBookingSubmission, revealSlot, slotRangeIndices, visibleModal,
  waitForFinalReview, normalizeMemberNames, readFinalReviewMemberNames, readSelectedMemberNames,
  waitForPostConfirmState, findNewMatchingRemoteBooking,
} from '../src/booking-submit.mjs';
import { verifyExactParticipantSet } from '../src/booking-execution.mjs';

test('selects the last visible booking modal only', () => {
  let selector;
  const expected = { id: 'visible-modal' };
  const page = {
    locator: (value) => {
      selector = value;
      return { last: () => expected };
    },
  };

  assert.equal(visibleModal(page), expected);
  assert.equal(selector, '.modal-wrapper:visible');
});

test('waits for the final confirmation action before reviewing the booking', async () => {
  const calls = [];
  const modal = {
    locator: (selector) => {
      calls.push({ selector });
      return {
        filter: (options) => {
          calls.push({ options });
          return { waitFor: async (options) => calls.push({ waitFor: options }) };
        },
      };
    },
  };

  await waitForFinalReview(modal);

  assert.deepEqual(calls, [
    { selector: 'button' },
    { options: { hasText: 'CONFIRM BOOKING' } },
    { waitFor: { state: 'visible', timeout: 5_000 } },
  ]);
});

test('reveals the requested grid slot before an interaction', async () => {
  let options;
  const slot = {
    evaluate: async (callback) => callback({
      scrollIntoView: (value) => { options = value; },
    }),
  };

  await revealSlot(slot);

  assert.deepEqual(options, { block: 'center', inline: 'center' });
});

test('preflights both rendered slots with trial hover before booking interaction', async () => {
  const calls = [];
  const slot = (name) => ({
    evaluate: async (callback) => callback({ scrollIntoView: (options) => calls.push({ name, scroll: options }) }),
    hover: async (options) => calls.push({ name, hover: options }),
  });
  await assertSlotsActionable({ startSlot: slot('start'), endSlot: slot('end'), court: 'Court 4' });
  assert.deepEqual(calls, [
    { name: 'start', scroll: { block: 'center', inline: 'center' } },
    { name: 'start', hover: { trial: true, timeout: 2_000 } },
    { name: 'end', scroll: { block: 'center', inline: 'center' } },
    { name: 'end', hover: { trial: true, timeout: 2_000 } },
  ]);
});

test('labels an intercepted rendered slot as safe fallback eligibility failure', async () => {
  const blocked = {
    evaluate: async (callback) => callback({ scrollIntoView: () => {} }),
    hover: async () => { throw new Error('intercepts pointer events'); },
  };
  await assert.rejects(
    assertSlotsActionable({ startSlot: blocked, endSlot: blocked, court: 'Court 4' }),
    (error) => error instanceof SlotActionabilityError && error.code === 'slot_not_actionable' && error.court === 'Court 4',
  );
});

test('performs the required stateful slot sequence in order', async () => {
  const calls = [];
  const slot = (name) => ({
    evaluate: async (callback) => callback({ scrollIntoView: (options) => calls.push({ name, scroll: options }) }),
    click: async () => calls.push({ name, click: true }),
    hover: async () => calls.push({ name, hover: true }),
  });
  await selectRenderedSlotRange({ startSlot: slot('start'), endSlot: slot('end') });
  assert.deepEqual(calls, [
    { name: 'start', scroll: { block: 'center', inline: 'center' } },
    { name: 'start', click: true },
    { name: 'end', scroll: { block: 'center', inline: 'center' } },
    { name: 'end', hover: true },
    { name: 'end', click: true },
  ]);
});

test('stops the slot sequence before a second state-changing click when deadline expires', async () => {
  const calls = [];
  let checks = 0;
  const slot = (name) => ({
    evaluate: async (callback) => callback({ scrollIntoView: () => calls.push(`${name}:scroll`) }),
    click: async () => calls.push(`${name}:click`),
    hover: async () => calls.push(`${name}:hover`),
  });
  await assert.rejects(
    selectRenderedSlotRange({
      startSlot: slot('start'), endSlot: slot('end'),
      assertDeadline: () => { checks += 1; if (checks >= 3) throw new Error('latest start deadline has passed'); },
    }),
    /latest start/i,
  );
  assert.deepEqual(calls, ['start:scroll', 'start:click']);
});

test('treats an equivalent booking on another court as a duplicate intent', () => {
  const job = { date: '2026-11-06', start: '17:00', end: '18:00', bookingType: 'Stadium Pass - Singles', participants: ['Yufei Liu', 'Zijia Liu'] };
  const record = { date: job.date, start: job.start, end: job.end, court: 'Court 5', bookingType: job.bookingType, participants: [...job.participants].reverse() };
  assert.equal(remoteRecordMatchesIntent(record, job), true);
});

const verifiedGrid = ['Court 1', 'Court 2', 'Court 3', 'Court 4', 'Court 5', 'Court 6']
  .map((court) => ({ court, slots: Array.from({ length: 48 }, () => ({})) }));
const boundColumns = [
  ...['Court 1', 'Court 2', 'Court 3', 'Court 4', 'Court 5', 'Court 6'].map((court, index) => ({
    court, slotCount: 0, parentGridIndex: 0, x: index * 100, width: 100,
  })),
  ...Array.from({ length: 6 }, (_, index) => ({ slotCount: 0, parentGridIndex: 1, x: index * 100, width: 100 })),
  ...Array.from({ length: 6 }, (_, index) => ({ slotCount: 48, parentGridIndex: 2, x: index * 100, width: 100 })),
];

test('maps a verified court to its geometrically bound 48-slot body column', () => {
  assert.equal(bodyColumnIndexForCourt(verifiedGrid, 'Court 4', boundColumns), 15);
});

test('refuses a grid whose body columns are incomplete or ambiguous', () => {
  assert.throws(
    () => bodyColumnIndexForCourt(verifiedGrid, 'Court 4', boundColumns.slice(0, -1)),
    /exactly six complete/i,
  );
});

test('refuses a court not present in the verified grid', () => {
  assert.throws(() => bodyColumnIndexForCourt(verifiedGrid, 'Court 7', boundColumns), /not found/i);
});

test('refuses duplicate court names in the verified grid', () => {
  const duplicate = verifiedGrid.map((column) => ({ ...column }));
  duplicate[4].court = 'Court 4';
  assert.throws(() => bodyColumnIndexForCourt(duplicate, 'Court 4', boundColumns), /exactly one/i);
});

test('refuses an extra slot-bearing DOM column', () => {
  assert.throws(
    () => bodyColumnIndexForCourt(verifiedGrid, 'Court 4', [...boundColumns, { slotCount: 48, parentGridIndex: 2, x: 700, width: 100 }]),
    /exactly six complete/i,
  );
});

test('refuses a complete verified grid whose court order is permuted', () => {
  const permuted = [verifiedGrid[1], verifiedGrid[0], ...verifiedGrid.slice(2)];
  assert.throws(
    () => bodyColumnIndexForCourt(permuted, 'Court 1', boundColumns),
    /ordered court 1 through court 6/i,
  );
});

test('maps the 00:00–24:00 boundaries to the first and last slots', () => {
  assert.deepEqual(slotRangeIndices('00:00', '24:00'), { startIndex: 0, endIndex: 47 });
});

test('refuses invalid slot boundaries before locator interaction', () => {
  assert.throws(() => slotRangeIndices('00:15', '01:00'), /half-hour boundaries/i);
  assert.throws(() => slotRangeIndices('23:30', '23:30'), /valid positive range/i);
});

test('refuses a body column that is not geometrically aligned to its court header', () => {
  const misaligned = boundColumns.map((column) => ({ ...column }));
  misaligned[15].x += 10;
  assert.throws(() => bodyColumnIndexForCourt(verifiedGrid, 'Court 4', misaligned), /geometry/i);
});

test('refuses an incomplete extra sibling in the selected body grid', () => {
  assert.throws(
    () => bodyColumnIndexForCourt(verifiedGrid, 'Court 4', [...boundColumns, { slotCount: 47, parentGridIndex: 2, x: 700, width: 100 }]),
    /exactly six complete body/i,
  );
});

test('rejects invalid booking inputs in local preflight before any remote dependency', () => {
  assert.throws(
    () => preflightBookingSubmission({ grid: verifiedGrid, court: 'Court 7', start: '18:30', end: '19:30' }),
    /not found/i,
  );
  assert.throws(
    () => preflightBookingSubmission({ grid: verifiedGrid, court: 'Court 4', start: '18:30', end: '18:30' }),
    /valid positive range/i,
  );
  const malformedSlots = verifiedGrid.map((column) => ({ ...column }));
  malformedSlots[3].slots = Array.from({ length: 48 }, () => ({}));
  malformedSlots[3].slots[47] = null;
  assert.throws(
    () => preflightBookingSubmission({ grid: malformedSlots, court: 'Court 4', start: '18:30', end: '19:30' }),
    /six complete courts/i,
  );
});

test('normalizes structured member rows and refuses an empty member list', () => {
  assert.deepEqual(normalizeMemberNames(['  Yufei   Liu ', 'Zijia Liu', '']), ['Yufei Liu', 'Zijia Liu']);
  assert.throws(() => normalizeMemberNames([]), /selected participants/i);
  assert.throws(() => normalizeMemberNames(['', '   ']), /selected participants/i);
  assert.throws(() => normalizeMemberNames(null), /structured participant rows/i);
});

test('reads selected member names from the member picker, not free text', async () => {
  const picker = { count: async () => 1, evaluate: async () => [' Yufei Liu ', 'Zijia Liu', ''] };
  const modal = { locator: (selector) => {
    assert.equal(selector, 'member-picker');
    return picker;
  } };
  assert.deepEqual(await readSelectedMemberNames(modal), ['Yufei Liu', 'Zijia Liu']);
  await assert.rejects(
    readSelectedMemberNames({ locator: () => ({ ...picker, count: async () => 2 }) }),
    /exactly one member picker/i,
  );
});

test('reads the final-review member list from structured rows and rejects extra participants', async () => {
  const names = ['Yufei Liu', 'Zijia Liu', 'Visitor', ''];
  const container = { count: async () => 1, evaluate: async () => names };
  const modal = { locator: (selector) => {
    assert.equal(selector, '.BookingView-members');
    return container;
  } };
  const participants = await readFinalReviewMemberNames(modal);
  assert.deepEqual(participants, ['Yufei Liu', 'Zijia Liu', 'Visitor']);
  assert.throws(
    () => verifyExactParticipantSet(participants, ['Yufei Liu', 'Zijia Liu']),
    /exact participant set/i,
  );
  await assert.rejects(
    readFinalReviewMemberNames({ locator: () => ({ ...container, count: async () => 0 }) }),
    /exactly one structured member list/i,
  );
});

test('waits for an unambiguous post-confirmation state and stays unknown on timeout', async () => {
  let reads = 0;
  const page = {
    locator: () => ({ innerText: async () => (reads += 1) === 1 ? 'Loading…' : 'Pay for booking' }),
  };
  assert.equal(await waitForPostConfirmState(page, { attempts: 3, sleep: async () => {} }), 'payment_required');
  const unknownPage = { locator: () => ({ innerText: async () => 'Unexpected screen' }) };
  assert.equal(await waitForPostConfirmState(unknownPage, { attempts: 2, sleep: async () => {} }), 'unknown');
});

test('requires the payment-page booking ID when matching the new remote record', () => {
  const job = {
    date: '2026-11-06', start: '17:00', end: '18:00', bookingType: 'Stadium Pass - Singles',
    participants: ['Yufei Liu', 'Zijia Liu'],
  };
  const record = (id) => ({
    id, date: job.date, start: job.start, end: job.end, court: 'Court 4',
    bookingType: job.bookingType, participants: [...job.participants],
  });
  const records = [record('old-1'), record('new-2')];
  assert.equal(findNewMatchingRemoteBooking(records, job, 'Court 4', new Set(['old-1']), 'new-2')?.id, 'new-2');
  assert.equal(findNewMatchingRemoteBooking(records, job, 'Court 4', new Set(['old-1']), 'other-3'), null);
  assert.equal(findNewMatchingRemoteBooking(records, job, 'Court 4', new Set(['old-1']), 'old-1'), null);
});


test('clicks a 30-minute single cell only once', async () => {
  const calls = [];
  const slot = (name) => ({
    evaluate: async (callback) => callback({ scrollIntoView: (options) => calls.push({ name, scroll: options }) }),
    click: async () => calls.push({ name, click: true }),
    hover: async () => calls.push({ name, hover: true }),
  });
  const start = slot('slot');
  await selectRenderedSlotRange({ startSlot: start, endSlot: start, singleSlot: true });
  assert.deepEqual(calls, [
    { name: 'slot', scroll: { block: 'center', inline: 'center' } },
    { name: 'slot', click: true },
  ]);
});
