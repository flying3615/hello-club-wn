// Read-only check of whether the dedicated Chrome is signed in to Hello Club.
// It only navigates a new tab to the public booking page and reads rendered text; it never
// reads cookies, storage, or credentials, and never clicks anything.
import { connectExistingChrome } from './session.mjs';
import { bookingUrl } from './config.mjs';

const LOGIN_SIGNALS = /\b(sign in|log in|login|register)\b|登录/i;
const AUCKLAND = 'Pacific/Auckland';

export function classifyLogin({ url = '', bodyText = '', memberName = '' }) {
  const text = String(bodyText || '');
  if (/\/(login|signin|sign-in|auth)\b/i.test(String(url))) return 'signed_out';
  const firstName = String(memberName || '').trim().split(/\s+/)[0];
  if (firstName && text.toLowerCase().includes(firstName.toLowerCase())) return 'signed_in';
  if (LOGIN_SIGNALS.test(text)) return 'signed_out';
  return 'unknown';
}

function aucklandMinutes(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: AUCKLAND, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return parts.hour * 60 + parts.minute;
}

/** Never touch Chrome around the 07:00 opening or while a booking run holds a lock. */
export function probeAllowed({ now = new Date(), runnerActive = false } = {}) {
  if (runnerActive) return false;
  const minutes = aucklandMinutes(now);
  return !(minutes >= 6 * 60 + 40 && minutes <= 7 * 60 + 15);
}

function todayInAuckland(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: AUCKLAND, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export async function probeLogin({ memberName, connect = connectExistingChrome, now = new Date() } = {}) {
  const { browser, context } = await connect();
  const page = await context.newPage();
  try {
    await page.goto(bookingUrl(todayInAuckland(now)), { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForTimeout(3_000);
    const bodyText = await page.evaluate(() => String(document.body?.innerText || '').slice(0, 20_000));
    return classifyLogin({ url: page.url(), bodyText, memberName });
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

export function createLoginCache({ probe = probeLogin, ttlMs = 30 * 60_000, now = () => Date.now() } = {}) {
  let last = { state: 'unknown', checkedAt: null };
  let inFlight = null;
  return {
    async get({ memberName, runnerActive = false, cdpReachable = true } = {}) {
      if (!cdpReachable) return { state: 'unknown', checkedAt: last.checkedAt, reason: 'chrome_unreachable' };
      const fresh = last.checkedAt !== null && now() - last.checkedAt < ttlMs;
      if (fresh || !probeAllowed({ now: new Date(now()), runnerActive })) return last;
      if (!inFlight) {
        inFlight = (async () => {
          try {
            last = { state: await probe({ memberName }), checkedAt: now() };
          } catch {
            last = { state: 'unknown', checkedAt: now() };
          } finally {
            inFlight = null;
          }
          return last;
        })();
      }
      return inFlight;
    },
  };
}
