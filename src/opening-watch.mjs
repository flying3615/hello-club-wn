import {
  connectExistingChrome,
  isPagePreloading,
  isTargetClosedError,
  openRawBookingPage,
} from './session.mjs';
import { DEFAULT_BASE_URL, DEFAULT_CDP_ENDPOINT, bookingUrl } from './config.mjs';
import { scanBookingGrid } from './booking-grid.mjs';
import { chooseCourt } from './booking-policy.mjs';
import {
  normalizePollOptions,
  pollUntilReady,
  waitUntilOpeningWindow,
} from './opening-window.mjs';
export { waitUntilOpeningWindow };

const TARGET_ZONE = 'Pacific/Auckland';
const COMPLETE_GRID_SLOT_COUNT = 48 * 6;

export function selectCompleteTargetGridIndex(candidates) {
  const matches = (candidates || []).filter((candidate) => (
    candidate?.visible
    && candidate.containsVenue
    && candidate.containsTargetDate
    && candidate.courtCount === 6
    && candidate.slotCount === COMPLETE_GRID_SLOT_COUNT
  ));
  if (matches.length !== 1) throw new Error('Expected exactly one complete target calendar grid');
  return matches[0].index;
}

export async function locateTargetCalendarGridRoot(page, date) {
  const label = formatTargetDateLabel(date);
  const grids = page.locator('.BookingGrid');
  const candidates = await grids.evaluateAll((elements, targetDateLabel) => elements.map((grid, index) => {
    const card = grid.closest('.Card');
    const scope = card || grid;
    const gridRect = grid.getBoundingClientRect();
    const gridStyle = getComputedStyle(grid);
    const text = String(scope.innerText || '');
    const courts = [...scope.querySelectorAll('.BookingGridArea-name')]
      .map((node) => node.textContent?.trim())
      .filter((name) => /^Court [1-6]$/.test(name));
    return {
      index,
      visible: gridStyle.display !== 'none' && gridStyle.visibility !== 'hidden' && gridRect.width > 0 && gridRect.height > 0,
      containsVenue: text.includes('Wellington North Badminton Stadium'),
      containsTargetDate: text.includes(targetDateLabel),
      courtCount: new Set(courts).size,
      slotCount: grid.querySelectorAll('.BookingGrid-column booking-grid-slot').length,
    };
  }), label);
  const gridIndex = selectCompleteTargetGridIndex(candidates);
  const gridRoot = grids.nth(gridIndex).locator('xpath=ancestor-or-self::*[contains(concat(" ", normalize-space(@class), " "), " Card ")][1]');
  if (await gridRoot.count() !== 1) throw new Error('Complete target grid is not contained by one calendar card');
  return gridRoot;
}

