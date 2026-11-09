import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMondayJob, targetDateForMonday } from '../src/monday-booking.mjs';

test('targets next Monday for the weekly Monday booking', () => {
  assert.equal(targetDateForMonday(new Date('2026-11-09T06:54:00+13:00')), '2026-11-16');
  assert.equal(targetDateForMonday(new Date('2026-11-16T06:54:00+13:00')), '2026-11-23');
  assert.throws(() => targetDateForMonday(new Date('2026-11-10T06:54:00+13:00')), /Monday/i);
});

test('builds a fixed 15:30-17:00 Monday job', () => {
  const job = buildMondayJob({ now: new Date('2026-11-09T06:54:00+13:00') });
  assert.equal(job.id, '2026-11-16-1530');
  assert.equal(job.date, '2026-11-16');
  assert.equal(job.start, '15:30');
  assert.equal(job.end, '17:00');
  assert.equal(job.openAt, '2026-11-08T18:00:00.000Z');
  assert.equal(job.latestStart, '2026-11-08T18:05:00.000Z');
  assert.equal(job.submit, true);
  assert.deepEqual(job.participants, ['Yufei Liu', 'Zijia Liu']);
});

test('refuses a Monday run after its opening deadline', () => {
  assert.throws(
    () => buildMondayJob({ now: new Date('2026-11-09T07:10:00+13:00') }),
    /window has passed/i,
  );
});
