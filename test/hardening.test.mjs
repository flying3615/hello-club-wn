import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelfHealingTab, watchOpening } from '../src/opening-watch.mjs';
import { submitWithCourtFallback } from '../src/launchd-runner.mjs';
import { PreConfirmBookingError } from '../src/booking-submit.mjs';
import { isTransientBrowserError, shouldRetry } from '../src/recurring-booking.mjs';
import { buildRecurringTaskPlist } from '../src/launchd-plist.mjs';
import { getRecurringTask } from '../src/recurring-tasks.mjs';
import { isTargetClosedError } from '../src/session.mjs';

const CLOSED = 'page.goto: Target page, context or browser has been closed';

function fakePage({ failGotos = 0, url = 'about:blank', ready = true } = {}) {
  const page = {
    closed: false,
    gotos: 0,
    currentUrl: url,
    url: () => page.currentUrl,
    isClosed: () => page.closed,
    close: async () => { page.closed = true; },
    goto: async (target) => {
      page.gotos += 1;
      if (page.gotos <= failGotos) {
        page.closed = true;
        throw new Error(CLOSED);
      }
      page.currentUrl = target;
    },
    locator: () => ({ waitFor: async () => {} }),
    evaluate: async () => ready,
  };
  return page;
}

function fakeContext(pages) {
  const created = [];
  return {
    created,
    pages: () => [],
    browser: () => ({ isConnected: () => true }),
    newPage: async () => {
      const page = pages.shift() || fakePage();
      created.push(page);
      return page;
    },
  };
}

test('recognises closed or crashed targets', () => {
  assert.equal(isTargetClosedError(new Error(CLOSED)), true);
  assert.equal(isTargetClosedError(new Error('Target crashed')), true);
  assert.equal(isTargetClosedError(new Error('No complete interval available')), false);
});

test('self-healing tab replaces a tab that died before the opening navigation', async () => {
  const dead = fakePage({ failGotos: 1 });
  const fresh = fakePage();
  const context = fakeContext([fresh]);
  const tab = createSelfHealingTab({ context, targetUrl: 'https://example.test/x' });
  tab.adopt(dead);
  const page = await tab.navigate();
  assert.equal(page, fresh);
  assert.equal(fresh.currentUrl, 'https://example.test/x');
});

test('self-healing tab gives up when the browser itself disconnected', async () => {
  const context = { ...fakeContext([]), browser: () => ({ isConnected: () => false }) };
  const tab = createSelfHealingTab({ context, targetUrl: 'https://example.test/x' });
  tab.adopt(fakePage({ failGotos: 5 }));
  await assert.rejects(tab.navigate(), /has been closed/);
});

test('watchOpening survives the tab being closed at the opening instant (14 Nov failure)', async () => {
  // First page: survives prewarm open, then dies on the opening reload.
  const first = fakePage();
  let gotoCount = 0;
  first.goto = async (target) => {
    gotoCount += 1;
    if (gotoCount >= 2) { first.closed = true; throw new Error(CLOSED); }
    first.currentUrl = target;
  };
  const replacement = fakePage({ ready: false });
  let readyChecks = 0;
  replacement.evaluate = async () => { readyChecks += 1; return readyChecks >= 2; };
  const context = fakeContext([first, replacement]);
  let clock = 0;
  const openAtMs = 60_000;
  const result = await watchOpening({
    context,
    date: '2026-11-21',
    openAtMs,
    pollMs: 1_000,
    timeoutMs: 60_000,
    leadMs: 15_000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  }).catch((error) => error);
  // The grid scan itself needs a real DOM; reaching it proves the poll became ready
  // on the replacement tab instead of aborting with "Target page ... closed".
  assert.ok(!(result instanceof Error) || !isTargetClosedError(result), String(result?.message));
  assert.ok(context.created.includes(replacement));
  assert.ok(replacement.gotos >= 1);
});

const job = {
  date: '2026-11-21', start: '08:00', end: '09:30', courtOrder: ['Court 4', 'Court 5', 'Court 6'],
};

