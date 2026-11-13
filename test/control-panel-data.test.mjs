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
  assert.match(failure.detail, /换其他场地/);
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


test('explains a closed Chrome page without claiming a booking', () => {
  const failure = explainRunFailure({
    status: 'failed', jobId: '2026-11-21-0800', timestamp: '2026-11-13T17:54:02.000Z',
    errorCode: 'page.goto: Target page, context or browser has been closed',
  });
  assert.match(failure.reason, /Chrome/);
  assert.match(failure.action, /未创建预约/);
});

test('keeps flexible booking segments and retry attempts in public reports', async () => {
  const { publicRecurringReport, publicRun } = await import('../src/control-panel-data.mjs');
  const report = publicRecurringReport({
    status: 'success', targetDate: '2026-11-22', tier: 'full_window',
    job: { start: '08:00', end: '10:00', participants: ['secret'] },
    segments: [{ court: 'Court 4', start: '08:00', end: '09:00', paymentStatus: 'unpaid_hold', remoteBookingId: 'abc', extra: 'x' }, { court: 'Bad', start: 'x', end: 'y' }],
    attempts: [{ at: '2026-11-14T18:00:01Z', error: 'Target closed' }],
  });
  assert.deepEqual(report.segments, [{ court: 'Court 4', start: '08:00', end: '09:00', paymentStatus: 'unpaid_hold', remoteBookingId: 'abc' }]);
  assert.deepEqual(report.window, { start: '08:00', end: '10:00' });
  assert.equal(report.tier, 'full_window');
  assert.equal(report.attempts.length, 1);
  assert.equal(report.job, undefined);
  const run = publicRun({ status: 'booking_verified', timestamp: 't', taskId: 'weekend', selection: { court: 'Court 4', segments: [{ court: 'Court 4', start: '08:00', end: '10:00' }], secret: 1 } });
  assert.equal(run.selection.segments.length, 1);
  assert.equal(run.selection.secret, undefined);
  assert.equal(run.taskId, 'weekend');
});

test('reads the loaded LaunchAgent run time, caffeinate, and the repeating wake', async () => {
  const { launchAgentConfig, parseRepeatingWake } = await import('../src/control-panel-server.mjs');
  const print = `program = /usr/bin/caffeinate\n\targuments = {\n\t\t/usr/bin/caffeinate\n\t}\n\t\t"Hour" => 6\n\t\t"Minute" => 57\n`;
  assert.deepEqual(launchAgentConfig(print), { keepsAwake: true, loadedRunTime: '06:57' });
  assert.deepEqual(launchAgentConfig('program = /Users/x/node\n"Hour" => 6\n"Minute" => 54'), { keepsAwake: false, loadedRunTime: '06:54' });
  assert.deepEqual(parseRepeatingWake('Repeating power events:\n  wakepoweron at 6:56AM Some days\n'), { time: '06:56', days: 'Some days' });
  assert.equal(parseRepeatingWake('Scheduled power events:'), null);
});

test('classifies Hello Club sign-in from rendered text only', async () => {
  const { classifyLogin, probeAllowed, createLoginCache } = await import('../src/login-probe.mjs');
  assert.equal(classifyLogin({ url: 'https://x/bookings/a', bodyText: 'Courts\nYufei Liu\nCourt 1', memberName: 'Yufei Liu' }), 'signed_in');
  assert.equal(classifyLogin({ url: 'https://x/bookings/a', bodyText: 'Courts\nLog in\nCourt 1', memberName: 'Yufei Liu' }), 'signed_out');
  assert.equal(classifyLogin({ url: 'https://x/login?next=a', bodyText: 'Yufei', memberName: 'Yufei Liu' }), 'signed_out');
  assert.equal(classifyLogin({ url: 'https://x/bookings/a', bodyText: 'Court 1', memberName: 'Yufei Liu' }), 'unknown');
  // never probe around the 07:00 opening or during a run
  assert.equal(probeAllowed({ now: new Date('2026-11-14T17:55:00Z') }), false); // 06:55 NZDT
  assert.equal(probeAllowed({ now: new Date('2026-11-14T20:00:00Z') }), true); // 09:00 NZDT
  assert.equal(probeAllowed({ now: new Date('2026-11-14T20:00:00Z'), runnerActive: true }), false);
  let probes = 0;
  let clock = Date.parse('2026-11-14T20:00:00Z');
  const cache = createLoginCache({ probe: async () => { probes += 1; return 'signed_in'; }, now: () => clock });
  assert.equal((await cache.get({ memberName: 'Yufei Liu' })).state, 'signed_in');
  clock += 60_000;
  await cache.get({ memberName: 'Yufei Liu' });
  assert.equal(probes, 1);
  assert.equal((await cache.get({ cdpReachable: false })).state, 'unknown');
});

test('serves the cached calendar without opening tabs while refreshing is not allowed', async () => {
  const { createRemoteBookingCache } = await import('../src/remote-bookings.mjs');
  let reads = 0;
  let clock = 0;
  const cache = createRemoteBookingCache({ read: async () => { reads += 1; return [{ id: 'x' }]; }, ttlMs: 1_000, now: () => clock });
  assert.equal((await cache.get({ allowRefresh: false })).state, 'unavailable');
  assert.equal(reads, 0);
  await cache.get();
  clock = 5_000;
  const held = await cache.get({ allowRefresh: false, freshAfter: 4_000 });
  assert.equal(reads, 1);
  assert.equal(held.state, 'stale');
  assert.equal((await cache.get({ freshAfter: 4_000 })).state, 'fresh');
  assert.equal(reads, 2);
});

test('reads only the newest run files needed for the activity list', async () => {
  const os = await import('node:os');
  const { readJsonLines } = await import('../src/control-panel-data.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runs-'));
  await fs.writeFile(path.join(directory, '2026-11-01.jsonl'), '{"status":"old","timestamp":"2026-11-01T00:00:00Z"}\nnot json\n');
  await fs.writeFile(path.join(directory, '2026-11-14.jsonl'), '{"status":"a","timestamp":"2026-11-14T01:00:00Z"}\n{"status":"b","timestamp":"2026-11-14T02:00:00Z"}\n');
  const values = await readJsonLines(directory, (value) => value, { limit: 2 });
  assert.deepEqual(values.map((value) => value.status), ['b', 'a']);
  await fs.rm(directory, { recursive: true, force: true });
});

test('keeps only known phase labels and safe fields in a run timeline', async () => {
  const { publicTimeline } = await import('../src/control-panel-data.mjs');
  const timeline = publicTimeline([
    { label: 'open_at', at: '2026-11-14T18:00:00.000Z' },
    { label: 'confirm_clicked', at: '2026-11-14T18:00:02.400Z', court: 'Court 4', start: '08:00', secret: 'x' },
    { label: 'cookie', at: '2026-11-14T18:00:03.000Z' },
  ]);
  assert.deepEqual(timeline, [
    { label: 'open_at', at: '2026-11-14T18:00:00.000Z' },
    { label: 'confirm_clicked', at: '2026-11-14T18:00:02.400Z', court: 'Court 4', start: '08:00' },
  ]);
});
