import test from 'node:test';
import assert from 'node:assert/strict';
import { findNewMatchingRemoteBooking, waitForNewRemoteBooking } from '../src/booking-submit.mjs';

const job = {
  date: '2026-11-02', start: '15:30', end: '16:30',
  bookingType: 'Stadium Pass - Singles', participants: ['Yufei Liu', 'Zijia Liu'],
};
const matching = { id: 'new-booking', date: job.date, start: job.start, end: job.end, court: 'Court 5', bookingType: job.bookingType, participants: [...job.participants], paymentStatus: 'free' };

test('does not treat a pre-submit matching booking as newly created', () => {
  assert.equal(findNewMatchingRemoteBooking([matching], job, 'Court 5', new Set(['new-booking'])), null);
});

test('retries remote read-back until a newly created exact booking appears', async () => {
  const reads = [[], [], [matching]];
  const waits = [];
  const found = await waitForNewRemoteBooking({
    job,
    court: 'Court 5',
    priorBookingIds: new Set(),
    read: async () => reads.shift(),
    sleep: async (ms) => { waits.push(ms); },
    attempts: 3,
    delayMs: 1_500,
  });
  assert.equal(found, matching);
  assert.deepEqual(waits, [1_500, 1_500]);
});
