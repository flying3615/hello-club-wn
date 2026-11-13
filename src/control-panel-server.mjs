import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import {
  explainRunFailure, presentActivity, publicBooking, publicDispatch, publicJob, publicRun, publicRecurringReport, readJsonLines,
} from './control-panel-data.mjs';
import { createRemoteBookingCache, partitionRemoteBookings, readRemoteBookings } from './remote-bookings.mjs';
import { nextRecurringRun } from './weekend-schedule.mjs';
import { RECURRING_TASKS } from './recurring-tasks.mjs';
import { openingInstantForTargetDate } from './opening-window.mjs';
import { createLoginCache } from './login-probe.mjs';
import { DEFAULT_PARTICIPANTS } from './recurring-booking.mjs';

const execFileAsync = promisify(execFile);
const PROJECT_DIR = path.resolve(new URL('..', import.meta.url).pathname);
const STATE_DIR = path.join(PROJECT_DIR, 'state');
const DISPATCHER_LABEL = 'com.hermes.hello-club.dispatcher';
const INDEX_FILE = path.join(PROJECT_DIR, 'public', 'control-panel.html');
const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
export const REMOTE_BOOKING_SYNC_TTL_MS = 43_200_000;
const remoteBookingCache = createRemoteBookingCache({ read: readRemoteBookings, ttlMs: REMOTE_BOOKING_SYNC_TTL_MS });
const loginCache = createLoginCache();

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) result[argv[index].slice(2)] = argv[index + 1];
  }
  return result;
}

async function readJsonFile(file, mapper) {
  try {
    return mapper(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return null;
  }
}

async function readArchivedJob(jobId) {
  if (typeof jobId !== 'string' || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(jobId)) return null;
  for (const status of ['failed', 'completed', 'missed']) {
    const job = await readJsonFile(path.join(STATE_DIR, 'jobs', status, `${jobId}.json`), publicJob);
    if (job) return job;
  }
  return null;
}

async function readLatestArchivedJob(status) {
  const directory = path.join(STATE_DIR, 'jobs', status);
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(directory, entry.name));
    const dated = await Promise.all(files.map(async (file) => ({
      file,
      mtime: (await fs.stat(file)).mtimeMs,
    })));
    dated.sort((left, right) => right.mtime - left.mtime);
    for (const { file } of dated) {
      const job = await readJsonFile(file, publicJob);
      if (job) return job;
    }
  } catch {
    return null;
  }
  return null;
}

function field(text, label) {
  const match = text.match(new RegExp(`^\\s*${label} = (.+)$`, 'm'));
  return match?.[1]?.trim() || null;
}

