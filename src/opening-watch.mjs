import {
  connectExistingChrome,
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

const TARGET_ZONE = 'Pacific/Auckland';

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
  const text = String(bodyText || '');
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
    const grid = [...document.querySelectorAll('.BookingGrid')].find((candidate) => (
      candidate.querySelectorAll('.BookingGrid-column booking-grid-slot').length >= 48 * 6
    ));
    if (!grid) return false;
    const card = grid.closest('.Card');
    const text = String(card?.innerText || '');
    const courts = [...(card || grid).querySelectorAll('.BookingGridArea-name')]
      .map((node) => node.textContent?.trim()).filter((name) => /^Court [1-6]$/.test(name));
    return text.includes('Wellington North Badminton Stadium')
      && text.includes(targetDateLabel)
      && new Set(courts).size === 6;
  }, label);
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
  const page = await openRawBookingPage(context, date, baseUrl);
  const options = normalizePollOptions({ pollMs, timeoutMs, leadMs });
  await waitForOpeningInstant({ openAtMs, now, sleep });
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('body').waitFor({ state: 'visible', timeout: 30_000 });

  const poll = await pollUntilReady({
    isReady: async () => isTargetGridReady(page, date),
    refresh: async () => {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      await page.locator('body').waitFor({ state: 'visible', timeout: 30_000 });
    },
    pollMs: options.pollMs,
    timeoutMs: options.timeoutMs,
    now,
    sleep,
  });

  if (!poll.ready) return { page, poll, targetUrl, gridRoot: null, grid: null, selection: null };
  const gridRoot = page.locator('.Card').filter({ hasText: formatTargetDateLabel(date) })
    .filter({ has: page.locator('.BookingGrid') });
  if (await gridRoot.count() !== 1) throw new Error('Expected exactly one target calendar card');
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
