const DEFAULT_POLL_MS = 2_500;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_LEAD_MS = 15_000;
const AUCKLAND_TIME_ZONE = 'Pacific/Auckland';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function datePartsAt(epochMs) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: AUCKLAND_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  return Object.fromEntries(formatter.formatToParts(new Date(epochMs))
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
}

export function openingInstantForTargetDate(targetDate) {
  if (typeof targetDate !== 'string' || !DATE.test(targetDate)) {
    throw new Error('targetDate must be YYYY-MM-DD');
  }
  const targetMidnight = new Date(`${targetDate}T00:00:00Z`);
  if (Number.isNaN(targetMidnight.valueOf())) throw new Error('targetDate must be a real calendar date');
  targetMidnight.setUTCDate(targetMidnight.getUTCDate() - 7);
  const openingDate = targetMidnight.toISOString().slice(0, 10);
  const desiredUtc = Date.parse(`${openingDate}T07:00:00Z`);
  let candidate = desiredUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = datePartsAt(candidate);
    const observedUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    const adjustment = desiredUtc - observedUtc;
    if (adjustment === 0) return candidate;
    candidate += adjustment;
  }
  throw new Error(`Could not resolve ${openingDate} 07:00 in ${AUCKLAND_TIME_ZONE}`);
}

export function normalizePollOptions({
  pollMs = DEFAULT_POLL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  leadMs = DEFAULT_LEAD_MS,
} = {}) {
  if (!Number.isFinite(pollMs) || pollMs < 1_000 || pollMs > 60_000) {
    throw new Error('pollMs must be between 1000 and 60000 milliseconds.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 900_000) {
    throw new Error('timeoutMs must be between 1 and 900000 milliseconds.');
  }
  if (!Number.isFinite(leadMs) || leadMs < 0 || leadMs > timeoutMs) {
    throw new Error('leadMs must be between 0 and timeoutMs milliseconds.');
  }
  return { pollMs, timeoutMs, leadMs };
}

export async function waitUntilOpeningWindow({
  openAtMs,
  leadMs = DEFAULT_LEAD_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!Number.isFinite(openAtMs)) throw new Error('openAtMs must be a finite timestamp.');
  if (!Number.isFinite(leadMs) || leadMs < 0) throw new Error('leadMs must be non-negative.');
  const startedAtMs = openAtMs - leadMs;
  const remainingMs = startedAtMs - now();
  if (remainingMs > 0) await sleep(remainingMs);
  return { startedAtMs, openAtMs };
}

export async function pollUntilReady({
  isReady,
  refresh,
  pollMs = DEFAULT_POLL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof isReady !== 'function') throw new Error('isReady must be a function.');
  if (typeof refresh !== 'function') throw new Error('refresh must be a function.');
  const { pollMs: intervalMs } = normalizePollOptions({ pollMs, timeoutMs, leadMs: 0 });
  const startedAtMs = now();
  const deadlineMs = startedAtMs + timeoutMs;
  let attempts = 0;

  while (true) {
    attempts += 1;
    if (await isReady()) {
      return { ready: true, timedOut: false, attempts, startedAtMs, finishedAtMs: now() };
    }
    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) {
      return { ready: false, timedOut: true, attempts, startedAtMs, finishedAtMs: now() };
    }
    await refresh();
    await sleep(Math.min(intervalMs, remainingMs));
  }
}

export { DEFAULT_POLL_MS, DEFAULT_TIMEOUT_MS, DEFAULT_LEAD_MS };