async function launchAgentHealth(label) {
  try {
    const { stdout } = await execFileAsync('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { timeout: 3_000 });
    const rawState = field(stdout, 'state') || 'unknown';
    const state = rawState === 'spawn scheduled' ? 'starting' : ['running', 'not running'].includes(rawState) ? rawState : 'unknown';
    const runCount = Number(field(stdout, 'runs'));
    const exitCode = Number.parseInt(field(stdout, 'last exit code') || '', 10);
    return {
      configured: true,
      state,
      runs: Number.isFinite(runCount) ? runCount : null,
      lastExitCode: Number.isFinite(exitCode) ? exitCode : null,
      ...launchAgentConfig(stdout),
    };
  } catch {
    return { configured: false, state: 'unavailable', runs: null, lastExitCode: null, keepsAwake: null, loadedRunTime: null };
  }
}

/** What the loaded (not just the on-disk) LaunchAgent will actually do. */
export function launchAgentConfig(printOutput) {
  const text = String(printOutput || '');
  const program = field(text, 'program') || '';
  const keepsAwake = /caffeinate/.test(program) || /arguments = \{[^}]*caffeinate/s.test(text);
  const hour = text.match(/"Hour" => (\d+)/);
  const minute = text.match(/"Minute" => (\d+)/);
  const loadedRunTime = hour && minute ? `${hour[1].padStart(2, '0')}:${minute[1].padStart(2, '0')}` : null;
  return { keepsAwake, loadedRunTime };
}

/** Parses the repeating wake from `pmset -g sched` (read-only). */
export function parseRepeatingWake(output) {
  const match = String(output || '').match(/wake(?:poweron|orpoweron)? at (\d{1,2}):(\d{2})\s*(AM|PM)\s*(.*)/i);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (/pm/i.test(match[3])) hour += 12;
  return { time: `${String(hour).padStart(2, '0')}:${match[2]}`, days: match[4].trim() || null };
}

async function wakeSchedule() {
  try {
    const { stdout } = await execFileAsync('/usr/bin/pmset', ['-g', 'sched'], { timeout: 3_000 });
    const repeating = stdout.split(/Scheduled power events:/i)[0];
    return { available: true, repeating: parseRepeatingWake(repeating) };
  } catch {
    return { available: false, repeating: null };
  }
}

async function dispatcherHealth() {
  return launchAgentHealth(DISPATCHER_LABEL);
}

async function readLatestRecurringReport(taskId) {
  const directory = path.join(STATE_DIR, 'reports');
  const pattern = new RegExp(`^${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{4}-\\d{2}-\\d{2}\\.json$`);
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const file of files) {
      const report = await readJsonFile(path.join(directory, file), publicRecurringReport);
      if (report) return report;
    }
  } catch {
    return null;
  }
  return null;
}

async function cdpHealth() {
  try {
    const response = await fetch('http://127.0.0.1:9223/json/version', { signal: AbortSignal.timeout(3_000) });
    return { reachable: response.ok };
  } catch {
    return { reachable: false };
  }
}

async function chromeProcess() {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-ax', '-o', 'command='], { timeout: 3_000 });
    return stdout.split('\n').some((line) => (
      line.includes('Google Chrome') && line.includes('--remote-debugging-port=9223')
    ));
  } catch {
    return null;
  }
}

