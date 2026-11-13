import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_COURT_ORDER } from './booking-policy.mjs';
import { connectExistingChrome, openBookingPage } from './session.mjs';
import { locateTargetCalendarGridRoot } from './opening-watch.mjs';
import { scanBookingGrid } from './booking-grid.mjs';
import { nearbyAvailableRuns } from './availability.mjs';
import { openingInstantForTargetDate } from './opening-window.mjs';
import { runLaunchdJob } from './launchd-runner.mjs';
import { validateBookingJob } from './launchd-job.mjs';
import { getRecurringTask } from './recurring-tasks.mjs';

const PROJECT_DIR = path.resolve(new URL('..', import.meta.url).pathname);
const STATE_DIR = path.join(PROJECT_DIR, 'state');
const ACTIVE_JOB_FILE = path.join(STATE_DIR, 'jobs', 'active.json');
const AUCKLAND_ZONE = 'Pacific/Auckland';
const DEFAULT_PARTICIPANTS = ['Yufei Liu', 'Zijia Liu'];
const TRANSIENT_BROWSER_ERROR = new RegExp([
  'Target page, context or browser has been closed', 'Target closed', 'Target crashed', 'page crashed',
  'browser has been closed', 'ECONNREFUSED', 'ECONNRESET', 'socket hang up', 'WebSocket', 'connect.*CDP',
  'Execution context was destroyed', 'frame was detached', 'net::ERR_', 'page\\.goto: Timeout',
  'Target grid did not become ready after reload',
].join('|'), 'i');
// Short delays first: after the opening every second counts. Retries continue until the
// job's latestStart rather than stopping after a fixed number of attempts.
const RETRY_DELAYS_MS = [1_000, 2_000, 3_000, 5_000];
const MAX_RETRY_ATTEMPTS = 30;

export function retryDelayMs(attempt) {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
}

export function shouldRetry({ error, attempt, nowMs, latestStartMs }) {
  return isTransientBrowserError(error)
    && attempt < MAX_RETRY_ATTEMPTS
    && nowMs + retryDelayMs(attempt) < latestStartMs;
}

export function isTransientBrowserError(error) {
  return TRANSIENT_BROWSER_ERROR.test(String(error?.message || error || ''));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function aucklandParts(value) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new Error('A valid current time is required');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: AUCKLAND_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
  }).formatToParts(value);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

export function targetDateForTask(now, task) {
  const parts = aucklandParts(now);
  if (!task.weekdays.includes(parts.weekday)) {
    const expected = task.weekdays.join(' or ');
    throw new Error(`${task.id} booking must run on ${expected}, not ${parts.weekday}`);
  }
  const target = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  target.setUTCDate(target.getUTCDate() + 7);
  return target.toISOString().slice(0, 10);
}

export function buildRecurringJob({
  task,
  now = new Date(),
  participants = DEFAULT_PARTICIPANTS,
  courtOrder = DEFAULT_COURT_ORDER,
} = {}) {
  const date = targetDateForTask(now, task);
  const openAtMs = openingInstantForTargetDate(date);
  const latestStartMs = openAtMs + 5 * 60_000;
  if (now.getTime() > latestStartMs) throw new Error(`${task.id} booking window has passed`);
  const job = {
    id: `${date}-${task.start.replace(':', '')}`,
    date,
    start: task.start,
    end: task.end,
    openAt: new Date(openAtMs).toISOString(),
    prepareAt: new Date(openAtMs - 3 * 60_000).toISOString(),
    latestStart: new Date(latestStartMs).toISOString(),
    bookingType: 'Stadium Pass - Singles',
    participants: [...participants],
    courtOrder: [...courtOrder],
    paymentPolicy: 'cancel-on-payment',
    submit: true,
    ...(task.flexible ? { flexible: true } : {}),
  };
  return validateBookingJob(job, { mode: 'execute' });
}

