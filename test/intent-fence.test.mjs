import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { bookingIntentKey } from '../src/booking-intent.mjs';
import { clearIntentFence, readIntentFence, reconcileIntentFence, writeIntentFence } from '../src/intent-fence.mjs';

const job = {
  date: '2026-11-06', start: '17:00', end: '18:00', bookingType: 'Stadium Pass - Singles',
  participants: ['Yufei Liu', 'Zijia Liu'], courtOrder: ['Court 4', 'Court 5'],
};

async function fixture(t) {
  const parent = path.join(process.cwd(), 'cache');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const dir = await fs.mkdtemp(path.join(parent, 'intent-fence-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('durably records an ambiguous confirmation before reconciliation', async (t) => {
  const directory = await fixture(t);
  const fence = await writeIntentFence({ directory, job, phase: 'confirmation_unknown', priorBookingIds: ['old-1'], selectedCourt: 'Court 4' });
  assert.equal(fence.intentKey, bookingIntentKey(job));
  assert.equal(fence.phase, 'confirmation_unknown');
  assert.deepEqual(fence.priorBookingIds, ['old-1']);
  assert.deepEqual(await readIntentFence({ directory, job }), fence);
});

test('blocks execution when reconciliation has no exact remote record', async (t) => {
  const directory = await fixture(t);
  await writeIntentFence({ directory, job, phase: 'confirmation_unknown', priorBookingIds: [] });
  const result = await reconcileIntentFence({ directory, job, read: async () => [] });
  assert.deepEqual(result, { state: 'blocked' });
  assert.ok(await readIntentFence({ directory, job }));
});

test('does not clear a fence from a remote record that existed before the uncertain action', async (t) => {
  const directory = await fixture(t);
  await writeIntentFence({ directory, job, phase: 'confirmation_unknown', priorBookingIds: ['old-1'] });
  const record = { id: 'old-1', date: job.date, start: job.start, end: job.end, court: 'Court 4', bookingType: job.bookingType, participants: [...job.participants] };
  const result = await reconcileIntentFence({ directory, job, read: async () => [record] });
  assert.deepEqual(result, { state: 'blocked' });
  assert.ok(await readIntentFence({ directory, job }));
});

test('does not clear a fence from a new matching record on a different court', async (t) => {
  const directory = await fixture(t);
  await writeIntentFence({ directory, job, phase: 'confirmation_unknown', priorBookingIds: ['old-1'], selectedCourt: 'Court 4' });
  const record = { id: 'new-2', date: job.date, start: job.start, end: job.end, court: 'Court 5', bookingType: job.bookingType, participants: [...job.participants] };
  const result = await reconcileIntentFence({ directory, job, read: async () => [record] });
  assert.deepEqual(result, { state: 'blocked' });
  assert.ok(await readIntentFence({ directory, job }));
});

test('clears only after authenticated remote reconciliation finds the selected exact intent', async (t) => {
  const directory = await fixture(t);
  await writeIntentFence({ directory, job, phase: 'confirmation_unknown', priorBookingIds: ['old-1'], selectedCourt: 'Court 4' });
  const record = { id: 'new-2', date: job.date, start: job.start, end: job.end, court: 'Court 4', bookingType: job.bookingType, participants: [...job.participants] };
  const result = await reconcileIntentFence({ directory, job, read: async () => [record] });
  assert.deepEqual(result, { state: 'verified', record });
  assert.equal(await readIntentFence({ directory, job }), null);
  await clearIntentFence({ directory, job });
});
