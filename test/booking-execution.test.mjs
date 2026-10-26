import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBookingInterval, verifySelection, verifyFinalReview, verifiedBookingRecord, classifyPostConfirm, verifyRemoteBookingEvidence, verifyRemoteBookingRecord,
} from '../src/booking-execution.mjs';

const job = {
  id: 'monday-evening-booking', date: '2026-10-26', start: '21:30', end: '23:00',
  bookingType: 'Stadium Pass - Singles', participants: ['Yufei Liu', 'Zijia Liu'],
};

const finalReview = `New booking
Yufei Liu
Zijia Liu
Stadium Pass - Singles on Monday 26 October
9:30pm – 11:00pm, Court 1
All players are registered (with a Hello Club account), and named in the booking.
CANCEL
CONFIRM BOOKING`;

test('formats the exact local interval expected in the booking dialog', () => {
  assert.equal(formatBookingInterval(job.start, job.end), '9:30pm – 11:00pm');
});

test('rejects a slot selection dialog that differs from the requested court or interval', () => {
  const selection = 'New Wellington North Badminton Stadium booking Monday 26 October, 9:30pm – 11:00pm, Court 1 1 hour 30 minutes CANCEL NEXT';
  assert.deepEqual(verifySelection(selection, job, 'Court 1'), { ok: true });
  assert.throws(() => verifySelection(selection.replace('11:00pm', '10:30pm'), job, 'Court 1'), /time/i);
});
test('rejects final review if any target fact is absent', () => {
  assert.deepEqual(verifyFinalReview(finalReview, job, 'Court 1'), { ok: true });
  assert.throws(() => verifyFinalReview(finalReview.replace('Court 1', 'Court 2'), job, 'Court 1'), /court/i);
  assert.throws(() => verifyFinalReview(finalReview.replace('Zijia Liu', 'Other Player'), job, 'Court 1'), /participant/i);
});

test('accepts the venue final-review date format for a single-digit day', () => {
  const novemberJob = { ...job, date: '2026-11-02', start: '15:30', end: '16:30' };
  const renderedReview = `New booking
Yufei Liu
Zijia Liu
Stadium Pass - Singles on Monday 2 November
3:30pm – 4:30pm, Court 5
All players are registered (with a Hello Club account), and named in the booking.
CANCEL
CONFIRM BOOKING`;
  assert.deepEqual(verifyFinalReview(renderedReview, novemberJob, 'Court 5'), { ok: true });
});

test('classifies payment handoff without authorizing payment', () => {
  assert.equal(classifyPostConfirm('Booking created'), 'free');
  assert.equal(classifyPostConfirm('Continue to payment'), 'payment_required');
  assert.equal(classifyPostConfirm('Unexpected screen'), 'unknown');
});

test('requires the exact venue and participants in remote booking evidence', () => {
  const free = 'Wellington North Badminton Stadium Your booking Yufei Liu Zijia Liu Stadium Pass - Singles on Monday 26 October 9:30pm – 11:00pm, Court 1';
  assert.deepEqual(verifyRemoteBookingEvidence(free, job, 'Court 1', 'free'), { ok: true });
  assert.throws(() => verifyRemoteBookingEvidence(free.replace('Zijia Liu', 'Other Player'), job, 'Court 1', 'free'), /participant/i);
  assert.throws(() => verifyRemoteBookingEvidence(free.replace('Wellington North Badminton Stadium', 'Other venue'), job, 'Court 1', 'free'), /venue/i);
});
test('requires remote calendar evidence for the exact created booking', () => {
  const free = 'Wellington North Badminton Stadium Your booking Yufei Liu Zijia Liu Stadium Pass - Singles on Monday 26 October 9:30pm – 11:00pm, Court 1';
  const unpaid = `${free} The booking fee has not been paid yet PAY NOW REMOVE BOOKING`;
  assert.deepEqual(verifyRemoteBookingEvidence(free, job, 'Court 1', 'free'), { ok: true });
  assert.deepEqual(verifyRemoteBookingEvidence(unpaid, job, 'Court 1', 'unpaid_hold'), { ok: true });
  assert.throws(() => verifyRemoteBookingEvidence(free, job, 'Court 1', 'unpaid_hold'), /unpaid/i);
});

test('accepts an exact remote calendar record even without a calendar-card label', () => {
  const record = {
    date: '2026-10-26', start: '21:30', end: '23:00', court: 'Court 1',
    bookingType: 'Stadium Pass - Singles', participants: ['Yufei Liu', 'Zijia Liu'], paymentStatus: 'free', source: 'helloclub',
  };
  assert.deepEqual(verifyRemoteBookingRecord(record, job, 'Court 1', 'free'), { ok: true });
  assert.throws(() => verifyRemoteBookingRecord({ ...record, court: 'Court 2' }, job, 'Court 1', 'free'), /court/i);
});
test('creates a public booking record only after verified free or unpaid-hold outcomes', () => {
  const record = verifiedBookingRecord({ job, court: 'Court 1', paymentStatus: 'free', verifiedAt: '2026-10-25T00:00:00.000Z' });
  assert.deepEqual(record, {
    id: 'monday-evening-booking', date: '2026-10-26', start: '21:30', end: '23:00', court: 'Court 1',
    bookingType: 'Stadium Pass - Singles', participants: ['Yufei Liu', 'Zijia Liu'],
    paymentStatus: 'free', verifiedAt: '2026-10-25T00:00:00.000Z',
  });
  assert.throws(() => verifiedBookingRecord({ job, court: 'Court 1', paymentStatus: 'candidate', verifiedAt: '2026-10-25T00:00:00.000Z' }), /payment/i);
});