function todayFileStamp(now) {
  const parts = aucklandParts(now);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function appendRun(run, now) {
  const directory = path.join(STATE_DIR, 'launchd', 'runs');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${todayFileStamp(now)}.jsonl`);
  await fs.appendFile(file, `${JSON.stringify(run)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(file, 0o600);
  return file;
}

async function archiveJob(jobFile, job, status) {
  const directory = path.join(STATE_DIR, 'jobs', status);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${job.id}.json`);
  await fs.rename(jobFile, target);
  await fs.chmod(target, 0o600);
  return target;
}

async function writeReport(report, task, now) {
  const directory = path.join(STATE_DIR, 'reports');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${task.id}-${report.targetDate || todayFileStamp(now)}.json`);
  await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(file, 0o600);
  return file;
}

async function scanAdjacent(targetDate) {
  const { browser, context } = await connectExistingChrome();
  const page = await openBookingPage(context, targetDate);
  try {
    const root = await locateTargetCalendarGridRoot(page, targetDate);
    const grid = await scanBookingGrid(root);
    return nearbyAvailableRuns(grid, { windowStart: '06:00', windowEnd: '19:30' });
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

export async function runRecurringBooking({
  taskId,
  now = new Date(),
  participants,
  courtOrder,
} = {}) {
  const task = getRecurringTask(taskId);
  const job = buildRecurringJob({ task, now, participants, courtOrder });
  try {
    await fs.access(ACTIVE_JOB_FILE);
    throw new Error('An active booking job already exists; recurring run skipped');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const jobFile = path.join(STATE_DIR, 'jobs', `${task.id}-${job.date}.json`);
  await fs.mkdir(path.dirname(jobFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(jobFile, `${JSON.stringify(job)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(jobFile, 0o600);

  let result = null;
  let failure = null;
  const startedAt = new Date().toISOString();
  const attemptErrors = [];
  for (let attempt = 0; ; attempt += 1) {
    try {
      result = await runLaunchdJob({ jobFile, mode: 'execute' });
      failure = null;
      break;
    } catch (error) {
      failure = error;
      attemptErrors.push({ at: new Date().toISOString(), error: String(error?.message || error).slice(0, 200) });
      console.log(JSON.stringify({ status: 'attempt_failed', taskId: task.id, jobId: job.id, attempt: attempt + 1, error: attemptErrors.at(-1).error, at: attemptErrors.at(-1).at }));
      if (!shouldRetry({ error, attempt, nowMs: Date.now(), latestStartMs: Date.parse(job.latestStart) })) break;
      await sleep(retryDelayMs(attempt));
    }
  }

  const verifiedStatus = result && ['booking_verified', 'reconciled_verified'].includes(result.status);
  if (verifiedStatus) {
    const court = result.selection?.court || null;
    const segments = result.selection?.segments || null;
    // The runner already verified the booking against the remote calendar and returns its ID.
    const remote = result.remoteBookingId ? { id: result.remoteBookingId } : null;
    await appendRun({
      status: result.status || 'booking_verified',
      mode: 'execute',
      taskId: task.id,
      jobId: job.id,
      timestamp: startedAt,
      startedAt: result.startedAt || startedAt,
      firstGridAt: result.firstGridAt,
      finishedAt: result.finishedAt,
      selection: result.selection,
      paymentStatus: result.paymentStatus,
      timeline: result.timeline,
    }, now);
    const archived = await archiveJob(jobFile, job, 'completed');
    const report = await writeReport({
      status: 'success',
      taskId: task.id,
      targetDate: job.date,
      job,
      court,
      segments,
      tier: result.selection?.tier || null,
      paymentStatus: result.paymentStatus,
      remoteBookingId: remote?.id || segments?.[0]?.remoteBookingId || null,
      verifiedAt: result.finishedAt || new Date().toISOString(),
      timeline: result.timeline,
      archived,
    }, task, now);
    console.log(JSON.stringify({ status: 'recurring_success', taskId: task.id, targetDate: job.date, court, segments, remoteBookingId: remote?.id || null, report }));
    return { status: 'success', task, job, court, remote, report };
  }

  const message = String(failure?.message || result?.errorCode || result?.status || 'Recurring booking did not verify').slice(0, 500);
  let adjacent;
  try {
    adjacent = await scanAdjacent(job.date);
  } catch (error) {
    adjacent = { window: { start: '06:00', end: '19:30' }, runs: [], error: String(error?.message || error).slice(0, 300) };
  }
  await appendRun({
    status: 'failed',
    mode: 'execute',
    taskId: task.id,
    jobId: job.id,
    timestamp: startedAt,
    errorCode: message,
    attempts: attemptErrors,
    timeline: failure?.timeline,
    adjacent,
  }, now);
  const archived = await archiveJob(jobFile, job, 'failed');
  const report = await writeReport({
    status: 'failed',
    taskId: task.id,
    targetDate: job.date,
    job,
    error: message,
    attempts: attemptErrors,
    timeline: failure?.timeline,
    adjacent,
    archived,
  }, task, now);
  console.log(JSON.stringify({ status: 'recurring_failed', taskId: task.id, targetDate: job.date, error: message, adjacent, report }));
  return { status: 'failed', task, job, error: message, adjacent, report };
}

export async function mainForTask(taskId) {
  try {
    const result = await runRecurringBooking({ taskId });
    if (result.status !== 'success') process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ status: 'recurring_skipped', taskId, error: String(error?.message || error).slice(0, 500) }));
    process.exitCode = 2;
  }
}

export { DEFAULT_PARTICIPANTS };
