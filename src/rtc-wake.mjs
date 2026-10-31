import fs from 'node:fs/promises';
import path from 'node:path';
import { validateBookingJob } from './launchd-job.mjs';

const AUCKLAND_TIME_ZONE = 'Pacific/Auckland';
const RTC_WAKE_LEAD_MS = 4 * 60_000;
const OWNER = 'com.hermes.hello-club';
const PMSET_DATE = /^(\d{2})\/(\d{2})\/(\d{2}|\d{4}) (\d{2}:\d{2}:\d{2})$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function pmsetWakeKey(value) {
  const match = PMSET_DATE.exec(String(value || '').trim());
  assert(match, 'Scheduled wake must use MM/DD/YY HH:MM:SS');
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${match[1]}-${match[2]}T${match[4]}`;
}

export function parseScheduledWakes(text) {
  const wakes = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /\[\d+\]\s+wake at (\d{2}\/\d{2}\/(?:\d{2}|\d{4}) \d{2}:\d{2}:\d{2}) by ['"]([^'"]+)['"]/.exec(line);
    if (!match) continue;
    wakes.push({ key: pmsetWakeKey(match[1]), owner: match[2], raw: match[1] });
  }
  return wakes;
}

export function assessRtcWake(plan, wakes) {
  const owned = (wakes || []).filter((wake) => wake.owner === OWNER);
  if (owned.length === 0) return { state: 'not_armed' };
  if (owned.length === 1 && owned[0].key === plan.wakeKey) return { state: 'already_armed' };
  return { state: 'conflict', owned };
}

function localParts(epochMs) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: AUCKLAND_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

export function buildRtcWakePlan(job, { wakeLeadMs = RTC_WAKE_LEAD_MS } = {}) {
  validateBookingJob(job);
  assert(job.prepareAt, 'RTC wake requires prepareAt');
  assert(Number.isFinite(wakeLeadMs) && wakeLeadMs >= 60_000 && wakeLeadMs <= 15 * 60_000, 'wakeLeadMs must be between 1 and 15 minutes');
  const prepareAtMs = Date.parse(job.prepareAt);
  const wakeAtMs = prepareAtMs - wakeLeadMs;
  const parts = localParts(wakeAtMs);
  const pmsetDate = `${parts.month}/${parts.day}/${parts.year.slice(-2)} ${parts.hour}:${parts.minute}:${parts.second}`;
  return {
    wakeAt: new Date(wakeAtMs).toISOString(),
    pmsetDate,
    wakeKey: pmsetWakeKey(pmsetDate),
    command: ['sudo', '/usr/bin/pmset', 'schedule', 'wake', pmsetDate, OWNER],
  };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) result[argv[index].slice(2)] = argv[index + 1];
  }
  return result;
}

async function main() {
  const { job: jobFile } = parseArgs(process.argv.slice(2));
  if (!path.isAbsolute(jobFile || '')) throw new Error('Usage: node src/rtc-wake.mjs --job /absolute/state/jobs/active.json');
  const stat = await fs.stat(jobFile);
  if ((stat.mode & 0o077) !== 0) throw new Error('Job file must not be group/world readable');
  const job = JSON.parse(await fs.readFile(jobFile, 'utf8'));
  console.log(JSON.stringify(buildRtcWakePlan(job)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(String(error.message || error));
    process.exitCode = 1;
  });
}

export { AUCKLAND_TIME_ZONE, OWNER, RTC_WAKE_LEAD_MS };
