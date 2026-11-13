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

test('leads with the next opening and its readiness, then the last result', async () => {
  const html = await fs.readFile(panel, 'utf8');
  const hero = html.indexOf('id="hero"');
  const checks = html.indexOf('明早能不能正常跑');
  const result = html.indexOf('id="result"');
  const upcoming = html.indexOf('id="upcoming"');
  assert.ok(hero > 0 && hero < checks && checks < result && result < upcoming);
  assert.match(html, /function lanesHtml\(/);
  assert.match(html, /setInterval\(refresh, 60_000\)/);
  assert.doesNotMatch(html, /<form|method="post"/i);
});