async function lockState() {
  try {
    const entries = await fs.readdir(path.join(STATE_DIR, 'launchd', 'locks'), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.lock')).map((entry) => entry.name.replace(/\.lock$/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    return [];
  }
}

export async function buildStatus() {
  const nowDate = new Date();
  const [
    activeJob, dispatcher, cdp, chrome, locks, runs, dispatches, wake,
  ] = await Promise.all([
    readJsonFile(path.join(STATE_DIR, 'jobs', 'active.json'), publicJob),
    dispatcherHealth(),
    cdpHealth(),
    chromeProcess(),
    lockState(),
    readJsonLines(path.join(STATE_DIR, 'launchd', 'runs'), publicRun, { limit: 40 }),
    readJsonLines(path.join(STATE_DIR, 'launchd', 'dispatch-history'), publicDispatch, { limit: 40 }),
    wakeSchedule(),
  ]);
  const recurringTasks = await Promise.all(Object.values(RECURRING_TASKS).map(async (task) => {
    const [health, lastReport] = await Promise.all([
      launchAgentHealth(task.launchdLabel),
      readLatestRecurringReport(task.id),
    ]);
    if (lastReport?.status === 'failed') {
      const explained = explainRunFailure({ status: 'failed', errorCode: lastReport.error || '', timestamp: lastReport.verifiedAt || null });
      lastReport.explanation = explained ? { title: explained.title, reason: explained.reason, action: explained.action } : null;
    }
    let next = null;
    try {
      next = nextRecurringRun(nowDate, task);
      next.openAt = new Date(openingInstantForTargetDate(next.targetDate)).toISOString();
    } catch {
      next = null;
    }
    const expectedRunTime = `${String(task.runTime.hour).padStart(2, '0')}:${String(task.runTime.minute).padStart(2, '0')}`;
    return {
      id: task.id,
      label: task.label,
      ...health,
      expectedRunTime,
      flexible: Boolean(task.flexible),
      window: { start: task.start, end: task.end },
      weekdays: task.weekdays,
      next,
      lastReport,
    };
  }));
  const marker = activeJob
    ? await readJsonFile(path.join(STATE_DIR, 'launchd', 'dispatch', `${activeJob.id}.json`), publicDispatch)
    : null;
  const lastRun = runs[0] || null;
  const lastJob = lastRun?.jobId
    ? await readArchivedJob(lastRun.jobId)
    : (lastRun?.status === 'failed' ? await readLatestArchivedJob('failed') : null);
  const lastFailure = lastRun?.status === 'failed' ? explainRunFailure(lastRun, lastJob) : null;
  const successfulRun = lastRun && ['booking_verified', 'reconciled_verified'].includes(lastRun.status) ? lastRun : null;
  const successAt = successfulRun ? Date.parse(successfulRun.finishedAt || successfulRun.timestamp) : null;
  const lastSuccess = successfulRun && lastJob ? {
    job: lastJob,
    court: successfulRun.selection?.court || null,
    paymentStatus: successfulRun.paymentStatus || null,
    verifiedAt: successfulRun.finishedAt || successfulRun.timestamp,
  } : null;
  const remote = await remoteBookingCache.get({ freshAfter: Number.isFinite(successAt) ? successAt : null });
  const now = nowDate.toISOString();
  const groupedBookings = partitionRemoteBookings(remote.bookings, now);
  const chromeReady = chrome === null ? cdp.reachable : chrome || cdp.reachable;
  const login = await loginCache.get({ memberName: DEFAULT_PARTICIPANTS[0], runnerActive: locks.length > 0, cdpReachable: cdp.reachable });
  return {
    generatedAt: now,
    safety: {
      mode: 'read_only',
      message: '此面板只读，不能选择、提交、支付、取消或修改预约。',
    },
    wake,
    login: { state: login.state, checkedAt: login.checkedAt === null ? null : new Date(login.checkedAt).toISOString() },
    processes: {
      dispatcher,
      chrome: { processDetected: chromeReady, cdpReachable: cdp.reachable },
      runner: { activeJobIds: locks, state: locks.length ? 'running' : 'idle' },
    },
    activeJob: activeJob ? { ...activeJob, dispatch: marker } : null,
    lastRun,
    lastFailure,
    lastSuccess,
    recurring: { tasks: recurringTasks },
    activity: presentActivity({ dispatches: marker ? [marker, ...dispatches] : dispatches, runs }),
    bookings: {
      upcoming: groupedBookings.upcoming.map(publicBooking).filter(Boolean),
      past: groupedBookings.past.map(publicBooking).filter(Boolean),
    },
    remoteSync: {
      state: remote.state,
      syncedAt: remote.syncedAt === null ? null : new Date(remote.syncedAt).toISOString(),
    },
  };
}

function contentType(file) {
  return file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
}

export function createPanelServer({ port = DEFAULT_PORT } = {}) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${LOOPBACK_HOST}`);
      if (request.method !== 'GET') {
        response.writeHead(405, { Allow: 'GET' });
        response.end('Method not allowed');
        return;
      }
      if (url.pathname === '/api/status') {
        const body = JSON.stringify(await buildStatus());
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(body);
        return;
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = await fs.readFile(INDEX_FILE);
        response.writeHead(200, { 'Content-Type': contentType(INDEX_FILE), 'Cache-Control': 'no-store' });
        response.end(html);
        return;
      }
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    } catch {
      if (response.headersSent) {
        if (!response.writableEnded) response.destroy();
        return;
      }
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: 'Status unavailable. Try refreshing.' }));
    }
  }).listen(port, LOOPBACK_HOST);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be an unprivileged TCP port');
  const server = createPanelServer({ port });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  console.log(`Hello Club control panel: http://${LOOPBACK_HOST}:${port}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Unable to start control panel: ${String(error.message || error)}`);
    process.exitCode = 1;
  });
}
