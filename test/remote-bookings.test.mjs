import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteBookingCache, monthSyncAnchors, partitionRemoteBookings, remoteBookingRecord } from '../src/remote-bookings.mjs';

const booking = {
  id: 'remote-booking-1',
  activity: { name: 'Wellington North Badminton Stadium' },
  area: { name: 'Court 1' },
  mode: { name: 'Stadium Pass - Singles' },
  profiles: [{ name: 'Yufei Liu' }, { name: 'Zijia Liu' }],
  startDate: '2026-10-25T08:30:00.000Z',
  endDate: '2026-10-25T10:00:00.000Z',
  isPaid: false,
  isRefunded: false,
  hasInAdvancePayableFee: false,
};

test('maps a remote Hello Club booking into a local-time panel record', () => {
  assert.deepEqual(remoteBookingRecord(booking, '2026-10-25T00:00:00.000Z'), {
    id: 'remote-booking-1',
    date: '2026-10-25',
    start: '21:30',
    end: '23:00',
    court: 'Court 1',
    bookingType: 'Stadium Pass - Singles',
    participants: ['Yufei Liu', 'Zijia Liu'],
    startsAt: '2026-10-25T08:30:00.000Z',
    paymentStatus: 'free',
    verifiedAt: '2026-10-25T00:00:00.000Z',
    source: 'helloclub',
  });
});

test('uses explicit remote payment state and rejects removed or unrelated bookings', () => {
  assert.equal(remoteBookingRecord({ ...booking, isPaid: true }).paymentStatus, 'paid');
  assert.equal(remoteBookingRecord({ ...booking, hasInAdvancePayableFee: true }).paymentStatus, 'unpaid_hold');
  assert.equal(remoteBookingRecord({ ...booking, isRefunded: true }), null);
  assert.equal(remoteBookingRecord({ ...booking, activity: { name: 'Other venue' } }), null);
  assert.equal(remoteBookingRecord({ ...booking, area: { name: 'Court 9' } }), null);
});

test('limits remote calendar reads to one prior, current, and two future months', () => {
  assert.deepEqual(monthSyncAnchors('2026-10-25T00:00:00.000Z'), [
    '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01',
  ]);
});

test('splits remote bookings by actual start instant and orders each group for scanning', () => {
  const records = [
    { id: 'old', startsAt: '2026-10-25T00:00:00.000Z' },
    { id: 'tonight', startsAt: '2026-10-25T08:30:00.000Z' },
    { id: 'next', startsAt: '2026-10-26T07:00:00.000Z' },
    { id: 'recent', startsAt: '2026-10-25T00:30:00.000Z' },
  ];
  const grouped = partitionRemoteBookings(records, '2026-10-25T00:39:00.000Z');
  assert.deepEqual(grouped.upcoming.map((record) => record.id), ['tonight', 'next']);
  assert.deepEqual(grouped.past.map((record) => record.id), ['recent', 'old']);
});

test('keeps the last successful remote snapshot when the next sync fails', async () => {
  let now = 0;
  let calls = 0;
  const cache = createRemoteBookingCache({
    ttlMs: 100,
    now: () => now,
    read: async () => {
      calls += 1;
      if (calls === 1) return [{ id: 'remote-booking-1' }];
      throw new Error('remote unavailable');
    },
  });
  assert.deepEqual(await cache.get(), { bookings: [{ id: 'remote-booking-1' }], syncedAt: 0, state: 'fresh' });
  now = 50;
  assert.deepEqual(await cache.get(), { bookings: [{ id: 'remote-booking-1' }], syncedAt: 0, state: 'fresh' });
  assert.equal(calls, 1);
  now = 101;
  assert.deepEqual(await cache.get(), { bookings: [{ id: 'remote-booking-1' }], syncedAt: 0, state: 'stale' });
  assert.equal(calls, 2);
});
