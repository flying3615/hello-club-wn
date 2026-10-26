import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { validateBookingJob } from './launchd-job.mjs';

const PROJECT_DIR = path.resolve(new URL('..', import.meta.url).pathname);
const STATE_DIR = path.join(PROJECT_DIR, 'state', 'launchd');
const RUNNER = path.join(PROJECT_DIR, 'src', 'launchd-runner.mjs');

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) result[argv[index].slice(2)] = argv[index + 1];
  }
  return result;
}

export function dispatchDecision(job, nowMs = Date.now()) {
  if (!job.prepareAt) throw new Error('Persistent dispatcher requires prepareAt');
  const prepareAt = Date.parse(job.prepareAt);
  const latestStart = Date.parse(job.latestStart);
  if (!Number.isFinite(prepareAt) || !Number.isFinite(latestStart)) throw new Error('Invalid dispatch timestamps');
  if (nowMs < prepareAt) return { action: 'wait' };
  if (nowMs > latestStart) return { action: 'missed' };
  return { action: 'run' };
}

export function idleDelayMs(untilMs = 900_000) {
  return Math.max(1_000, Math.min(900_000, untilMs));
}

function publicResult(result) {
  return Object.fromEntries(Object.entries(result).filter(([key]) => [
    'status', 'jobId', 'timestamp', 'exitCode', 'reason',
  ].includes(key)));
}

const TERMINAL_MARKER_STATUSES = new Set(['completed', 'failed', 'missed']);

export function canReplaceDispatchMarker(currentStatus) {
  return currentStatus === 'running';
}

async function withMarkerLock(jobId, action) {
  const directory = path.join(STATE_DIR, 'dispatch');
  const locks = path.join(directory, '.locks');
  await fs.mkdir(locks, { recursive: true, mode: 0o700 });
  const lock = path.join(locks, `${jobId}.lock`);
  let handle;
  try {
    handle = await fs.open(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  try {
    return await action(path.join(directory, `${jobId}.json`));
  } finally {
    await handle.close();
    await fs.rm(lock, { force: true });
  }
}

async function readMarker(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeMarkerFile(file, result) {
  await fs.writeFile(file, `${JSON.stringify(publicResult(result))}\n`, { encoding: 'utf8', mode: 0o600, flag: 'w' });
  await fs.chmod(file, 0o600);
  return true;
}

async function claimMarker(jobId, result) {
  return withMarkerLock(jobId, async (file) => {
    if (await readMarker(file)) return false;
    return writeMarkerFile(file, result);
  });
}

async function finishMarker(jobId, result) {
  return withMarkerLock(jobId, async (file) => {
    const existing = await readMarker(file);
    if (!canReplaceDispatchMarker(existing?.status)) return false;
    return writeMarkerFile(file, result);
  });
}

async function recordMissedMarker(jobId, result) {
  return withMarkerLock(jobId, async (file) => {
    if (await readMarker(file)) return false;
    return writeMarkerFile(file, result);
  });
}

function runRunner(jobFile, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/caffeinate', [
      '-dimsu', '-t', '600', process.execPath, RUNNER,
      '--job', jobFile, '--mode', mode, '--cdp-endpoint', 'http://127.0.0.1:9223',
    ], { cwd: PROJECT_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

export async function dispatch({ jobFile, nowMs = Date.now() }) {
  try {
    const stat = await fs.stat(jobFile);
    if ((stat.mode & 0o077) !== 0) throw new Error('Job file must not be group/world readable');
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'idle', timestamp: new Date().toISOString(), delayMs: idleDelayMs() };
    throw error;
  }

  const parsedJob = JSON.parse(await fs.readFile(jobFile, 'utf8'));
  const mode = parsedJob.submit ? 'execute' : 'watch';
  const job = validateBookingJob(parsedJob, { mode });
  const decision = dispatchDecision(job, nowMs);
  if (decision.action === 'wait') {
    return {
      status: 'waiting', jobId: job.id, timestamp: new Date().toISOString(),
      delayMs: idleDelayMs(Date.parse(job.prepareAt) - nowMs),
    };
  }
  if (decision.action === 'missed') {
    const result = { status: 'missed', jobId: job.id, timestamp: new Date().toISOString(), reason: 'latest_start_passed' };
    const recorded = await recordMissedMarker(job.id, result);
    return recorded ? result : { status: 'already_terminal_or_running', jobId: job.id, timestamp: new Date().toISOString() };
  }

  const claimed = await claimMarker(job.id, { status: 'running', jobId: job.id, timestamp: new Date().toISOString() });
  if (!claimed) return { status: 'already_terminal_or_running', jobId: job.id, timestamp: new Date().toISOString() };
  let exitCode = 1;
  try {
    exitCode = await runRunner(jobFile, mode);
  } catch {
    exitCode = 1;
  }
  const result = { status: exitCode === 0 ? 'completed' : 'failed', jobId: job.id, timestamp: new Date().toISOString(), exitCode };
  await finishMarker(job.id, result);
  return result;
}

export async function dispatchAfterPrewarm({
  jobFile,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  dispatchOnce = dispatch,
}) {
  let result = await dispatchOnce({ jobFile, nowMs: now() });
  while (result.status === 'waiting') {
    await sleep(result.delayMs);
    result = await dispatchOnce({ jobFile, nowMs: now() });
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.job || !path.isAbsolute(args.job)) throw new Error('Usage: node src/launchd-dispatcher.mjs --job /absolute/state/jobs/active.json');
  const result = await dispatchAfterPrewarm({ jobFile: args.job });
  if (result.status === 'idle') {
    await new Promise((resolve) => setTimeout(resolve, result.delayMs));
    return;
  }
  console.log(JSON.stringify(publicResult(result)));
  if (result.status === 'failed') process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: 'failed', error: String(error.message || error).slice(0, 500) }));
    process.exitCode = 1;
  });
}
