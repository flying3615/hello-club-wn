import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRtcWake, buildRtcWakePlan, OWNER, parseScheduledWakes, pmsetWakeKey } from '../src/rtc-wake.mjs';

const validJob = {
  id: 'tuesday-2026-11-03-2030',
  date: '2026-11-03',
  start: '20:30',
  end: '21:00',
  prepareAt: '2026-10-27T06:57:00+13:00',
  openAt: '2026-10-27T07:00:00+13:00',
  latestStart: '2026-10-27T07:05:00+13:00',
  bookingType: 'Stadium Pass - Singles',
  participants: ['Yufei Liu', 'Zijia Liu'],
  courtOrder: ['Court 4', 'Court 5', 'Court 6', 'Court 1', 'Court 2', 'Court 3'],
  paymentPolicy: 'cancel-on-payment',
  submit: true,
};

test('normalizes pmset wake dates with two- or four-digit years', () => {
  assert.equal(pmsetWakeKey('10/27/26 06:53:00'), '2026-10-27T06:53:00');
  assert.equal(pmsetWakeKey('10/27/2026 06:53:00'), '2026-10-27T06:53:00');
  assert.throws(() => pmsetWakeKey('2026-10-27 06:53:00'), /MM\/DD\/YY/i);
});

test('parses only scheduled wake events and preserves their owner', () => {
  const wakes = parseScheduledWakes(`Scheduled power events:
 [0]  wake at 10/31/2026 01:38:27 by 'com.apple.alarm.user-invisible'
 [1]  wake at 10/27/26 06:53:00 by '${OWNER}'
 [2]  sleep at 10/30/2026 23:00:00 by 'com.apple.alarm'
`);
  assert.deepEqual(wakes, [
    { key: '2026-10-31T01:38:27', owner: 'com.apple.alarm.user-invisible', raw: '10/31/2026 01:38:27' },
    { key: '2026-10-27T06:53:00', owner: OWNER, raw: '10/27/26 06:53:00' },
  ]);
});

test('assesses the owner wake as missing, exact, or conflicting', () => {
  const plan = buildRtcWakePlan(validJob);
  assert.equal(plan.wakeKey, '2026-10-27T06:53:00');
  assert.deepEqual(assessRtcWake(plan, []), { state: 'not_armed' });
  assert.deepEqual(assessRtcWake(plan, [
    { key: '2026-10-31T01:38:27', owner: 'com.apple.alarm.user-invisible' },
  ]), { state: 'not_armed' });
  assert.deepEqual(assessRtcWake(plan, [
    { key: '2026-10-27T06:53:00', owner: OWNER },
  ]), { state: 'already_armed' });
  assert.equal(assessRtcWake(plan, [
    { key: '2026-10-28T06:53:00', owner: OWNER },
  ]).state, 'conflict');
  assert.equal(assessRtcWake(plan, [
    { key: '2026-10-27T06:53:00', owner: OWNER },
    { key: '2026-10-27T06:53:00', owner: OWNER },
  ]).state, 'conflict');
});
