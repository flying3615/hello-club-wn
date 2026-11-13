import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { reconcileIntentFence } from './intent-fence.mjs';
import { readRemoteBookings } from './remote-bookings.mjs';
import { bookingIntentKey } from './booking-intent.mjs';
import { connectExistingChrome, openBookingPage } from './session.mjs';
import { scanBookingGrid } from './booking-grid.mjs';
import { chooseCourt, orderedAvailableCourts } from './booking-policy.mjs';
import { reloadTargetGrid, watchOpening } from './opening-watch.mjs';
import { preflightRenderedBookingSlots, submitBooking } from './booking-submit.mjs';
import { verifiedBookingRecord } from './booking-execution.mjs';
import { DEFAULT_CDP_ENDPOINT, validateBookingJob, validateLoopbackCdpEndpoint } from './launchd-job.mjs';
import { existingFlexibleBookings, submitFlexiblePlan } from './flexible-booking.mjs';

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
  return bookingIntentKey(job);
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

export async function selectActionableCourt({
  scope,
  grid,
  job,
  preflight = preflightRenderedBookingSlots,
  exclude = new Set(),
}) {
  const candidates = orderedAvailableCourts(grid, { start: job.start, end: job.end }, job.courtOrder)
    .filter((court) => !exclude.has(court));
  const checked = [];
  for (const court of candidates) {
    checked.push(court);
    try {
      await preflight({ scope, grid, court, start: job.start, end: job.end });
      return { court, checked };
    } catch (error) {
      if (error?.code !== 'slot_not_actionable') throw error;
    }
  }
  throw new Error(`No rendered-actionable permitted court for ${job.start}-${job.end}; checked ${checked.join(', ') || 'none'}`);
}

export function assertDeadline(deadlineMs, currentMs = Date.now()) {
  if (!Number.isFinite(deadlineMs) || currentMs > deadlineMs) throw new Error('latest start deadline has passed');
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
  assertDeadline(Date.parse(job.latestStart), now());
  const needsFixedInterval = !job.flexible;
  if (!result.poll?.ready || !result.grid || (needsFixedInterval && (!result.selection || result.selection.error))) {
    throw new Error('Opening grid was not ready with a complete permitted interval');
  }
  return result;
}

const MAX_ATTEMPTS_PER_COURT = 2;
const MAX_SUBMIT_ATTEMPTS = 8;

/**
 * Runs the stateful booking flow, falling back through the permitted court order when a
 * court fails before CONFIRM BOOKING (for example because another member took the slot
 * first and the selection modal never opened). Every fallback re-reads a fresh grid.
 */
export async function submitWithCourtFallback({
  context,
  opening,
  job,
  deadline,
  now = () => Date.now(),
  priorBookings = null,
  submit = submitBooking,
  select = selectActionableCourt,
  reload = reloadTargetGrid,
  log = () => {},
}) {
  const page = opening.page;
  let { grid, gridRoot } = opening;
  const attemptsByCourt = new Map();
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt += 1) {
    assertDeadline(deadline, now());
    const exclude = new Set([...attemptsByCourt].filter(([, count]) => count >= MAX_ATTEMPTS_PER_COURT).map(([court]) => court));
    let selection;
    try {
      selection = await select({ scope: gridRoot || page, grid, job, exclude });
    } catch (error) {
      if (lastError) error.message = `${error.message}; previous attempt: ${lastError.message}`;
      throw error;
    }
    attemptsByCourt.set(selection.court, (attemptsByCourt.get(selection.court) || 0) + 1);
    assertDeadline(deadline, now());
    try {
      const outcome = await submit({
        context, page, job, grid, gridRoot, court: selection.court, priorBookings,
        assertDeadline: () => assertDeadline(deadline, now()),
      });
      return { outcome, selection, attempts: attempt };
    } catch (error) {
      if (error?.code !== 'pre_confirm_failed') throw error;
      lastError = error;
      log({ status: 'court_attempt_failed', court: selection.court, attempt, error: String(error.message).slice(0, 300) });
      assertDeadline(deadline, now());
      ({ grid, gridRoot } = await reload({ page, date: job.date }));
    }
  }
  throw lastError || new Error('Booking attempts exhausted');
}

const priorBookingSnapshots = new Map();

async function priorBookingsBeforeOpening(job, { now, read = readRemoteBookings }) {
  const key = bookingFingerprint(job);
  const cached = priorBookingSnapshots.get(key);
  if (cached) return cached;
  // Only a snapshot taken before the opening is reused: the target date cannot have been
  // booked before then, so it is equivalent to reading at the opening instant.
  if (now() >= Date.parse(job.openAt) - 10_000) return null;
  try {
    const bookings = await read();
    if (now() < Date.parse(job.openAt)) priorBookingSnapshots.set(key, bookings);
    return bookings;
  } catch {
    return null;
  }
}