test('falls back to the next court when a court fails before CONFIRM BOOKING', async () => {
  const submitted = [];
  const reloads = [];
  const result = await submitWithCourtFallback({
    context: {},
    opening: { page: {}, grid: 'grid-0', gridRoot: 'root-0' },
    job,
    deadline: 10_000,
    now: () => 0,
    select: async ({ grid, exclude }) => {
      const court = grid === 'grid-0' ? 'Court 4' : 'Court 5';
      assert.equal(exclude.has(court), false);
      return { court, checked: [court] };
    },
    submit: async ({ court, grid }) => {
      submitted.push({ court, grid });
      if (court === 'Court 4') throw new PreConfirmBookingError(court, new Error('modal did not open'));
      return { court, paymentStatus: 'free' };
    },
    reload: async () => { reloads.push(1); return { grid: 'grid-1', gridRoot: 'root-1' }; },
  });
  assert.deepEqual(submitted, [{ court: 'Court 4', grid: 'grid-0' }, { court: 'Court 5', grid: 'grid-1' }]);
  assert.equal(reloads.length, 1);
  assert.equal(result.selection.court, 'Court 5');
});

test('never falls back after an error at or after CONFIRM BOOKING', async () => {
  let submits = 0;
  await assert.rejects(submitWithCourtFallback({
    context: {},
    opening: { page: {}, grid: 'g', gridRoot: 'r' },
    job,
    deadline: 10_000,
    now: () => 0,
    select: async () => ({ court: 'Court 4', checked: ['Court 4'] }),
    submit: async () => { submits += 1; throw new Error('Post-confirmation state is unknown'); },
    reload: async () => assert.fail('must not reload'),
  }), /Post-confirmation/);
  assert.equal(submits, 1);
});

test('excludes a court after two pre-confirm failures and stops at the deadline', async () => {
  let clock = 0;
  const seenExcludes = [];
  await assert.rejects(submitWithCourtFallback({
    context: {},
    opening: { page: {}, grid: 'g', gridRoot: 'r' },
    job,
    deadline: 3_500,
    now: () => clock,
    select: async ({ exclude }) => {
      seenExcludes.push([...exclude]);
      const court = exclude.has('Court 4') ? 'Court 5' : 'Court 4';
      return { court, checked: [court] };
    },
    submit: async ({ court }) => { clock += 1_000; throw new PreConfirmBookingError(court, new Error('x')); },
    reload: async () => ({ grid: 'g', gridRoot: 'r' }),
  }), /latest start/);
  assert.deepEqual(seenExcludes[2], ['Court 4']);
});

test('retries transient browser failures until latestStart, not a fixed three times', () => {
  const error = new Error(CLOSED);
  assert.equal(shouldRetry({ error, attempt: 5, nowMs: 0, latestStartMs: 60_000 }), true);
  assert.equal(shouldRetry({ error, attempt: 5, nowMs: 59_000, latestStartMs: 60_000 }), false);
  assert.equal(shouldRetry({ error: new Error('No complete interval available'), attempt: 0, nowMs: 0, latestStartMs: 60_000 }), false);
  assert.equal(isTransientBrowserError(new Error('page.goto: net::ERR_NETWORK_CHANGED')), true);
});

test('recurring LaunchAgents keep the Mac awake through the opening', () => {
  const plist = buildRecurringTaskPlist({
    task: getRecurringTask('weekend'), nodePath: '/usr/local/bin/node', projectDir: '/Users/x/hello-club-playwright',
  });
  assert.match(plist, /<string>\/usr\/bin\/caffeinate<\/string><string>-dimsu<\/string>/);
  assert.match(plist, /<integer>6<\/integer><key>Hour<\/key><integer>6<\/integer><key>Minute<\/key><integer>57<\/integer>/);
  assert.match(plist, /<integer>0<\/integer><key>Hour<\/key>/);
  assert.match(plist, /weekend-booking\.mjs/);
});
