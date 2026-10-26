import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PROJECT_DIR, STATE_DIR, DEFAULT_CDP_ENDPOINT } from './config.mjs';

const execFileAsync = promisify(execFile);
const PROFILE_HOME = process.env.HERMES_HOME || path.resolve(PROJECT_DIR, '../..');
const CRON_DIR = path.join(PROFILE_HOME, 'cron');
const CRON_JOBS_FILE = path.join(CRON_DIR, 'jobs.json');
const DIAGNOSTIC_DIR = path.join(STATE_DIR, 'diagnostics');

export function summarizeCronJobs(store) {
  const jobs = Array.isArray(store?.jobs) ? store.jobs : [];
  return {
    updatedAt: typeof store?.updated_at === 'string' ? store.updated_at : null,
    jobs: jobs.map((job) => ({
      id: String(job.id || ''),
      name: String(job.name || ''),
      enabled: job.enabled === true,
      state: typeof job.state === 'string' ? job.state : null,
      nextRunAt: typeof job.next_run_at === 'string' ? job.next_run_at : null,
      lastRunAt: typeof job.last_run_at === 'string' ? job.last_run_at : null,
      lastStatus: typeof job.last_status === 'string' ? job.last_status : null,
    })),
  };
}

async function readJson(pathname) {
  try {
    return JSON.parse(await fs.readFile(pathname, 'utf8'));
  } catch {
    return null;
  }
}

function probeCdp(endpoint) {
  const versionUrl = new URL('/json/version', endpoint);
  return new Promise((resolve) => {
    const request = http.get(versionUrl, { timeout: 4_000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ reachable: response.statusCode === 200, browser: String(parsed.Browser || '') || null });
        } catch {
          resolve({ reachable: false, browser: null, reason: 'invalid_response' });
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => resolve({ reachable: false, browser: null, reason: error.code || 'connection_error' }));
  });
}

async function recentCronOutputFiles() {
  const outputDir = path.join(CRON_DIR, 'output');
  try {
    const jobDirs = await fs.readdir(outputDir, { withFileTypes: true });
    const files = [];
    for (const jobDir of jobDirs.filter((entry) => entry.isDirectory())) {
      const entries = await fs.readdir(path.join(outputDir, jobDir.name), { withFileTypes: true });
      for (const entry of entries.filter((candidate) => candidate.isFile())) {
        const pathname = path.join(outputDir, jobDir.name, entry.name);
        const stat = await fs.stat(pathname);
        files.push({ jobId: jobDir.name, file: entry.name, modifiedAt: stat.mtime.toISOString() });
      }
    }
    return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 10);
  } catch {
    return [];
  }
}

async function recentPowerTransitions() {
  try {
    const { stdout } = await execFileAsync('/usr/bin/pmset', ['-g', 'log'], { timeout: 10_000, maxBuffer: 1_000_000 });
    return stdout.split('\n')
      .filter((line) => /\b(Sleep|Wake)\b/.test(line))
      .slice(-10)
      .map((line) => line.trim().slice(0, 500));
  } catch {
    return [];
  }
}

function dateStamp(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export async function captureDiagnostic({ label = 'manual', endpoint = DEFAULT_CDP_ENDPOINT, now = new Date() } = {}) {
  const [cronStore, cdp, outputs, powerTransitions] = await Promise.all([
    readJson(CRON_JOBS_FILE),
    probeCdp(endpoint),
    recentCronOutputFiles(),
    recentPowerTransitions(),
  ]);
  return {
    timestamp: now.toISOString(),
    label,
    host: { hostname: os.hostname(), uptimeSeconds: Math.floor(os.uptime()) },
    cdp,
    cron: summarizeCronJobs(cronStore),
    recentCronOutputs: outputs,
    recentPowerTransitions: powerTransitions,
  };
}

export async function appendDiagnostic(snapshot, now = new Date()) {
  await fs.mkdir(DIAGNOSTIC_DIR, { recursive: true, mode: 0o700 });
  const filename = `booking-preflight-${dateStamp(now)}.jsonl`;
  const pathname = path.join(DIAGNOSTIC_DIR, filename);
  await fs.appendFile(pathname, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(pathname, 0o600);
  return pathname;
}

async function main() {
  const labelIndex = process.argv.indexOf('--label');
  const label = labelIndex >= 0 ? process.argv[labelIndex + 1] : 'manual';
  const snapshot = await captureDiagnostic({ label: label || 'manual' });
  const outputFile = await appendDiagnostic(snapshot);
  console.log(JSON.stringify({ timestamp: snapshot.timestamp, label: snapshot.label, cdp: snapshot.cdp, outputFile }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
