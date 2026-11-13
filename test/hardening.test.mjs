import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelfHealingTab, gridHasFreeTime, watchOpening } from '../src/opening-watch.mjs';
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

function readyPage(overrides = {}) {
  const page = fakePage();
  page.waitForFunction = async () => true;
  return Object.assign(page, overrides);
}

test('watchOpening survives the tab being closed at the opening instant (14 Nov failure)', async () => {
  // The prewarm tab dies on the opening reload; a replacement tab must take over.
  const first = readyPage();
  let gotoCount = 0;
  first.goto = async (target) => {
    gotoCount += 1;
    if (gotoCount >= 2) { first.closed = true; throw new Error(CLOSED); }
    first.currentUrl = target;
  };
  const replacement = readyPage();
  const context = fakeContext([first, replacement]);
  let clock = 0;
  const scans = [];
  const result = await watchOpening({
    context, date: '2026-11-21', start: '08:00', end: '10:00', openAtMs: 60_000,
    pollMs: 1_000, timeoutMs: 60_000, leadMs: 15_000,
    isOpen: () => true,
    scan: async (page) => { scans.push(page); return { gridRoot: 'root', grid: [] }; },
    now: () => clock, sleep: async (ms) => { clock += ms; },
  });
  assert.equal(result.poll.ready, true);
  assert.equal(result.page, replacement);
  assert.deepEqual(scans, [replacement]);
});

test('watchOpening reloads a grid that still shows the day before it opened', async () => {
  const page = readyPage();
  const context = fakeContext([page]);
  let clock = 59_000;
  let scans = 0;
  const marks = [];
  const result = await watchOpening({
    context, date: '2026-11-21', start: '08:00', end: '10:00', openAtMs: 60_000,
    timeoutMs: 60_000, leadMs: 0,
    isOpen: () => scans >= 3,
    scan: async () => { scans += 1; return { gridRoot: 'root', grid: [] }; },
    mark: (label) => marks.push(label),
    now: () => clock, sleep: async (ms) => { clock += ms; },
  });
  assert.equal(scans, 3);
  assert.equal(result.poll.attempts, 3);
  assert.equal(marks.filter((label) => label === 'not_open_yet').length, 2);
});

test('watchOpening stops reloading a closed-looking grid after the grace period', async () => {
  const page = readyPage();
  const context = fakeContext([page]);
  let clock = 60_000;
  let scans = 0;
  const result = await watchOpening({
    context, date: '2026-11-21', start: '08:00', end: '10:00', openAtMs: 60_000,
    timeoutMs: 120_000, leadMs: 0, openGraceMs: 1_000,
    isOpen: () => false,
    scan: async () => { scans += 1; clock += 400; return { gridRoot: 'root', grid: [] }; },
    now: () => clock, sleep: async (ms) => { clock += ms; },
  });
  assert.equal(result.poll.ready, true);
  assert.ok(scans >= 2 && scans <= 4, String(scans));
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

test('a flexible day counts as open once any court has free time before the peak', () => {
  const grid = [{ court: 'Court 1', slots: [{ start: '12:30', end: '13:00', available: true }, { start: '13:00', end: '13:30', available: true }] }];
  assert.equal(gridHasFreeTime(grid, { start: '08:00', end: '13:00' }), true);
  assert.equal(gridHasFreeTime(grid, { start: '08:00', end: '12:30' }), false);
});
