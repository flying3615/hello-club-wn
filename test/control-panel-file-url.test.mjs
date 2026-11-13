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

test('leads with the next opening, recurring tasks and upcoming bookings; details stay collapsed below', async () => {
  const html = await fs.readFile(panel, 'utf8');
  const order = ['id="hero"', 'id="tasks"', 'id="upcoming"', 'id="result"', 'id="past"', 'id="activity"'].map((needle) => html.indexOf(needle));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1])), String(order));
  assert.match(html, /<details class="more">\s*<summary>上次结果/);
  assert.doesNotMatch(html, /<details class="more" open/);
  assert.match(html, /function lanesHtml\(/);
  assert.match(html, /setInterval\(refresh, 60_000\)/);
  assert.doesNotMatch(html, /<form|method="post"/i);
});
