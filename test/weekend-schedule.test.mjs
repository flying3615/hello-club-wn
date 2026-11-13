import test from 'node:test';
import assert from 'node:assert/strict';
import { nextRecurringRun, nextWeekendRun } from '../src/weekend-schedule.mjs';
import { RECURRING_TASKS } from '../src/recurring-tasks.mjs';

test('finds the next Saturday morning run and its target date', () => {
  const next = nextWeekendRun(new Date('2026-11-08T20:24:00+13:00'));
  assert.deepEqual(next, {
    at: '2026-11-13T17:57:00.000Z',
    local: '2026-11-14 06:57',
    date: '2026-11-14',
    weekday: 'Saturday',
    targetDate: '2026-11-21',
  });
});

test('uses today when the weekend run time is still ahead', () => {
  const next = nextWeekendRun(new Date('2026-11-14T06:00:00+13:00'));
  assert.equal(next.local, '2026-11-14 06:57');
  assert.equal(next.targetDate, '2026-11-21');
});

test('rolls from Saturday to Sunday after the Saturday run', () => {
  const next = nextWeekendRun(new Date('2026-11-14T07:00:00+13:00'));
  assert.equal(next.local, '2026-11-15 06:57');
  assert.equal(next.weekday, 'Sunday');
  assert.equal(next.targetDate, '2026-11-22');
});


test('finds the next Monday morning run for the Monday task', () => {
  const next = nextRecurringRun(new Date('2026-11-09T21:52:00+13:00'), RECURRING_TASKS.monday);
  assert.deepEqual(next, {
    at: '2026-11-15T17:57:00.000Z',
    local: '2026-11-16 06:57',
    date: '2026-11-16',
    weekday: 'Monday',
    targetDate: '2026-11-23',
  });
});
