import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { nearbyAvailableRuns } from './availability.mjs';
import { DEFAULT_COURT_ORDER } from './booking-policy.mjs';
import { connectExistingChrome, openBookingPage } from './session.mjs';
import { locateTargetCalendarGridRoot } from './opening-watch.mjs';
import { scanBookingGrid } from './booking-grid.mjs';
import { openingInstantForTargetDate } from './opening-window.mjs';
import { runLaunchdJob } from './launchd-runner.mjs';
import { validateBookingJob } from './launchd-job.mjs';
import { readRemoteBookings } from './remote-bookings.mjs';

const PROJECT_DIR = path.resolve(new URL('..', import.meta.url).pathname);
const STATE_DIR = path.join(PROJECT_DIR, 'state');
const ACTIVE_JOB_FILE = path.join(STATE_DIR, 'jobs', 'active.json');
const START = '08:00';
const END = '09:30';
const BOOKING_TYPE = 'Stadium Pass - Singles';
const DEFAULT_PARTICIPANTS = ['Yufei Liu', 'Zijia Liu'];
const AUCKLAND_ZONE = 'Pacific/Auckland';

function aucklandParts(value) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new Error('A valid current time is required');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: AUCKLAND_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
  }).formatToParts(value);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

export function targetDateFor(now = new Date()) {
  const parts = aucklandParts(now);
  if (!['Saturday', 'Sunday'].includes(parts.weekday)) {
    throw new Error(`Weekend booking must run on Saturday or Sunday, not ${parts.weekday}`);
  }
  const target = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  target.setUTCDate(target.getUTCDate() + 7);
  return target.toISOString().slice(0, 10);
}

export function buildWeekendJob({
  now = new Date(),
  participants = DEFAULT_PARTICIPANTS,
  courtOrder = DEFAULT_COURT_ORDER,
} = {}) {
  const date = targetDateFor(now);
  const openAtMs = openingInstantForTargetDate(date);
  const latestStartMs = openAtMs + 5 * 60_000;
  if (now.getTime() > latestStartMs) {
    throw new Error('Weekend booking window has passed');
  }
  const job = {
    id: `${date}-0800`,
    date,
    start: START,
    end: END,
    openAt: new Date(openAtMs).toISOString(),
    prepareAt: new Date(openAtMs - 3 * 60_000).toISOString(),
    latestStart: new Date(latestStartMs).toISOString(),
    bookingType: BOOKING_TYPE,
    participants: [...participants],
    courtOrder: [...courtOrder],
    paymentPolicy: 'cancel-on-payment',
    submit: true,
  };
  return validateBookingJob(job, { mode: 'execute' });
}

function todayFileStamp(now = new Date()) {
  const parts = aucklandParts(now);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function appendRun(run, now = new Date()) {
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

async function writeReport(report, now = new Date()) {
  const directory = path.join(STATE_DIR, 'reports');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `weekend-${report.targetDate || todayFileStamp(now)}.json`);
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
    return { ...nearbyAvailableRuns(grid, { windowStart: '06:00', windowEnd: '12:00' }) };
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function findRemoteBooking(job, court) {
  try {
    const records = await readRemoteBookings();
    return records.find((record) => record.date === job.date
      && record.start === job.start
      && record.end === job.end
      && record.court === court) || null;
  } catch {
    return null;
  }
}

export async function runWeekendBooking({ now = new Date(), participants, courtOrder } = {}) {
  const job = buildWeekendJob({ now, participants, courtOrder });
  try {
    await fs.access(ACTIVE_JOB_FILE);
    throw new Error('An active booking job already exists; weekend run skipped');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const jobFile = path.join(STATE_DIR, 'jobs', `weekend-${job.date}.json`);
  await fs.mkdir(path.dirname(jobFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(jobFile, `${JSON.stringify(job)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(jobFile, 0o600);

  let result = null;
  let failure = null;
  const startedAt = new Date().toISOString();
  try {
    result = await runLaunchdJob({ jobFile, mode: 'execute' });
  } catch (error) {
    failure = error;
  }

  if (result) {
    const court = result.selection?.court || null;
    const remote = court ? await findRemoteBooking(job, court) : null;
    await appendRun({
      status: result.status || 'booking_verified',
      mode: 'execute',
      jobId: job.id,
      timestamp: startedAt,
      startedAt: result.startedAt || startedAt,
      firstGridAt: result.firstGridAt,
      finishedAt: result.finishedAt,
      selection: result.selection,
      paymentStatus: result.paymentStatus,
    }, now);
    const archived = await archiveJob(jobFile, job, 'completed');
    const report = await writeReport({
      status: 'success',
      targetDate: job.date,
      job,
      court,
      paymentStatus: result.paymentStatus,
      remoteBookingId: remote?.id || null,
      verifiedAt: result.finishedAt || new Date().toISOString(),
      archived,
    }, now);
    console.log(JSON.stringify({ status: 'weekend_success', targetDate: job.date, court, remoteBookingId: remote?.id || null, report }));
    return { status: 'success', job, court, remote, report };
  }

  const message = String(failure?.message || failure).slice(0, 500);
  let adjacent;
  try {
    adjacent = await scanAdjacent(job.date);
  } catch (error) {
    adjacent = { window: { start: '06:00', end: '12:00' }, runs: [], error: String(error?.message || error).slice(0, 300) };
  }
  await appendRun({
    status: 'failed',
    mode: 'execute',
    jobId: job.id,
    timestamp: startedAt,
    errorCode: message,
    adjacent,
  }, now);
  const archived = await archiveJob(jobFile, job, 'failed');
  const report = await writeReport({
    status: 'failed',
    targetDate: job.date,
    job,
    error: message,
    adjacent,
    archived,
  }, now);
  console.log(JSON.stringify({ status: 'weekend_failed', targetDate: job.date, error: message, adjacent, report }));
  return { status: 'failed', job, error: message, adjacent, report };
}

async function main() {
  try {
    const result = await runWeekendBooking();
    if (result.status !== 'success') process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ status: 'weekend_skipped', error: String(error?.message || error).slice(0, 500) }));
    process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { START, END };
