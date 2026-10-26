import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const panel = path.resolve(new URL('..', import.meta.url).pathname, 'public', 'control-panel.html');

test('gives an actionable message when opened directly as a file', async () => {
  const html = await fs.readFile(panel, 'utf8');
  assert.match(html, /location\.protocol === 'file:'/);
  assert.match(html, /Open http:\/\/127\.0\.0\.1:8787/);
});

test('prioritizes active jobs and upcoming bookings over diagnostics', async () => {
  const html = await fs.readFile(panel, 'utf8');
  assert.match(html, /id="system-status"/);
  assert.match(html, /<h2>Next booking<\/h2>/);
  assert.match(html, /class="booking-focus"/);
  assert.match(html, /function activeBookingFocus\(job, status\)/);
  assert.match(html, /data-icon="calendar"/);
  assert.match(html, /data-icon="opening"/);
  assert.match(html, /Auto-refreshes every hour/);
  assert.match(html, /setInterval\(refresh, 3_600_000\)/);
  assert.doesNotMatch(html, /<h2>Live processes<\/h2>/);
});
