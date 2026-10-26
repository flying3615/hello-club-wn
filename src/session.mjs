import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  DEFAULT_BASE_URL,
  DEFAULT_CHROME_PATH,
  DEFAULT_CDP_ENDPOINT,
  USER_DATA_DIR,
  bookingUrl,
} from './config.mjs';

export async function launchPersistentSession({ headless = false, executablePath = process.env.CHROME_PATH || DEFAULT_CHROME_PATH } = {}) {
  await fs.mkdir(USER_DATA_DIR, { recursive: true, mode: 0o700 });
  return chromium.launchPersistentContext(USER_DATA_DIR, {
    headless,
    executablePath,
    viewport: null,
    acceptDownloads: false,
  });
}

export async function connectExistingChrome(endpoint = DEFAULT_CDP_ENDPOINT) {
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context) throw new Error('Connected Chrome has no browser context.');
  return { browser, context };
}

export function isBookingContentReady(bodyText) {
  const text = String(bodyText || '').trim();
  if (!text || text === 'Loading...') return false;
  return /Court\s+[1-6]/i.test(text) && text.length >= 30;
}

export async function openRawBookingPage(context, date, baseUrl = DEFAULT_BASE_URL) {
  const targetUrl = bookingUrl(date, baseUrl);
  const page = context.pages().find((candidate) => candidate.url().startsWith(targetUrl))
    || await context.newPage();
  if (!page.url().startsWith(targetUrl)) {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  }
  await page.locator('body').waitFor({ state: 'visible', timeout: 30_000 });
  return page;
}

export async function openBookingPage(context, date, baseUrl = DEFAULT_BASE_URL) {
  const page = await openRawBookingPage(context, date, baseUrl);
  await page.waitForFunction(
    () => {
      const text = document.body?.innerText || '';
      return text.trim() !== 'Loading...' && /Court\s+[1-6]/i.test(text) && text.length >= 30;
    },
    { timeout: 30_000 },
  );
  return page;
}

export async function captureInspection(page) {
  return page.evaluate(() => ({
    title: document.title,
    url: location.href,
    bodyText: document.body.innerText.slice(0, 40_000),
    buttons: [...document.querySelectorAll('button, [role="button"], a')].slice(0, 300).map((node) => ({
      tag: node.tagName,
      role: node.getAttribute('role'),
      text: (node.innerText || node.getAttribute('aria-label') || '').trim().slice(0, 300),
      aria: node.getAttribute('aria-label'),
      cls: typeof node.className === 'string' ? node.className.slice(0, 300) : '',
    })),
  }));
}

export function likelyAuthenticated(inspection) {
  if (!isBookingContentReady(inspection.bodyText)) return false;
  const text = `${inspection.title}\n${inspection.bodyText}`.toLowerCase();
  const loginSignals = ['sign in', 'log in', 'google login', '登录'];
  return !loginSignals.some((signal) => text.includes(signal));
}
