import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseCourt,
  evaluatePaymentPage,
  verifyRemoteOutcome,
} from '../src/booking-policy.mjs';

const target = { start: '22:00', end: '23:00' };
const slot = (start, end, available = true) => ({ start, end, available });

function availability(court, slots) {
  return { court, slots };
}

test('chooses the first preferred court with a complete interval', () => {
  const result = chooseCourt([
    availability('Court 4', [slot('22:00', '22:30'), slot('22:30', '23:00', false)]),
    availability('Court 5', [slot('22:00', '22:30'), slot('22:30', '23:00')]),
    availability('Court 6', [slot('22:00', '22:30'), slot('22:30', '23:00')]),
  ], target);

  assert.equal(result.court, 'Court 5');
  assert.equal(result.reason, 'complete_interval');
});

test('falls back to Courts 1–3 only after Courts 4–6 fail', () => {
  const blocked = ['Court 4', 'Court 5', 'Court 6'].map((court) =>
    availability(court, [slot('22:00', '22:30'), slot('22:30', '23:00', false)]),
  );
  const result = chooseCourt([
    ...blocked,
    availability('Court 1', [slot('22:00', '22:30'), slot('22:30', '23:00')]),
  ], target);

  assert.equal(result.court, 'Court 1');
  assert.deepEqual(result.checked, ['Court 4', 'Court 5', 'Court 6', 'Court 1']);
});

test('rejects a partial interval even when one half-hour is free', () => {
  assert.throws(
    () => chooseCourt([
      availability('Court 4', [slot('22:00', '22:30'), slot('22:30', '23:00', false)]),
    ], target),
    /No complete interval available/,
  );
});

test('payment page uses CANCEL to leave a verified unpaid hold', () => {
  assert.deepEqual(
    evaluatePaymentPage({ paymentRequired: true, allowUnpaidHold: true }),
    { action: 'click_payment_cancel_then_verify_hold', paid: false },
  );
});

test('payment page never authorizes payment by default', () => {
  assert.deepEqual(
    evaluatePaymentPage({ paymentRequired: true, allowUnpaidHold: false }),
    { action: 'stop_before_payment', paid: false },
  );
});

test('unpaid hold is success only after remote read-back', () => {
  assert.equal(
    verifyRemoteOutcome({ pendingHold: true, paid: false }).status,
    'unpaid_hold_verified',
  );
  assert.equal(
    verifyRemoteOutcome({ pendingHold: false, paid: false }).status,
    'unknown',
  );
});
