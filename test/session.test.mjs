import test from 'node:test';
import assert from 'node:assert/strict';
import { isBookingContentReady, isTargetBookingUrl } from '../src/session.mjs';

test('does not treat a Loading placeholder as a ready booking page', () => {
  assert.equal(isBookingContentReady('Loading...'), false);
  assert.equal(isBookingContentReady('Loading...\nBookings\nCourt 1\nCourt 2\nCourt 3'), false);
  assert.equal(isBookingContentReady('Loading…\nCourt 1\nCourt 2'), false);
  assert.equal(isBookingContentReady(''), false);
});

test('recognizes a rendered booking page', () => {
  assert.equal(
    isBookingContentReady('Bookings\nWellington North Badminton Stadium\nCourt 1\nCourt 4'),
    true,
  );
});

test('rejects a booking page that redirected to a different date', () => {
  const target = 'https://bookings.wnba.org.nz/bookings/wellington-north-badminton-stadium/2026-11-08';
  assert.equal(isTargetBookingUrl(target, target), true);
  assert.equal(isTargetBookingUrl(`${target}?area=1`, target), true);
  assert.equal(isTargetBookingUrl(target.replace('2026-11-08', '2026-11-06'), target), false);
  assert.equal(isTargetBookingUrl(target.replace('bookings.wnba.org.nz', 'evil.example'), target), false);
  assert.equal(isTargetBookingUrl('not a url', target), false);
});
