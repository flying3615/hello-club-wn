import test from 'node:test';
import assert from 'node:assert/strict';
import { isBookingContentReady } from '../src/session.mjs';

test('does not treat a Loading placeholder as a ready booking page', () => {
  assert.equal(isBookingContentReady('Loading...'), false);
  assert.equal(isBookingContentReady(''), false);
});

test('recognizes a rendered booking page', () => {
  assert.equal(
    isBookingContentReady('Bookings\nWellington North Badminton Stadium\nCourt 1\nCourt 4'),
    true,
  );
});
