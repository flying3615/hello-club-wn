import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBookingInterval, verifySelection, verifyFinalReview, verifyExactParticipantSet, verifiedBookingRecord, classifyPostConfirm, verifyRemoteBookingEvidence, verifyRemoteBookingRecord,
  paymentBookingId, verifyPaymentPage,
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
  assert.throws(() => verifyFinalReview(`${finalReview}\nVisitor fee: $15.00`, job, 'Court 1'), /fee|pass/i);
  assert.throws(() => verifyFinalReview(`${finalReview}\nStadium Pass is inactive`, job, 'Court 1'), /fee|pass/i);
});

test('requires final-review participants to be the exact normalized set', () => {
  assert.deepEqual(verifyExactParticipantSet(['  Zijia  Liu ', 'Yufei Liu'], job.participants), { ok: true });
  assert.throws(() => verifyExactParticipantSet(['Yufei Liu', 'Zijia Liu', 'Other Player'], job.participants), /exact participant set/i);
  assert.throws(() => verifyExactParticipantSet(['Yufei Liu', 'Zijia Liu (guest)'], job.participants), /exact participant set/i);
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
  assert.equal(classifyPostConfirm('Pay for booking'), 'payment_required');
  assert.equal(classifyPostConfirm('The booking fee has not been paid yet'), 'unknown');
  assert.equal(classifyPostConfirm('Unexpected screen'), 'unknown');
});

test('accepts only an authenticated account payment page and extracts its booking ID', () => {
  const pageText = `Pay for booking
You are paying for your Wellington North Badminton Stadium booking of Monday 26 October at 9:30pm on Court 1.
The fee for this booking is $0.00.
Cancel Next`;
  const result = verifyPaymentPage({
    url: 'https://bookings.wnba.org.nz/account/booking/abc12345',
    text: pageText,
    job,
    court: 'Court 1',
  });
  assert.deepEqual(result, { bookingId: 'abc12345' });
  assert.equal(paymentBookingId('https://bookings.wnba.org.nz/account/booking/abc12345'), 'abc12345');
});

test('refuses public, foreign, insecure, or decorated payment handoffs before any action', () => {
  const pageText = `Pay for booking
You are paying for your Wellington North Badminton Stadium booking of Monday 26 October at 9:30pm on Court 1.`;
  const base = { text: pageText, job, court: 'Court 1' };
  assert.throws(() => verifyPaymentPage({ ...base, url: 'https://bookings.wnba.org.nz/booking/abc12345' }), /authenticated account payment page/i);
  assert.throws(() => verifyPaymentPage({ ...base, url: 'https://evil.example/account/booking/abc12345' }), /expected Hello Club host/i);
  assert.throws(() => verifyPaymentPage({ ...base, url: 'http://bookings.wnba.org.nz/account/booking/abc12345' }), /HTTPS/i);
  assert.throws(() => verifyPaymentPage({ ...base, url: 'https://bookings.wnba.org.nz/account/booking/abc12345?next=pay' }), /query or fragment/i);
  assert.throws(() => verifyPaymentPage({ ...base, url: 'https://bookings.wnba.org.nz/account/booking/abc12345#pay' }), /query or fragment/i);
  assert.throws(() => verifyPaymentPage({ ...base, url: 'https://bookings.wnba.org.nz/bookings/wellington-north-badminton-stadium/2026-10-26' }), /authenticated account payment page/i);
});

test('refuses a payment page whose rendered booking facts or state do not match', () => {
  const url = 'https://bookings.wnba.org.nz/account/booking/abc12345';
  const pageText = `Pay for booking
You are paying for your Wellington North Badminton Stadium booking of Monday 26 October at 9:30pm on Court 1.`;
  assert.deepEqual(verifyPaymentPage({ url, text: pageText, job, court: 'Court 1' }), { bookingId: 'abc12345' });
  assert.throws(() => verifyPaymentPage({ url, text: pageText.replace('Court 1', 'Court 2'), job, court: 'Court 1' }), /court/i);
  assert.throws(() => verifyPaymentPage({ url, text: pageText.replace('Monday 26 October', 'Tuesday 27 October'), job, court: 'Court 1' }), /date/i);
  assert.throws(() => verifyPaymentPage({ url, text: pageText.replace('9:30pm', '9:00pm'), job, court: 'Court 1' }), /start time/i);
  assert.throws(() => verifyPaymentPage({ url, text: `${pageText} Booking created`, job, court: 'Court 1' }), /completed booking/i);
  assert.throws(() => verifyPaymentPage({
    url, text: pageText, job, court: 'Court 1', bookingId: 'different-1',
  }), /does not match/i);
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
    id: 'abc12345',
  };
  assert.deepEqual(verifyRemoteBookingRecord(record, job, 'Court 1', 'free'), { ok: true });
  assert.deepEqual(verifyRemoteBookingRecord(record, job, 'Court 1', 'free', 'abc12345'), { ok: true });
  assert.throws(() => verifyRemoteBookingRecord({ ...record, court: 'Court 2' }, job, 'Court 1', 'free'), /court/i);
  assert.throws(() => verifyRemoteBookingRecord(record, job, 'Court 1', 'free', 'different-1'), /booking ID/i);
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
