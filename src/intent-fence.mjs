import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { bookingIntentKey, remoteRecordMatchesIntent } from './booking-intent.mjs';

const DEFAULT_FENCE_DIRECTORY = path.resolve(new URL('../state/reconciliation', import.meta.url).pathname);
const VALID_PHASES = new Set(['selection_unknown', 'confirmation_unknown']);

function fenceFile(directory, job) {
  if (!path.isAbsolute(directory || '')) throw new Error('Intent fence directory must be absolute');
  return path.join(directory, `${bookingIntentKey(job)}.json`);
}

function normalizeFence({ job, phase, priorBookingIds = [], selectedCourt = null, now = new Date().toISOString() }) {
  if (!VALID_PHASES.has(phase)) throw new Error('Intent fence requires a supported ambiguous phase');
  if (!Array.isArray(priorBookingIds) || priorBookingIds.some((id) => typeof id !== 'string' || !id)) {
    throw new Error('Intent fence requires valid prior booking IDs');
  }
  if (selectedCourt !== null && !/^Court [1-6]$/.test(selectedCourt)) throw new Error('Intent fence has an invalid selected court');
  return {
    intentKey: bookingIntentKey(job), phase, priorBookingIds: [...new Set(priorBookingIds)].sort(), selectedCourt, createdAt: now,
  };
}

export async function writeIntentFence({ directory = DEFAULT_FENCE_DIRECTORY, job, phase, priorBookingIds, selectedCourt, now } = {}) {
  const fence = normalizeFence({ job, phase, priorBookingIds, selectedCourt, now });
  const file = fenceFile(directory, job);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(fence)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600);
  return fence;
}

export async function readIntentFence({ directory = DEFAULT_FENCE_DIRECTORY, job } = {}) {
  const file = fenceFile(directory, job);
  try {
    const fence = JSON.parse(await fs.readFile(file, 'utf8'));
    if (fence?.intentKey !== bookingIntentKey(job) || !VALID_PHASES.has(fence?.phase) || !Array.isArray(fence?.priorBookingIds)) {
      throw new Error('Intent fence is invalid');
    }
    return fence;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function clearIntentFence({ directory = DEFAULT_FENCE_DIRECTORY, job } = {}) {
  await fs.rm(fenceFile(directory, job), { force: true });
}

export async function reconcileIntentFence({ directory = DEFAULT_FENCE_DIRECTORY, job, read } = {}) {
  if (typeof read !== 'function') throw new Error('Intent reconciliation requires an authenticated read function');
  const fence = await readIntentFence({ directory, job });
  if (!fence) return { state: 'none' };
  const records = await read();
  const priorBookingIds = new Set(fence.priorBookingIds);
  const record = (records || []).find((candidate) => (
    remoteRecordMatchesIntent(candidate, job)
    && candidate?.court === fence.selectedCourt
    && !priorBookingIds.has(candidate.id)
  ));
  if (!record) return { state: 'blocked' };
  await clearIntentFence({ directory, job });
  return { state: 'verified', record };
}

export { DEFAULT_FENCE_DIRECTORY };
