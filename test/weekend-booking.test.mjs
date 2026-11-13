import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWeekendJob, targetDateFor } from '../src/weekend-booking.mjs';

test('targets the same weekday seven days ahead', () => {
  assert.equal(targetDateFor(new Date('2026-11-14T06:54:00+13:00')), '2026-11-21');
  assert.equal(targetDateFor(new Date('2026-11-15T06:54:00+13:00')), '2026-11-22');
  assert.throws(() => targetDateFor(new Date('2026-11-12T06:54:00+13:00')), /Saturday or Sunday/i);
});

test('builds a flexible 08:00-10:00 weekend job for the next opening', () => {
  const job = buildWeekendJob({ now: new Date('2026-11-14T06:54:00+13:00') });
  assert.equal(job.id, '2026-11-21-0800');
  assert.equal(job.date, '2026-11-21');
  assert.equal(job.start, '08:00');
  assert.equal(job.end, '10:00');
  assert.equal(job.flexible, true);
  assert.equal(job.openAt, '2026-11-13T18:00:00.000Z');
  assert.equal(job.prepareAt, '2026-11-13T17:57:00.000Z');
  assert.equal(job.latestStart, '2026-11-13T18:05:00.000Z');
  assert.equal(job.submit, true);
  assert.deepEqual(job.participants, ['Yufei Liu', 'Zijia Liu']);
});

test('refuses a weekend run after the opening deadline', () => {
  assert.throws(
    () => buildWeekendJob({ now: new Date('2026-11-14T07:10:00+13:00') }),
    /window has passed/i,
  );
});
