import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseJsonLines, presentActivity, publicBooking, publicDispatch, publicJob, publicRun, readJsonLines, safeErrorCode,
} from '../src/control-panel-data.mjs';
import { REMOTE_BOOKING_SYNC_TTL_MS } from '../src/control-panel-server.mjs';

test('uses a 12-hour cache for Hello Club booking synchronization', () => {
  assert.equal(REMOTE_BOOKING_SYNC_TTL_MS, 43_200_000);
});

test('exposes only the safe booking job fields needed by the monitor', () => {
  const job = publicJob({
    id: 'monday-watch', date: '2026-10-26', start: '21:30', end: '23:00',
    bookingType: 'Stadium Pass - Singles', participants: ['Yufei Liu', 'Zijia Liu'],
    courtOrder: ['Court 4'], paymentPolicy: 'cancel-on-payment', submit: false,
    password: 'must-never-appear', cdpEndpoint: 'must-never-appear',
  });
  assert.deepEqual(job, {
    id: 'monday-watch', date: '2026-10-26', start: '21:30', end: '23:00',
    bookingType: 'Stadium Pass - Singles', participants: ['Yufei Liu', 'Zijia Liu'],
    courtOrder: ['Court 4'], paymentPolicy: 'cancel-on-payment', submit: false,
  });
});

test('filters and redacts runner records before they reach the panel', () => {
  const run = publicRun({
    status: 'failed', timestamp: '2026-10-25T00:00:00.000Z',
    errorCode: 'password missing for user', cdpEndpoint: 'http://127.0.0.1:9223',
  });
  assert.deepEqual(run, { status: 'failed', timestamp: '2026-10-25T00:00:00.000Z', errorCode: 'redacted_error' });
  assert.equal(safeErrorCode('normal validation failure'), 'normal validation failure');
});

test('accepts only remote-verified booking records with explicit payment state', () => {
  const record = {
    id: 'booking-2026-10-26-court-1', date: '2026-10-26', start: '21:30', end: '23:00', court: 'Court 1',
    bookingType: 'Stadium Pass - Singles', participants: ['Yufei Liu', 'Zijia Liu'], paymentStatus: 'unpaid_hold',
    verifiedAt: '2026-10-25T00:00:00.000Z', rawPage: 'private data',
  };
  assert.equal(publicBooking(record).court, 'Court 1');
  assert.equal(publicBooking({ ...record, paymentStatus: 'candidate' }), null);
  const remote = publicBooking({ ...record, id: 'remote-1', participants: ['Yufei Liu', 'Player A', 'Player B'], paymentStatus: 'paid', source: 'helloclub' });
  assert.deepEqual(remote, {
    id: 'remote-1', date: '2026-10-26', start: '21:30', end: '23:00', court: 'Court 1',
    bookingType: 'Stadium Pass - Singles', participants: ['Yufei Liu', 'Player A', 'Player B'], paymentStatus: 'paid',
    verifiedAt: '2026-10-25T00:00:00.000Z', source: 'helloclub',
  });
});

test('reads verified booking records from one JSONL file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hello-club-panel-'));
  const file = path.join(directory, 'confirmed.jsonl');
  await fs.writeFile(file, `${JSON.stringify({
    id: 'booking-2026-10-26-court-1', date: '2026-10-26', start: '21:30', end: '23:00', court: 'Court 1',
    bookingType: 'Stadium Pass - Singles', participants: ['Yufei Liu', 'Zijia Liu'], paymentStatus: 'free',
    verifiedAt: '2026-10-25T00:00:00.000Z',
  })}\n`);
  try {
    const records = await readJsonLines(file, publicBooking);
    assert.equal(records.length, 1);
    assert.equal(records[0].paymentStatus, 'free');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('ignores malformed JSONL lines and puts latest activity first', () => {
  const runs = parseJsonLines(
    '{"status":"watch_complete","timestamp":"2026-10-25T00:00:00.000Z"}\nnot-json\n', publicRun,
  );
  const dispatch = publicDispatch({ status: 'running', jobId: 'monday-watch', timestamp: '2026-10-25T00:00:01.000Z' });
  const activity = presentActivity({ runs, dispatches: [dispatch] });
  assert.equal(activity.length, 2);
  assert.equal(activity[0].kind, 'dispatcher');
  assert.equal(activity[1].kind, 'runner');
});
