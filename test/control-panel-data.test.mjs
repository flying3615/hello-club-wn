import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  explainRunFailure, parseJsonLines, presentActivity, publicBooking, publicDispatch, publicJob, publicRun, publicWeekendReport, readJsonLines, safeErrorCode,
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

test('explains the opening-grid failure with the failed job interval', () => {
  const run = {
    status: 'failed', jobId: '2026-11-08-1800', timestamp: '2026-10-31T18:00:18.954Z',
    errorCode: 'Opening grid was not ready with a complete permitted interval',
  };
  const job = { id: '2026-11-08-1800', date: '2026-11-08', start: '18:00', end: '19:00' };
  const failure = explainRunFailure(run, job);
  assert.equal(failure.title, '上次预约未成功');
  assert.match(failure.reason, /18:00–19:00/);
  assert.match(failure.action, /未创建预约/);
  assert.equal(failure.attemptedAt, run.timestamp);
  assert.deepEqual(failure.job, job);
  assert.equal(failure.code, run.errorCode);
  assert.equal(explainRunFailure({ status: 'completed', timestamp: run.timestamp }), null);
});

test('does not claim no booking when payment or remote verification is uncertain', () => {
  const payment = explainRunFailure({ status: 'failed', errorCode: 'Payment handoff is not an authenticated account payment page' });
  assert.match(payment.action, /未批准任何支付/);
  assert.doesNotMatch(payment.action, /未创建预约/);
  const remote = explainRunFailure({ status: 'failed', errorCode: 'Remote calendar did not show a newly created exact booking in time' });
  assert.match(remote.action, /可能已存在预约/);
  const unknown = explainRunFailure({ status: 'failed', errorCode: 'password missing for user' });
  assert.equal(unknown.code, 'redacted_error');
  assert.match(unknown.action, /远端日历确认/);
});


test('passes sanitized adjacent availability into the failure explanation', () => {
  const run = publicRun({
    status: 'failed', jobId: 'weekend-2026-11-21-0800', timestamp: '2026-11-14T18:00:20.000Z',
    errorCode: 'Opening grid was not ready with a complete permitted interval',
    adjacent: { window: { start: '06:00', end: '12:00' }, runs: [{ court: 'Court 1', start: '06:30', end: '08:00', secret: 'x' }] },
  });
  assert.deepEqual(run.adjacent, { window: { start: '06:00', end: '12:00' }, runs: [{ court: 'Court 1', start: '06:30', end: '08:00' }] });
  const failure = explainRunFailure(run, { id: 'weekend-2026-11-21-0800', date: '2026-11-21', start: '08:00', end: '09:30' });
  assert.deepEqual(failure.adjacent, [{ court: 'Court 1', start: '06:30', end: '08:00' }]);
  assert.deepEqual(failure.adjacentWindow, { start: '06:00', end: '12:00' });
});


test('uses only safe fields from the weekend report', () => {
  const report = publicWeekendReport({
    status: 'failed', targetDate: '2026-11-21', court: 'Court 1', error: 'Opening grid was not ready with a complete permitted interval',
    adjacent: { window: { start: '06:00', end: '12:00' }, runs: [{ court: 'Court 1', start: '06:30', end: '08:00' }] },
    job: { participants: ['private'] }, archived: '/private/path', secret: 'x',
  });
  assert.deepEqual(report, {
    status: 'failed', targetDate: '2026-11-21', court: 'Court 1',
    error: 'Opening grid was not ready with a complete permitted interval',
    adjacent: { window: { start: '06:00', end: '12:00' }, runs: [{ court: 'Court 1', start: '06:30', end: '08:00' }] },
  });
  assert.equal(publicWeekendReport({ status: 'failed', targetDate: 'not-a-date' }), null);
});


test('explains a missing selection modal without claiming a booking', () => {
  const failure = explainRunFailure({
    status: 'failed', jobId: '2026-11-16-1530', timestamp: '2026-11-09T07:00:31.000Z',
    errorCode: 'locator.waitFor: Timeout 5000ms exceeded. Call log: - waiting for locator(.modal-wrapper:visible)',
  });
  assert.match(failure.reason, /预约弹窗/);
  assert.match(failure.action, /未创建预约/);
  assert.match(failure.action, /不会自动改订/);
});


test('explains a peak boundary rejection without claiming a booking', () => {
  const failure = explainRunFailure({
    status: 'failed', jobId: '2026-11-16-1530', timestamp: '2026-11-09T07:00:31.000Z',
    errorCode: 'Booking interval crosses the weekday peak boundary at 17:00; choose an interval entirely before or after peak time',
  });
  assert.match(failure.reason, /peak/);
  assert.match(failure.action, /未提交预约/);
  assert.match(failure.action, /不会自动拆分/);
});
