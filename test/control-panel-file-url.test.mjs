import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const panel = path.resolve(new URL('..', import.meta.url).pathname, 'public', 'control-panel.html');

test('gives an actionable message when opened directly as a file', async () => {
  const html = await fs.readFile(panel, 'utf8');
  assert.match(html, /location\.protocol === 'file:'/);
  assert.match(html, /请通过 http:\/\/127\.0\.0\.1:8787 打开/);
});

test('prioritizes active jobs and upcoming bookings over diagnostics', async () => {
  const html = await fs.readFile(panel, 'utf8');
  assert.match(html, /id="system-status"/);
  assert.match(html, /<h2>当前任务<\/h2>/);
  assert.match(html, /<h2>周期任务<\/h2>/);
  assert.match(html, /class="job-summary"/);
  assert.match(html, /function renderJob\(job\)/);
  assert.match(html, /id="failure" class="failure-banner"/);
  assert.match(html, /每小时自动刷新/);
  assert.match(html, /setInterval\(refresh, 3_600_000\)/);
  assert.doesNotMatch(html, /<h2>Live processes<\/h2>/);
});
