import test from 'node:test';
import assert from 'node:assert/strict';
import { isTransientBrowserError } from '../src/recurring-booking.mjs';

test('recognizes a closed-page failure as retryable', () => {
  assert.equal(isTransientBrowserError(new Error('page.goto: Target page, context or browser has been closed')), true);
  assert.equal(isTransientBrowserError(new Error('connect ECONNREFUSED 127.0.0.1:9223')), true);
  assert.equal(isTransientBrowserError(new Error('Target closed')), true);
});

test('does not retry a peak-boundary or validation error', () => {
  assert.equal(isTransientBrowserError(new Error('Booking interval crosses the weekday peak boundary at 17:00')), false);
  assert.equal(isTransientBrowserError(new Error('Opening grid was not ready with a complete permitted interval')), false);
});
