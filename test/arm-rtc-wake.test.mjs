import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { armRtcWake, armRtcWakeForJob, HELPER_PATH, prepareRtcWakeRequest } from '../src/arm-rtc-wake.mjs';
import { OWNER } from '../src/rtc-wake.mjs';

const execFile = promisify(execFileCallback);
const helperTemplate = path.resolve(new URL('../templates/hello-club-arm-rtc-wake', import.meta.url).pathname);

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

test('root helper rejects every argument before reading a wake request', async () => {
  await assert.rejects(
    execFile('/bin/sh', [helperTemplate, 'unexpected-argument']),
    (error) => error.code === 64 && /accepts no arguments/.test(error.stderr),
  );
});

test('prepares one fixed-format RTC wake request with restrictive permissions', async () => {
  const requestDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hello-club-rtc-wake-'));
  try {
    const request = await prepareRtcWakeRequest(validJob, { requestDir });
    assert.equal(request.wakeAt, '2026-10-26T17:53:00.000Z');
    assert.equal(await fs.readFile(request.file, 'utf8'), '10/27/26 06:53:00\n');
    assert.equal((await fs.stat(request.file)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(requestDir, { recursive: true, force: true });
  }
});

test('arms a job by writing its restricted request before invoking the helper and verifies read-back', async () => {
  const requestDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hello-club-rtc-wake-'));
  const calls = [];
  let reads = 0;
  try {
    const request = await armRtcWakeForJob(validJob, {
      requestDir,
      run: async (file, args) => { calls.push({ file, args }); },
      readWakes: async () => {
        reads += 1;
        return reads === 1 ? [] : [{ key: '2026-10-27T06:53:00', owner: OWNER }];
      },
    });
    assert.equal(await fs.readFile(request.file, 'utf8'), '10/27/26 06:53:00\n');
    assert.deepEqual(calls, [{ file: '/usr/bin/sudo', args: ['-n', HELPER_PATH] }]);
    assert.equal(request.state, 'armed');
    assert.equal(reads, 2);
  } finally {
    await fs.rm(requestDir, { recursive: true, force: true });
  }
});

test('deduplicates an already-matching RTC wake without invoking sudo', async () => {
  const requestDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hello-club-rtc-wake-'));
  const calls = [];
  try {
    const request = await armRtcWakeForJob(validJob, {
      requestDir,
      run: async (file, args) => { calls.push({ file, args }); },
      readWakes: async () => [{ key: '2026-10-27T06:53:00', owner: OWNER }],
    });
    assert.equal(request.state, 'already_armed');
    assert.deepEqual(calls, []);
    await assert.rejects(fs.stat(path.join(requestDir, 'rtc-wake.txt')), /ENOENT/);
  } finally {
    await fs.rm(requestDir, { recursive: true, force: true });
  }
});

test('refuses to arm when an owner event for a different time already exists', async () => {
  const requestDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hello-club-rtc-wake-'));
  const calls = [];
  try {
    await assert.rejects(armRtcWakeForJob(validJob, {
      requestDir,
      run: async (file, args) => { calls.push({ file, args }); },
      readWakes: async () => [{ key: '2026-10-28T06:53:00', owner: OWNER }],
    }), /RTC wake conflict/i);
    assert.deepEqual(calls, []);
    await assert.rejects(fs.stat(path.join(requestDir, 'rtc-wake.txt')), /ENOENT/);
  } finally {
    await fs.rm(requestDir, { recursive: true, force: true });
  }
});

test('fails closed when the helper does not produce exactly one matching event', async () => {
  const requestDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hello-club-rtc-wake-'));
  let reads = 0;
  try {
    await assert.rejects(armRtcWakeForJob(validJob, {
      requestDir,
      run: async () => {},
      readWakes: async () => {
        reads += 1;
        return reads === 1 ? [] : [{ key: '2026-10-27T06:53:00', owner: OWNER }, { key: '2026-10-27T06:53:00', owner: OWNER }];
      },
    }), /read-back did not show exactly one matching event/i);
    assert.equal(reads, 2);
  } finally {
    await fs.rm(requestDir, { recursive: true, force: true });
  }
});
