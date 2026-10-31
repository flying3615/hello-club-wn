import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_WAIT_MS = 5_000;
const ARCHIVE_STATUSES = new Set(['completed', 'failed', 'missed']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function readLock(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function withJobLock(directory, action, {
  timeoutMs = DEFAULT_WAIT_MS,
  sleepMs = 50,
  sleepFn = sleep,
  now = Date.now,
} = {}) {
  if (!path.isAbsolute(directory || '')) throw new Error('Job lock directory must be absolute');
  if (typeof action !== 'function') throw new Error('Job lock requires an action');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) throw new Error('Job lock timeout must be a non-negative integer');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, '.active.lock');
  const token = randomUUID();
  const deadline = now() + timeoutMs;

  while (true) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, acquiredAt: new Date().toISOString() }));
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readLock(file);
      if (!processIsAlive(existing?.pid)) {
        await fs.rm(file, { force: true });
        continue;
      }
      if (now() >= deadline) throw new Error('Active job lock is held by another process');
      await sleepFn(sleepMs);
    }
  }

  try {
    return await action();
  } finally {
    const existing = await readLock(file);
    if (existing?.token === token) await fs.rm(file, { force: true });
  }
}

export async function archiveActiveJob({ jobFile, job, status, directory = path.dirname(jobFile) } = {}) {
  if (!path.isAbsolute(jobFile || '')) throw new Error('Active job file must be absolute');
  if (!ARCHIVE_STATUSES.has(status)) throw new Error('Active job can only be archived as completed, failed, or missed');
  if (typeof job?.id !== 'string' || !job.id) throw new Error('Active job archive requires a job ID');
  return withJobLock(directory, async () => {
    let current;
    try {
      current = JSON.parse(await fs.readFile(jobFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (current?.id !== job.id) return null;
    const archiveDirectory = path.join(directory, status);
    await fs.mkdir(archiveDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(archiveDirectory, `${job.id}.json`);
    await fs.rename(jobFile, target);
    await fs.chmod(target, 0o600);
    return target;
  });
}

export { ARCHIVE_STATUSES };
