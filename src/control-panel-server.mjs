import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import {
  explainRunFailure, presentActivity, publicBooking, publicDispatch, publicJob, publicRun, publicWeekendReport, readJsonLines,
} from './control-panel-data.mjs';
import { createRemoteBookingCache, partitionRemoteBookings, readRemoteBookings } from './remote-bookings.mjs';
import { nextWeekendRun } from './weekend-schedule.mjs';

const execFileAsync = promisify(execFile);
const PROJECT_DIR = path.resolve(new URL('..', import.meta.url).pathname);
const STATE_DIR = path.join(PROJECT_DIR, 'state');
const DISPATCHER_LABEL = 'com.hermes.hello-club.dispatcher';
const WEEKEND_LABEL = 'com.hermes.hello-club.weekend';
const INDEX_FILE = path.join(PROJECT_DIR, 'public', 'control-panel.html');
const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
export const REMOTE_BOOKING_SYNC_TTL_MS = 43_200_000;
const remoteBookingCache = createRemoteBookingCache({ read: readRemoteBookings, ttlMs: REMOTE_BOOKING_SYNC_TTL_MS });

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
    };
  } catch {
    return { configured: false, state: 'unavailable', runs: null, lastExitCode: null };
  }
}

async function dispatcherHealth() {
  return launchAgentHealth(DISPATCHER_LABEL);
}

async function readLatestWeekendReport() {
  const directory = path.join(STATE_DIR, 'reports');
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && /^weekend-\d{4}-\d{2}-\d{2}\.json$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const file of files) {
      const report = await readJsonFile(path.join(directory, file), publicWeekendReport);
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
  let nextWeekend = null;
  try {
    nextWeekend = nextWeekendRun(nowDate);
  } catch {
    nextWeekend = null;
  }
  const [
    activeJob, dispatcher, cdp, chrome, locks, runs, dispatches, weekend, weekendReport,
  ] = await Promise.all([
    readJsonFile(path.join(STATE_DIR, 'jobs', 'active.json'), publicJob),
    dispatcherHealth(),
    cdpHealth(),
    chromeProcess(),
    lockState(),
    readJsonLines(path.join(STATE_DIR, 'launchd', 'runs'), publicRun, { limit: 40 }),
    readJsonLines(path.join(STATE_DIR, 'launchd', 'dispatch-history'), publicDispatch, { limit: 40 }),
    launchAgentHealth(WEEKEND_LABEL),
    readLatestWeekendReport(),
  ]);
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
  return {
    generatedAt: now,
    safety: {
      mode: 'read_only',
      message: '此面板只读，不能选择、提交、支付、取消或修改预约。',
    },
    processes: {
      dispatcher,
      chrome: { processDetected: chromeReady, cdpReachable: cdp.reachable },
      runner: { activeJobIds: locks, state: locks.length ? 'running' : 'idle' },
    },
    activeJob: activeJob ? { ...activeJob, dispatch: marker } : null,
    lastRun,
    lastFailure,
    lastSuccess,
    recurring: {
      weekend: {
        label: WEEKEND_LABEL,
        ...weekend,
        window: { start: '08:00', end: '09:30' },
        weekdays: ['Saturday', 'Sunday'],
        next: nextWeekend,
        lastReport: weekendReport,
      },
    },
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