async function runFlexibleExecute({ context, job, mode, startedAt, deadline, now }) {
  const key = bookingFingerprint(job);
  // Before the opening this is the cached pre-opening snapshot; on a retry after the
  // opening (when an earlier attempt may already have booked part of the range) the
  // snapshot is gone and the remote calendar is read fresh.
  const priorBookings = (await priorBookingsBeforeOpening(job, { now })) || await readRemoteBookings();
  const existing = await existingFlexibleBookings({ job, read: async () => priorBookings });
  if (existing.length) {
    const verifiedAt = new Date().toISOString();
    return {
      status: 'reconciled_verified', mode, jobId: job.id, timestamp: startedAt, startedAt, finishedAt: verifiedAt,
      selection: { status: 'reconciled', court: existing[0].court, checked: [], segments: existing.map(({ court, start, end, paymentStatus, id }) => ({ court, start, end, paymentStatus, remoteBookingId: id })) },
      paymentStatus: existing[0].paymentStatus,
    };
  }
  const opening = await waitForOpenSelection({ context, job, now });
  assertDeadline(deadline, now());
  // From here a booking may be confirmed; a retry must re-read the remote calendar.
  priorBookingSnapshots.delete(key);
  const result = await submitFlexiblePlan({
    context, opening, job, deadline, now, priorBookings,
    log: (entry) => console.log(JSON.stringify({ ...entry, jobId: job.id, timestamp: new Date().toISOString() })),
  });
  const verifiedAt = new Date().toISOString();
  for (const item of result.segments) {
    await appendBooking(verifiedBookingRecord({
      job: { ...job, start: item.start, end: item.end }, court: item.court, paymentStatus: item.paymentStatus, verifiedAt,
    }));
  }
  if (result.unverified.length) {
    const booked = result.segments.map((item) => `${item.court} ${item.start}-${item.end}`).join(', ') || 'none';
    throw new Error(`Remote calendar did not verify ${result.unverified.map((item) => `${item.court} ${item.start}-${item.end}`).join(', ')}; verified: ${booked}`);
  }
  return {
    status: 'booking_verified', mode, jobId: job.id, timestamp: startedAt, startedAt,
    firstGridAt: new Date().toISOString(), finishedAt: verifiedAt,
    selection: { status: 'candidate', court: result.segments[0].court, checked: [], tier: result.tier, segments: result.segments, incompleteReason: result.incompleteReason },
    paymentStatus: result.segments[0].paymentStatus,
  };
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
  let browser = null;
  try {
    const connection = await connectExistingChrome(endpoint);
    browser = connection.browser;
    const { context } = connection;
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
      const reconciliation = await reconcileIntentFence({ job, read: readRemoteBookings });
      if (reconciliation.state === 'blocked') {
        throw new Error('Booking intent requires authenticated reconciliation before any new submission');
      }
      if (reconciliation.state === 'verified') {
        const verifiedAt = new Date().toISOString();
        if (!['free', 'unpaid_hold'].includes(reconciliation.record.paymentStatus)) {
          throw new Error('Reconciled booking has an unsupported payment state');
        }
        await appendBooking(verifiedBookingRecord({
          job, court: reconciliation.record.court, paymentStatus: reconciliation.record.paymentStatus, verifiedAt,
        }));
        return {
          status: 'reconciled_verified', mode, jobId: job.id, timestamp: startedAt, startedAt,
          finishedAt: verifiedAt, selection: { status: 'reconciled', court: reconciliation.record.court, checked: [reconciliation.record.court] }, paymentStatus: reconciliation.record.paymentStatus,
        };
      }
      if (job.flexible) {
        return await runFlexibleExecute({ context, job, mode, startedAt, deadline, now });
      }
      const priorBookings = await priorBookingsBeforeOpening(job, { now });
      const opening = await waitForOpenSelection({ context, job, now });
      assertDeadline(deadline, now());
      const { outcome, selection } = await submitWithCourtFallback({
        context, opening, job, deadline, now, priorBookings,
        log: (entry) => console.log(JSON.stringify({ ...entry, jobId: job.id, timestamp: new Date().toISOString() })),
      });
      const verifiedAt = new Date().toISOString();
      await appendBooking(verifiedBookingRecord({ job, court: selection.court, paymentStatus: outcome.paymentStatus, verifiedAt }));
      return {
        status: 'booking_verified', mode, jobId: job.id, timestamp: startedAt, startedAt,
        firstGridAt: new Date().toISOString(), finishedAt: verifiedAt,
        selection: summarizeSelection(selection), paymentStatus: outcome.paymentStatus,
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
    // Over CDP this only disconnects; it never closes the user's Chrome.
    await browser?.close().catch(() => {});
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
