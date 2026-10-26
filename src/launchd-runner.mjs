import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { connectExistingChrome, openBookingPage } from './session.mjs';
import { scanBookingGrid } from './booking-grid.mjs';
import { chooseCourt } from './booking-policy.mjs';
import { watchOpening } from './opening-watch.mjs';
import { submitBooking } from './booking-submit.mjs';
import { verifiedBookingRecord } from './booking-execution.mjs';
import { DEFAULT_CDP_ENDPOINT, validateBookingJob, validateLoopbackCdpEndpoint } from './launchd-job.mjs';

const PROJECT_DIR = path.resolve(new URL('..', import.meta.url).pathname);
const STATE_DIR = path.join(PROJECT_DIR, 'state', 'launchd');

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) values[argv[index].slice(2)] = argv[index + 1];
  }
  return values;
}

function safeResult(result) {
  const allowed = ['status', 'mode', 'jobId', 'timestamp', 'startedAt', 'firstGridAt', 'finishedAt', 'selection', 'attempts', 'errorCode', 'paymentStatus'];
  return Object.fromEntries(Object.entries(result).filter(([key]) => allowed.includes(key)));
}

function aucklandDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

async function appendResult(result) {
  const date = aucklandDate();
  const directory = path.join(STATE_DIR, 'runs');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${date}.jsonl`);
  await fs.appendFile(file, `${JSON.stringify(safeResult(result))}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(file, 0o600);
  return file;
}

async function appendBooking(record) {
  const directory = path.join(PROJECT_DIR, 'state', 'bookings');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'confirmed.jsonl');
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(file, 0o600);
  return file;
}

export function bookingFingerprint(job) {
  const value = JSON.stringify({
    date: job.date,
    start: job.start,
    end: job.end,
    bookingType: job.bookingType,
    participants: [...job.participants].map((name) => name.trim().toLowerCase()).sort(),
    courts: [...job.courtOrder].sort(),
  });
  return createHash('sha256').update(value).digest('hex');
}

