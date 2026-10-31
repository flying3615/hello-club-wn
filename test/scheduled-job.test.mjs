import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildScheduledJob, scheduleFutureJob } from '../src/scheduled-job.mjs';

const validJob = {
  id: 'tuesday-2026-11-03-2030',
  date: '2026-11-03',
  start: '20:30',
  end: '21:00',
  prepareAt: '2026-10-27T06:57:00+13:00',
  openAt: '2026-10-27T07:00:00+13:00',
  latestStart: '2026-10-27T07:05:00+13:00',
  bookingType: 'Stadium Pass - Singles',
  participants: ['Yufei Liu', 'Zijia Liu'],
  courtOrder: ['Court 4', 'Court 5', 'Court 6', 'Court 1', 'Court 2', 'Court 3'],
  paymentPolicy: 'cancel-on-payment',
  submit: true,
};

test('arms RTC wake before atomically creating a future active job', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hello-club-scheduled-job-'));
  const activeJobFile = path.join(directory, 'active.json');
  const calls = [];
  try {
    const result = await scheduleFutureJob({
      job: validJob,
      activeJobFile,
      nowMs: Date.parse('2026-10-26T12:00:00+13:00'),
      arm: async (job) => { calls.push(job.id); return { pmsetDate: '10/27/26 06:53:00' }; },
    });
    assert.deepEqual(calls, ['tuesday-2026-11-03-2030']);
    assert.equal(result.status, 'scheduled_and_wake_armed');
    assert.equal(JSON.parse(await fs.readFile(activeJobFile, 'utf8')).id, validJob.id);
    assert.equal((await fs.stat(activeJobFile)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('does not create an active job when RTC arming fails', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hello-club-scheduled-job-'));
  const activeJobFile = path.join(directory, 'active.json');
  try {
    await assert.rejects(scheduleFutureJob({
      job: validJob,
      activeJobFile,
      nowMs: Date.parse('2026-10-26T12:00:00+13:00'),
      arm: async () => { throw new Error('not authorized'); },
    }), /not authorized/);
    await assert.rejects(fs.stat(activeJobFile), /ENOENT/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('refuses to replace an existing active job before arming the wake', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hello-club-scheduled-job-'));
  const activeJobFile = path.join(directory, 'active.json');
  let armed = false;
  try {
    await fs.writeFile(activeJobFile, `${JSON.stringify({ id: 'existing-job' })}\n`, { mode: 0o600 });
    await assert.rejects(scheduleFutureJob({
      job: validJob,
      activeJobFile,
      nowMs: Date.parse('2026-10-26T12:00:00+13:00'),
      arm: async () => { armed = true; return { pmsetDate: '10/27/26 06:53:00' }; },
    }), /active job already exists/i);
    assert.equal(armed, false);
    assert.equal(JSON.parse(await fs.readFile(activeJobFile, 'utf8')).id, 'existing-job');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('derives a validated future job and its exact prewarm timestamps', () => {
  const job = buildScheduledJob({
    date: '2026-11-03',
    start: '20:30',
    end: '21:00',
    participants: ['Yufei Liu', 'Zijia Liu'],
    submit: true,
    nowMs: Date.parse('2026-10-26T12:00:00+13:00'),
  });
  assert.equal(job.id, '2026-11-03-2030');
  assert.equal(job.openAt, '2026-10-26T18:00:00.000Z');
  assert.equal(job.prepareAt, '2026-10-26T17:57:00.000Z');
  assert.equal(job.latestStart, '2026-10-26T18:05:00.000Z');
  assert.equal(job.submit, true);
  assert.equal(job.bookingType, 'Stadium Pass - Singles');
  assert.deepEqual(job.courtOrder, ['Court 4', 'Court 5', 'Court 6', 'Court 1', 'Court 2', 'Court 3']);
});

test('builds a read-only watch job by default and honors explicit overrides', () => {
  const job = buildScheduledJob({
    date: '2026-11-03',
    start: '20:30',
    end: '21:00',
    participants: ['Yufei Liu', 'Zijia Liu'],
    id: 'tuesday-probe',
    courtOrder: ['Court 1', 'Court 2'],
    latestStartMs: Date.parse('2026-10-26T18:02:00.000Z'),
    nowMs: Date.parse('2026-10-26T12:00:00+13:00'),
  });
  assert.equal(job.id, 'tuesday-probe');
  assert.equal(job.submit, false);
  assert.deepEqual(job.courtOrder, ['Court 1', 'Court 2']);
  assert.equal(job.latestStart, '2026-10-26T18:02:00.000Z');
});

test('refuses to build a job after its opening instant or with invalid participants', () => {
  assert.throws(() => buildScheduledJob({
    date: '2026-11-03',
    start: '20:30',
    end: '21:00',
    participants: ['Yufei Liu', 'Zijia Liu'],
    nowMs: Date.parse('2026-10-27T07:00:00+13:00'),
  }), /future opening instant/i);
  assert.throws(() => buildScheduledJob({
    date: '2026-11-03',
    start: '20:30',
    end: '21:00',
    participants: ['Yufei Liu'],
    nowMs: Date.parse('2026-10-26T12:00:00+13:00'),
  }), /exactly two participants/i);
});