export function formatTargetDateLabel(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid booking date: ${date}`);
  const [year, month, day] = date.split('-').map(Number);
  const formatted = new Intl.DateTimeFormat('en-NZ', {
    timeZone: TARGET_ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).formatToParts(new Date(Date.UTC(year, month - 1, day, 6)));
  const values = Object.fromEntries(formatted.map(({ type, value }) => [type, value]));
  return `${values.weekday} ${values.day} ${values.month}`;
}

export function isTargetPageReady(bodyText, date) {
  const text = String(bodyText || '').trim();
  if (/^Loading(?:\.\.\.|…)/.test(text)) return false;
  const required = [
    'Wellington North Badminton Stadium',
    formatTargetDateLabel(date),
    'Court 1',
    'Court 2',
    'Court 3',
    'Court 4',
    'Court 5',
    'Court 6',
  ];
  return required.every((item) => text.includes(item));
}

export async function isTargetGridReady(page, date) {
  const label = formatTargetDateLabel(date);
  return page.evaluate((targetDateLabel) => {
    const bodyText = String(document.body?.innerText || '').trim();
    if (/^Loading(?:\.\.\.|…)/.test(bodyText)) return false;
    const preloader = document.querySelector('#Preloader');
    if (preloader) {
      const style = getComputedStyle(preloader);
      if (style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0) return false;
    }
    const grid = [...document.querySelectorAll('.BookingGrid')].find((candidate) => (
      candidate.querySelectorAll('.BookingGrid-column booking-grid-slot').length >= 48 * 6
    ));
    if (!grid) return false;
    const host = grid.closest('booking-grid');
    const ctrl = host && window.angular ? window.angular.element(host).scope?.()?.$ctrl : null;
    if (!ctrl || ctrl.hasLoadedData !== true) return false;
    if (Array.isArray(ctrl.loadOps) && ctrl.loadOps.length > 0) return false;
    if (document.querySelectorAll('booking-grid-slot.ng-animate').length > 0) return false;
    const card = grid.closest('.Card');
    const text = String(card?.innerText || '');
    const courts = [...(card || grid).querySelectorAll('.BookingGridArea-name')]
      .map((node) => node.textContent?.trim()).filter((name) => /^Court [1-6]$/.test(name));
    return text.includes('Wellington North Badminton Stadium')
      && text.includes(targetDateLabel)
      && new Set(courts).size === 6;
  }, label);
}

export function createSelfHealingTab({ context, targetUrl, maxReopens = 3 }) {
  let page = null;
  const tab = {
    adopt(candidate) { page = candidate; },
    browserDisconnected() {
      const browser = typeof context.browser === 'function' ? context.browser() : null;
      return Boolean(browser && typeof browser.isConnected === 'function' && !browser.isConnected());
    },
    async live() {
      if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
        page = await context.newPage();
      }
      return page;
    },
    async navigate() {
      for (let attempt = 0; ; attempt += 1) {
        const current = await tab.live();
        try {
          await current.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await current.locator('body').waitFor({ state: 'visible', timeout: 30_000 });
          return current;
        } catch (error) {
          if (!isTargetClosedError(error) || attempt >= maxReopens || tab.browserDisconnected()) throw error;
          if (typeof current.isClosed !== 'function' || current.isClosed()) page = null;
        }
      }
    },
  };
  return tab;
}

export async function reloadTargetGrid({
  page, date, baseUrl = DEFAULT_BASE_URL, timeoutMs = 20_000, pollMs = 1_000,
  now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const targetUrl = bookingUrl(date, baseUrl);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const poll = await pollUntilReady({
    isReady: async () => isTargetGridReady(page, date),
    refresh: async () => {},
    pollMs,
    timeoutMs,
    now,
    sleep,
  });
  if (!poll.ready) throw new Error('Target grid did not become ready after reload');
  const gridRoot = await locateTargetCalendarGridRoot(page, date);
  const grid = await scanBookingGrid(gridRoot);
  return { gridRoot, grid };
}

export async function waitForOpeningInstant({ openAtMs, now, sleep }) {
  return waitUntilOpeningWindow({ openAtMs, leadMs: 0, now, sleep });
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) args[argv[index].slice(2)] = argv[index + 1];
  }
  return args;
}

function usage() {
  console.log('Usage: node src/opening-watch.mjs --date YYYY-MM-DD --start HH:MM --end HH:MM --open-at ISO [--cdp] [--poll-ms 2500] [--timeout-ms 180000] [--lead-ms 15000]');
}

export async function watchOpening({
  context,
  date,
  start,
  end,
  openAtMs,
  baseUrl = DEFAULT_BASE_URL,
  courtOrder = undefined,
  pollMs = 2_500,
  timeoutMs = 180_000,
  leadMs = 15_000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const targetUrl = bookingUrl(date, baseUrl);
  const options = normalizePollOptions({ pollMs, timeoutMs, leadMs });
  const tab = createSelfHealingTab({ context, targetUrl });
  try {
    await tab.adopt(await openRawBookingPage(context, date, baseUrl));
  } catch (error) {
    if (!isTargetClosedError(error)) throw error;
  }

  // Prewarm: re-navigate shortly before the opening so a tab that was discarded,
  // crashed or detached while the Mac slept is replaced before the critical instant.
  const tolerantNavigate = async () => {
    try {
      await tab.navigate();
    } catch (error) {
      if (tab.browserDisconnected()) throw error;
    }
  };
  if (now() < openAtMs - 2_000) {
    await waitUntilOpeningWindow({ openAtMs, leadMs: options.leadMs, now, sleep });
    await tolerantNavigate();
  }

  await waitForOpeningInstant({ openAtMs, now, sleep });
  await tolerantNavigate();

  const poll = await pollUntilReady({
    isReady: async () => {
      try {
        return await isTargetGridReady(await tab.live(), date);
      } catch (error) {
        // A closed tab is replaced by tab.live() on the next refresh; a context
        // destroyed by an in-flight reload simply means "not ready yet".
        if (!isTargetClosedError(error) || tab.browserDisconnected()) throw error;
        return false;
      }
    },
    refresh: async () => {
      try {
        const current = await tab.live();
        if (await isPagePreloading(current)) return;
      } catch (error) {
        if (!isTargetClosedError(error) || tab.browserDisconnected()) throw error;
      }
      // A slow or failed reload must not abort the bounded opening window;
      // only a disconnected browser is fatal here (the caller reconnects).
      await tolerantNavigate();
    },
    pollMs: options.pollMs,
    timeoutMs: options.timeoutMs,
    now,
    sleep,
  });
  const page = await tab.live();

  if (!poll.ready) return { page, poll, targetUrl, gridRoot: null, grid: null, selection: null };
  const gridRoot = await locateTargetCalendarGridRoot(page, date);
  const grid = await scanBookingGrid(gridRoot);
  let selection = null;
  if (start && end) {
    try {
      selection = chooseCourt(grid, { start, end }, courtOrder);
    } catch (error) {
      selection = { error: error.message, checked: error.checked || [] };
    }
  }
  return { page, poll, targetUrl, gridRoot, grid, selection };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.date || !args['open-at']) {
    usage();
    process.exitCode = 2;
    return;
  }
  const openAtMs = Date.parse(args['open-at']);
  if (!Number.isFinite(openAtMs)) throw new Error(`Invalid --open-at timestamp: ${args['open-at']}`);
  const { context } = await connectExistingChrome(args['cdp-endpoint'] || DEFAULT_CDP_ENDPOINT);
  const result = await watchOpening({
    context,
    date: args.date,
    start: args.start,
    end: args.end,
    openAtMs,
    baseUrl: args['base-url'] || DEFAULT_BASE_URL,
    pollMs: Number(args['poll-ms'] || 2_500),
    timeoutMs: Number(args['timeout-ms'] || 180_000),
    leadMs: Number(args['lead-ms'] || 15_000),
  });
  console.log(JSON.stringify({
    targetUrl: result.targetUrl,
    ready: result.poll.ready,
    timedOut: result.poll.timedOut,
    attempts: result.poll.attempts,
    selection: result.selection,
    pageUrl: result.page.url(),
  }, null, 2));
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