async function acquireLock(job) {
  const jobId = bookingFingerprint(job);
  const directory = path.join(STATE_DIR, 'locks');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${jobId}.lock`);
  let handle;
  try {
    handle = await fs.open(file, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ jobId, pid: process.pid, startedAt: new Date().toISOString() }));
  } catch (error) {
    if (error.code === 'EEXIST') {
      let existing;
      try { existing = JSON.parse(await fs.readFile(file, 'utf8')); } catch { existing = null; }
      try {
        if (Number.isInteger(existing?.pid)) process.kill(existing.pid, 0);
      } catch (probe) {
        if (probe.code === 'ESRCH') {
          await fs.rm(file, { force: true });
          return acquireLock(job);
        }
      }
      throw new Error(`Run lock already exists for ${jobId}; refusing concurrent or unreconciled run`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
  return async () => fs.rm(file, { force: true });
}

async function readJob(file, mode) {
  if (!path.isAbsolute(file || '')) throw new Error('--job must be an absolute path');
  const stat = await fs.stat(file);
  if ((stat.mode & 0o077) !== 0) throw new Error('Job file must not be group/world readable');
  return validateBookingJob(JSON.parse(await fs.readFile(file, 'utf8')), { mode });
}

function summarizeSelection(selection) {
  if (!selection) return null;
  if (selection.error) return { status: 'no_complete_interval', checked: selection.checked || [] };
  return { status: 'candidate', court: selection.court, checked: selection.checked };
}

export function boundedTimeoutMs(deadlineMs, currentMs) {
  return Math.min(900_000, Math.max(1_000, deadlineMs - currentMs));
}

export async function waitForOpenSelection({
  context,
  job,
  now = () => Date.now(),
  watch = watchOpening,
}) {
  const result = await watch({
    context,
    date: job.date,
    start: job.start,
    end: job.end,
    openAtMs: Date.parse(job.openAt),
    courtOrder: job.courtOrder,
    leadMs: 15_000,
    pollMs: 2_500,
    timeoutMs: boundedTimeoutMs(Date.parse(job.latestStart), now()),
    now,
  });
  if (!result.poll?.ready || !result.grid || !result.selection || result.selection.error) {
    throw new Error('Opening grid was not ready with a complete permitted interval');
  }
  return result;
}

function usage() {
  console.log('Usage: node src/launchd-runner.mjs --job /absolute/job.json --mode inspect|watch [--cdp-endpoint http://127.0.0.1:9223]');
}

export async function runLaunchdJob({ jobFile, mode, cdpEndpoint = DEFAULT_CDP_ENDPOINT, now = () => Date.now() }) {
  if (!['inspect', 'watch', 'execute'].includes(mode)) {
    throw new Error('mode must be inspect, watch, or execute');
  }
  const job = await readJob(jobFile, mode);
  const endpoint = validateLoopbackCdpEndpoint(cdpEndpoint);
  const startedAt = new Date().toISOString();
  const deadline = Date.parse(job.latestStart);
  if (now() > deadline) {
    return { status: 'late_start', mode, jobId: job.id, timestamp: startedAt, startedAt, errorCode: 'latest_start_passed' };
  }

  let releaseLock = async () => {};
  try {
    const { context } = await connectExistingChrome(endpoint);
    if (mode === 'inspect') {
      const page = await openBookingPage(context, job.date);
      const grid = await scanBookingGrid(page);
      let selection;
      try {
        selection = chooseCourt(grid, { start: job.start, end: job.end }, job.courtOrder);
      } catch (error) {
        selection = { error: error.message, checked: error.checked || [] };
      }
      return {
        status: 'inspect_complete', mode, jobId: job.id, timestamp: startedAt, startedAt,
        firstGridAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        selection: summarizeSelection(selection),
      };
    }

    if (mode === 'execute') {
      releaseLock = await acquireLock(job);
      const opening = await waitForOpenSelection({ context, job, now });
      const outcome = await submitBooking({ context, page: opening.page, job, grid: opening.grid, gridRoot: opening.gridRoot, court: opening.selection.court });
      const verifiedAt = new Date().toISOString();
      await appendBooking(verifiedBookingRecord({ job, court: opening.selection.court, paymentStatus: outcome.paymentStatus, verifiedAt }));
      return {
        status: 'booking_verified', mode, jobId: job.id, timestamp: startedAt, startedAt,
        firstGridAt: new Date().toISOString(), finishedAt: verifiedAt,
        selection: summarizeSelection(opening.selection), paymentStatus: outcome.paymentStatus,
      };
    }

    const result = await watchOpening({
      context,
      date: job.date,
      start: job.start,
      end: job.end,
      openAtMs: Date.parse(job.openAt),
      courtOrder: job.courtOrder,
      leadMs: 15_000,
      pollMs: 2_500,
      timeoutMs: boundedTimeoutMs(deadline, now()),
    });
    return {
      status: result.poll.ready ? 'watch_complete' : 'watch_timeout',
      mode, jobId: job.id, timestamp: startedAt, startedAt,
      firstGridAt: result.poll.ready ? new Date().toISOString() : undefined,
      finishedAt: new Date().toISOString(), attempts: result.poll.attempts,
      selection: summarizeSelection(result.selection),
    };
  } finally {
    await releaseLock();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.job || !args.mode) {
    usage();
    process.exitCode = 2;
    return;
  }
  let result;
  try {
    result = await runLaunchdJob({ jobFile: args.job, mode: args.mode, cdpEndpoint: args['cdp-endpoint'] });
  } catch (error) {
    result = {
      status: 'failed', mode: args.mode, timestamp: new Date().toISOString(),
      errorCode: String(error.message || error).slice(0, 500),
    };
    process.exitCode = 1;
  }
  const outputFile = await appendResult(result);
  console.log(JSON.stringify({ ...safeResult(result), outputFile }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(process.exitCode || 0));
}
