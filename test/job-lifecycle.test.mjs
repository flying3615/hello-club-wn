import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { archiveActiveJob, withJobLock } from '../src/job-lifecycle.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hello-club-job-lifecycle-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('archives only the matching terminal active job with restrictive permissions', async (t) => {
  const directory = await fixture(t);
  const jobFile = path.join(directory, 'active.json');
  await fs.writeFile(jobFile, `${JSON.stringify({ id: 'job-1', date: '2026-11-03' })}\n`, { mode: 0o600 });
  const archivedTo = await archiveActiveJob({ jobFile, job: { id: 'job-1' }, status: 'completed' });
  assert.equal(archivedTo, path.join(directory, 'completed', 'job-1.json'));
  assert.equal((await fs.stat(archivedTo)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await fs.readFile(archivedTo, 'utf8')).id, 'job-1');
  await assert.rejects(fs.stat(jobFile), /ENOENT/);
});

test('does not archive an active job that was replaced by a different job', async (t) => {
  const directory = await fixture(t);
  const jobFile = path.join(directory, 'active.json');
  await fs.writeFile(jobFile, `${JSON.stringify({ id: 'job-2' })}\n`, { mode: 0o600 });
  assert.equal(await archiveActiveJob({ jobFile, job: { id: 'job-1' }, status: 'failed' }), null);
  assert.equal(JSON.parse(await fs.readFile(jobFile, 'utf8')).id, 'job-2');
  await assert.rejects(fs.stat(path.join(directory, 'failed', 'job-1.json')), /ENOENT/);
});

test('rejects unsupported archive statuses before touching the active job', async (t) => {
  const directory = await fixture(t);
  const jobFile = path.join(directory, 'active.json');
  await fs.writeFile(jobFile, `${JSON.stringify({ id: 'job-1' })}\n`, { mode: 0o600 });
  await assert.rejects(
    archiveActiveJob({ jobFile, job: { id: 'job-1' }, status: 'running' }),
    /completed, failed, or missed/i,
  );
  assert.ok(await fs.stat(jobFile));
});

test('reclaims a stale lock and serializes actions while a live lock is held', async (t) => {
  const directory = await fixture(t);
  const lock = path.join(directory, '.active.lock');
  await fs.writeFile(lock, `${JSON.stringify({ token: 'stale', pid: 999_999 })}\n`, { mode: 0o600 });
  let ran = false;
  await withJobLock(directory, async () => { ran = true; });
  assert.equal(ran, true);
  await assert.rejects(fs.stat(lock), /ENOENT/);

  await fs.writeFile(lock, `${JSON.stringify({ token: 'live', pid: process.pid })}\n`, { mode: 0o600 });
  await assert.rejects(
    withJobLock(directory, async () => {}, { timeoutMs: 0 }),
    /held by another process/i,
  );
  assert.ok(await fs.stat(lock));
  await fs.rm(lock, { force: true });
});
