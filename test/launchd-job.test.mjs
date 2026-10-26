import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBookingJob, validateLoopbackCdpEndpoint } from '../src/launchd-job.mjs';
import { openingInstantForTargetDate } from '../src/opening-window.mjs';
import { boundedTimeoutMs } from '../src/launchd-runner.mjs';
import { canReplaceDispatchMarker, dispatchAfterPrewarm, dispatchDecision, idleDelayMs } from '../src/launchd-dispatcher.mjs';
import { buildLaunchAgentPlist, buildPersistentDispatcherPlist } from '../src/launchd-plist.mjs';

const validJob = () => ({
  id: 'monday-evening-watch',
  date: '2026-10-26',
  start: '21:30',
  end: '23:00',
  openAt: '2026-10-19T07:00:00+13:00',
  latestStart: '2026-10-19T07:01:30+13:00',
  bookingType: 'Stadium Pass - Singles',
  participants: ['Yufei Liu', 'Zijia Liu'],
  courtOrder: ['Court 4', 'Court 5', 'Court 6', 'Court 1', 'Court 2', 'Court 3'],
  paymentPolicy: 'cancel-on-payment',
  submit: false,
});

test('accepts a complete safe local launchd job', () => {
  assert.deepEqual(validateBookingJob(validJob()), validJob());
});

test('derives the exact same-weekday seven-day opening instant', () => {
  assert.equal(openingInstantForTargetDate('2026-11-03'), Date.parse('2026-10-27T07:00:00+13:00'));
  assert.equal(openingInstantForTargetDate('2026-11-02'), Date.parse('2026-10-26T07:00:00+13:00'));
});

test('rejects a job whose opening instant is not the target weekday seven days earlier', () => {
  const job = validJob();
  job.date = '2026-11-03';
  job.openAt = '2026-10-26T07:00:00+13:00';
  job.latestStart = '2026-10-26T07:05:00+13:00';
  assert.throws(() => validateBookingJob(job), /openAt.*seven days/i);
});

test('rejects unsafe CDP endpoints', () => {
  for (const value of [
    'https://127.0.0.1:9223',
    'http://example.com:9223',
    'http://user:password@127.0.0.1:9223',
    'http://127.0.0.1:9223/path',
  ]) {
    assert.throws(() => validateLoopbackCdpEndpoint(value));
  }
  assert.equal(validateLoopbackCdpEndpoint('http://127.0.0.1:9223'), 'http://127.0.0.1:9223');
});

test('rejects malformed ranges, unknown courts and secret-like job fields', () => {
  const badRange = validJob();
  badRange.end = '21:30';
  assert.throws(() => validateBookingJob(badRange), /range/i);

  const badDate = validJob();
  badDate.date = '2026-02-30';
  assert.throws(() => validateBookingJob(badDate), /real calendar date/i);

  const badCourt = validJob();
  badCourt.courtOrder = ['Court 7'];
  assert.throws(() => validateBookingJob(badCourt), /court/i);

  const secret = validJob();
  secret.password = 'not-allowed';
  assert.throws(() => validateBookingJob(secret), /unknown|credential|secret/i);
});

test('requires explicit execution authority and only permits cancel-on-payment', () => {
  const job = validJob();
  assert.throws(() => validateBookingJob(job, { mode: 'execute' }), /submit/i);
  job.submit = true;
  assert.deepEqual(validateBookingJob(job, { mode: 'execute' }), job);
  job.paymentPolicy = 'pay';
  assert.throws(() => validateBookingJob(job), /payment/i);
});

test('caps launchd watcher timeouts at its bounded polling limit', () => {
  assert.equal(boundedTimeoutMs(1_000, 0), 1_000);
  assert.equal(boundedTimeoutMs(9_000_000, 0), 900_000);
  assert.equal(boundedTimeoutMs(0, 1_000), 1_000);
});

test('preserves a terminal dispatch marker against later missed checks', () => {
  assert.equal(canReplaceDispatchMarker('completed', 'missed'), false);
  assert.equal(canReplaceDispatchMarker('failed', 'missed'), false);
  assert.equal(canReplaceDispatchMarker('running', 'completed'), true);
});

test('re-dispatches immediately after a prewarm wait', async () => {
  const calls = [];
  const sleeps = [];
  const result = await dispatchAfterPrewarm({
    jobFile: '/tmp/active.json',
    now: () => calls.length === 0 ? 100 : 200,
    sleep: async (ms) => { sleeps.push(ms); },
    dispatchOnce: async ({ jobFile, nowMs }) => {
      calls.push({ jobFile, nowMs });
      return calls.length === 1 ? { status: 'waiting', delayMs: 57_000 } : { status: 'completed', jobId: 'monday-job' };
    },
  });
  assert.deepEqual(sleeps, [57_000]);
  assert.deepEqual(calls, [
    { jobFile: '/tmp/active.json', nowMs: 100 },
    { jobFile: '/tmp/active.json', nowMs: 200 },
  ]);
  assert.deepEqual(result, { status: 'completed', jobId: 'monday-job' });
});

test('runs the persistent dispatcher only inside the prewarm window', () => {
  const job = { ...validJob(), prepareAt: '2026-10-19T06:57:00+13:00' };
  assert.equal(dispatchDecision(job, Date.parse('2026-10-19T06:56:59+13:00')).action, 'wait');
  assert.equal(dispatchDecision(job, Date.parse('2026-10-19T06:57:00+13:00')).action, 'run');
  assert.equal(dispatchDecision(job, Date.parse('2026-10-19T07:01:31+13:00')).action, 'missed');
  assert.equal(idleDelayMs(), 900_000);
  assert.equal(idleDelayMs(Date.parse('2026-10-19T06:57:00+13:00') - Date.parse('2026-10-19T06:56:50+13:00')), 10_000);
});

test('builds a persistent Aqua dispatcher without KeepAlive loops', () => {
  const plist = buildPersistentDispatcherPlist({
    label: 'com.hermes.hello-club.dispatcher',
    nodePath: '/Users/yufei/.local/bin/node',
    projectDir: '/Users/yufei/project',
    jobPath: '/Users/yufei/project/state/jobs/active.json',
  });
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>900<\/integer>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>LimitLoadToSessionType<\/key>\s*<string>Aqua<\/string>/);
  assert.match(plist, /launchd-dispatcher\.mjs/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
});

test('builds a logged-in-user launch agent without KeepAlive', () => {
  const plist = buildLaunchAgentPlist({
    label: 'com.hello-club.booking.monday-evening-watch',
    nodePath: '/Users/yufei/.local/bin/node',
    projectDir: '/Users/yufei/project',
    jobPath: '/Users/yufei/project/state/jobs/monday-evening-watch.json',
    runAt: '2026-10-25T06:57:00+13:00',
  });
  assert.match(plist, /<key>LimitLoadToSessionType<\/key>\s*<string>Aqua<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
  assert.match(plist, /launchd-runner\.mjs/);
  assert.doesNotMatch(plist, /password|cookie|token|card/i);
});
