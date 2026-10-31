import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { assessRtcWake, buildRtcWakePlan, parseScheduledWakes } from './rtc-wake.mjs';

const execFile = promisify(execFileCallback);
const PROJECT_DIR = path.resolve(new URL('..', import.meta.url).pathname);
const REQUEST_DIR = path.join(PROJECT_DIR, 'state', 'wake');
const REQUEST_FILE = path.join(REQUEST_DIR, 'rtc-wake.txt');
const HELPER_PATH = '/usr/local/libexec/hello-club-arm-rtc-wake';

export async function readScheduledWakes({ run = (file, args) => execFile(file, args) } = {}) {
  let stdout;
  try {
    ({ stdout } = await run('/usr/bin/pmset', ['-g', 'sched']));
  } catch (error) {
    throw new Error(`Unable to read scheduled RTC wakes (${String(error.message || error).slice(0, 200)})`);
  }
  return parseScheduledWakes(stdout);
}

export async function prepareRtcWakeRequest(job, { requestDir = REQUEST_DIR } = {}) {
  const plan = buildRtcWakePlan(job);
  await fs.mkdir(requestDir, { recursive: true, mode: 0o700 });
  const file = path.join(requestDir, 'rtc-wake.txt');
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${plan.pmsetDate}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600);
  return { ...plan, file };
}

export async function armRtcWake({ run = (file, args, options) => execFile(file, args, options) } = {}) {
  await run('/usr/bin/sudo', ['-n', HELPER_PATH], { cwd: PROJECT_DIR });
}

export async function armRtcWakeForJob(job, {
  requestDir = REQUEST_DIR,
  run = (file, args, options) => execFile(file, args, options),
  readWakes = readScheduledWakes,
  prepare = prepareRtcWakeRequest,
} = {}) {
  const plan = buildRtcWakePlan(job);
  const before = assessRtcWake(plan, await readWakes());
  if (before.state === 'already_armed') return { ...plan, state: 'already_armed' };
  if (before.state === 'conflict') {
    throw new Error('RTC wake conflict: an existing event for this owner does not match the job');
  }
  const request = await prepare(job, { requestDir });
  await armRtcWake({ run });
  const after = assessRtcWake(plan, await readWakes());
  if (after.state !== 'already_armed') {
    throw new Error('RTC wake read-back did not show exactly one matching event');
  }
  return { ...request, state: 'armed' };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) result[argv[index].slice(2)] = argv[index + 1];
  }
  return result;
}

async function readJob(jobFile) {
  if (!path.isAbsolute(jobFile || '')) throw new Error('Usage: node src/arm-rtc-wake.mjs --job /absolute/state/jobs/active.json');
  const stat = await fs.stat(jobFile);
  if ((stat.mode & 0o077) !== 0) throw new Error('Job file must not be group/world readable');
  return JSON.parse(await fs.readFile(jobFile, 'utf8'));
}

async function main() {
  const { job: jobFile } = parseArgs(process.argv.slice(2));
  const job = await readJob(jobFile);
  let request;
  try {
    request = await armRtcWakeForJob(job);
  } catch (error) {
    throw new Error(`RTC wake was not armed; check scheduled power events and the one-time installation (${String(error.message || error).slice(0, 200)})`);
  }
  console.log(JSON.stringify({
    status: request.state === 'already_armed' ? 'rtc_wake_already_armed' : 'rtc_wake_armed',
    wakeAt: request.wakeAt,
    pmsetDate: request.pmsetDate,
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(String(error.message || error));
    process.exitCode = 1;
  });
}

export { HELPER_PATH, REQUEST_FILE };
