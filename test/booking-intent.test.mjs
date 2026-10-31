import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingIntentKey, remoteRecordMatchesIntent } from '../src/booking-intent.mjs';

const base = {
  id: 'friday-a', date: '2026-11-06', start: '17:00', end: '18:00',
  bookingType: 'Stadium Pass - Singles', participants: ['Yufei Liu', 'Zijia Liu'],
  courtOrder: ['Court 4', 'Court 5'],
};

test('canonical intent ignores job id and fallback court preference', () => {
  const differentPreference = {
    ...base,
    id: 'friday-b',
    courtOrder: ['Court 1', 'Court 2', 'Court 3'],
  };
  assert.equal(bookingIntentKey(base), bookingIntentKey(differentPreference));
});

test('intent matching rejects different people but accepts any permitted court', () => {
  const record = {
    id: 'remote-1', date: base.date, start: base.start, end: base.end,
    court: 'Court 5', bookingType: base.bookingType,
    participants: ['Zijia Liu', 'Yufei Liu'],
  };
  assert.equal(remoteRecordMatchesIntent(record, base), true);
  assert.equal(remoteRecordMatchesIntent({ ...record, participants: ['Yufei Liu', 'Someone Else'] }, base), false);
});
