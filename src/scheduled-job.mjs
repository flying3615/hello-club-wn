import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { armRtcWakeForJob } from './arm-rtc-wake.mjs';
import { DEFAULT_COURT_ORDER } from './booking-policy.mjs';
import { withJobLock } from './job-lifecycle.mjs';
import { validateBookingJob } from './launchd-job.mjs';
import { openingInstantForTargetDate } from './opening-window.mjs';

const PROJECT_DIR = path.resolve(new URL('..', import.meta.url).pathname);
const DEFAULT_ACTIVE_JOB_FILE = path.join(PROJECT_DIR, 'state', 'jobs', 'active.json');

export function buildScheduledJob({
  date,
  start,
  end,
  participants,
  submit = false,
  id,
  courtOrder = DEFAULT_COURT_ORDER,
  latestStartMs,
  nowMs = Date.now(),
} = {}) {
  const openAtMs = openingInstantForTargetDate(date);
  if (!Number.isFinite(nowMs) || openAtMs <= nowMs) {
    throw new Error('Scheduled job must have a future opening instant');
  }
  if (!Array.isArray(participants)) throw new Error('Scheduled job requires participant names');
  const job = {
    id: id || `${date}-${String(start || '').replace(':', '')}`,
    date,
    start,
    end,
    openAt: new Date(openAtMs).toISOString(),
    prepareAt: new Date(openAtMs - 3 * 60_000).toISOString(),
    latestStart: new Date(latestStartMs === undefined ? openAtMs + 5 * 60_000 : latestStartMs).toISOString(),
    bookingType: 'Stadium Pass - Singles',
    participants: [...participants],
    courtOrder: [...courtOrder],
    paymentPolicy: 'cancel-on-payment',
    submit,
  };
  return validateBookingJob(job, { mode: submit ? 'execute' : 'watch' });
}

export async function scheduleFutureJob({
  job,
  activeJobFile = DEFAULT_ACTIVE_JOB_FILE,
  nowMs = Date.now(),
  arm = armRtcWakeForJob,
} = {}) {
  if (!path.isAbsolute(activeJobFile || '')) throw new Error('activeJobFile must be absolute');
  validateBookingJob(job, { mode: job?.submit ? 'execute' : 'watch' });
  if (!job.prepareAt || Date.parse(job.openAt) <= nowMs) {
    throw new Error('Scheduled job must have a future opening instant and prepareAt');
  }
  return withJobLock(path.dirname(activeJobFile), async () => {
    try {
      await fs.access(activeJobFile);
      throw new Error('An active job already exists; refusing to replace it');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const wake = await arm(job);
    await fs.mkdir(path.dirname(activeJobFile), { recursive: true, mode: 0o700 });
    const temporary = `${activeJobFile}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(job)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, activeJobFile);
    await fs.chmod(activeJobFile, 0o600);
    return { status: 'scheduled_and_wake_armed', wakeAt: wake?.wakeAt, pmsetDate: wake?.pmsetDate, activeJobFile };
  });
}

export { DEFAULT_ACTIVE_JOB_FILE };
