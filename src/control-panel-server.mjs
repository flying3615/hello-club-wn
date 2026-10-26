import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import {
  presentActivity, publicBooking, publicDispatch, publicJob, publicRun, readJsonLines,
} from './control-panel-data.mjs';
import { createRemoteBookingCache, partitionRemoteBookings, readRemoteBookings } from './remote-bookings.mjs';

const execFileAsync = promisify(execFile);
const PROJECT_DIR = path.resolve(new URL('..', import.meta.url).pathname);
const STATE_DIR = path.join(PROJECT_DIR, 'state');
const LABEL = 'com.hermes.hello-club.dispatcher';
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

function field(text, label) {
  const match = text.match(new RegExp(`^\\s*${label} = (.+)$`, 'm'));
  return match?.[1]?.trim() || null;
}

async function dispatcherHealth() {
  try {
    const { stdout } = await execFileAsync('/bin/launchctl', ['print', `gui/${process.getuid()}/${LABEL}`], { timeout: 3_000 });
    const state = field(stdout, 'state') || 'unknown';
    const runCount = Number(field(stdout, 'runs'));
    const exitCode = Number(field(stdout, 'last exit code'));
    return {
      configured: true,
      state: ['running', 'not running'].includes(state) ? state : 'unknown',
      runs: Number.isFinite(runCount) ? runCount : null,
      lastExitCode: Number.isFinite(exitCode) ? exitCode : null,
    };
  } catch {
    return { configured: false, state: 'unavailable', runs: null, lastExitCode: null };
  }
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
    return false;
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
  const [
    activeJob, dispatcher, cdp, chrome, locks, runs, dispatches, remote,
  ] = await Promise.all([
    readJsonFile(path.join(STATE_DIR, 'jobs', 'active.json'), publicJob),
    dispatcherHealth(),
    cdpHealth(),
    chromeProcess(),
    lockState(),
    readJsonLines(path.join(STATE_DIR, 'launchd', 'runs'), publicRun, { limit: 40 }),
    readJsonLines(path.join(STATE_DIR, 'launchd', 'dispatch-history'), publicDispatch, { limit: 40 }),
    remoteBookingCache.get(),
  ]);
  const marker = activeJob
    ? await readJsonFile(path.join(STATE_DIR, 'launchd', 'dispatch', `${activeJob.id}.json`), publicDispatch)
    : null;
  const now = new Date().toISOString();
  const groupedBookings = partitionRemoteBookings(remote.bookings, now);
  return {
    generatedAt: now,
    safety: {
      mode: 'read_only',
      message: 'This panel cannot select, submit, pay for, remove, or change a booking.',
    },
    processes: {
      dispatcher,
      chrome: { processDetected: chrome, cdpReachable: cdp.reachable },
      runner: { activeJobIds: locks, state: locks.length ? 'running' : 'idle' },
    },
    activeJob: activeJob ? { ...activeJob, dispatch: marker } : null,
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
        response.writeHead(200, { 'Content-Type': contentType(INDEX_FILE), 'Cache-Control': 'no-store' });
        response.end(await fs.readFile(INDEX_FILE));
        return;
      }
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    } catch {
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
