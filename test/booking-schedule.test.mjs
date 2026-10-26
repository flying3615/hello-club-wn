import test from 'node:test';
import assert from 'node:assert/strict';
import { planBookingRun } from '../src/booking-schedule.mjs';

test('plans a future target as a prewarmed scheduled job', () => {
  const plan = planBookingRun('2026-11-03', { nowMs: Date.parse('2026-10-26T13:00:00+13:00') });
  assert.deepEqual(plan, {
    action: 'schedule',
    openAtMs: Date.parse('2026-10-27T07:00:00+13:00'),
    prepareAtMs: Date.parse('2026-10-27T06:57:00+13:00'),
    latestStartMs: Date.parse('2026-10-27T07:05:00+13:00'),
  });
});

test('plans an already-open target for immediate execution', () => {
  const nowMs = Date.parse('2026-10-27T08:30:00+13:00');
  const plan = planBookingRun('2026-11-03', { nowMs });
  assert.deepEqual(plan, {
    action: 'execute_now',
    openAtMs: Date.parse('2026-10-27T07:00:00+13:00'),
    prepareAtMs: null,
    latestStartMs: nowMs + 300_000,
  });
});
