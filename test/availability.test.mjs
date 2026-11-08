import test from 'node:test';
import assert from 'node:assert/strict';
import { availableRuns, nearbyAvailableRuns } from '../src/availability.mjs';

function column(court, availableRanges) {
  const slots = Array.from({ length: 48 }, (_, index) => {
    const minutes = index * 30;
    const start = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const endMinutes = minutes + 30;
    const end = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;
    const available = availableRanges.some(([from, to]) => start >= from && end <= to);
    return { start, end, available };
  });
  return { court, slots };
}

test('summarizes contiguous available runs per court', () => {
  const grid = [column('Court 1', [['08:00', '09:30'], ['10:00', '11:00']])];
  assert.deepEqual(availableRuns(grid), [{
    court: 'Court 1',
    runs: [{ start: '08:00', end: '09:30' }, { start: '10:00', end: '11:00' }],
  }]);
});

test('lists nearby runs inside the requested window and sorts them', () => {
  const grid = [
    column('Court 1', [['05:00', '06:00'], ['07:00', '08:00'], ['10:00', '11:30']]),
    column('Court 2', [['08:30', '09:30']]),
  ];
  const result = nearbyAvailableRuns(grid, { windowStart: '06:00', windowEnd: '12:00' });
  assert.deepEqual(result, {
    window: { start: '06:00', end: '12:00' },
    runs: [
      { court: 'Court 1', start: '07:00', end: '08:00' },
      { court: 'Court 2', start: '08:30', end: '09:30' },
      { court: 'Court 1', start: '10:00', end: '11:30' },
    ],
  });
});

test('returns an empty list when no nearby runs are available', () => {
  const grid = [column('Court 1', [['01:00', '02:00']])];
  assert.deepEqual(nearbyAvailableRuns(grid), { window: { start: '06:00', end: '12:00' }, runs: [] });
});
