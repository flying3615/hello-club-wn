import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCronJobs } from '../src/cron-diagnostics.mjs';

test('summarizes cron state without retaining task prompts or credentials', () => {
  const result = summarizeCronJobs({
    updated_at: '2026-10-25T07:16:18+13:00',
    jobs: [{
      id: 'job-1',
      name: 'Hello Club test',
      prompt: 'password=[REDACTED] and a very long booking instruction',
      enabled: true,
      state: 'scheduled',
      next_run_at: '2026-10-26T06:57:00+13:00',
      last_run_at: null,
      last_status: null,
    }],
  });

  assert.deepEqual(result, {
    updatedAt: '2026-10-25T07:16:18+13:00',
    jobs: [{
      id: 'job-1',
      name: 'Hello Club test',
      enabled: true,
      state: 'scheduled',
      nextRunAt: '2026-10-26T06:57:00+13:00',
      lastRunAt: null,
      lastStatus: null,
    }],
  });
  assert.equal(JSON.stringify(result).includes('password'), false);
});

test('tolerates a missing or malformed cron store', () => {
  assert.deepEqual(summarizeCronJobs(null), { updatedAt: null, jobs: [] });
  assert.deepEqual(summarizeCronJobs({ jobs: 'not-an-array' }), { updatedAt: null, jobs: [] });
});
