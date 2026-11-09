import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPeakBoundary, peakWindowForDate } from '../src/peak-time.mjs';

test('uses weekday and weekend peak windows', () => {
  assert.deepEqual(peakWindowForDate('2026-11-09'), { dayType: 'weekday', weekday: 'Monday', start: '17:00', end: '21:30' });
  assert.deepEqual(peakWindowForDate('2026-11-14'), { dayType: 'weekend', weekday: 'Saturday', start: '13:00', end: '21:00' });
  assert.deepEqual(peakWindowForDate('2026-11-15'), { dayType: 'weekend', weekday: 'Sunday', start: '13:00', end: '21:00' });
});

test('allows intervals ending exactly at the weekday peak start', () => {
  assert.doesNotThrow(() => assertPeakBoundary({ date: '2026-11-09', start: '15:30', end: '17:00' }));
});

test('rejects a weekday interval that crosses into peak', () => {
  assert.throws(
    () => assertPeakBoundary({ date: '2026-11-09', start: '15:30', end: '17:30' }),
    /weekday peak boundary at 17:00/,
  );
});

test('allows an interval entirely inside weekday peak', () => {
  assert.doesNotThrow(() => assertPeakBoundary({ date: '2026-11-09', start: '17:00', end: '18:30' }));
  assert.doesNotThrow(() => assertPeakBoundary({ date: '2026-11-09', start: '20:30', end: '21:30' }));
});

test('rejects a weekday interval that crosses the peak end', () => {
  assert.throws(
    () => assertPeakBoundary({ date: '2026-11-09', start: '21:00', end: '22:00' }),
    /weekday peak boundary at 21:30/,
  );
});

test('uses 13:00 and 21:00 as the weekend boundaries', () => {
  assert.doesNotThrow(() => assertPeakBoundary({ date: '2026-11-14', start: '11:30', end: '13:00' }));
  assert.throws(
    () => assertPeakBoundary({ date: '2026-11-14', start: '12:30', end: '13:30' }),
    /weekend peak boundary at 13:00/,
  );
  assert.doesNotThrow(() => assertPeakBoundary({ date: '2026-11-14', start: '13:00', end: '14:30' }));
  assert.throws(
    () => assertPeakBoundary({ date: '2026-11-15', start: '20:30', end: '21:30' }),
    /weekend peak boundary at 21:00/,
  );
});

test('allows a complete interval inside weekend peak', () => {
  assert.doesNotThrow(() => assertPeakBoundary({ date: '2026-11-15', start: '15:30', end: '17:30' }));
});
