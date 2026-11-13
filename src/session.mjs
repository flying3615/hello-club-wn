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

const TARGET_CLOSED = /Target page, context or browser has been closed|Target closed|Target crashed|page crashed|Page closed|has been closed|frame was detached|Execution context was destroyed/i;

export function isTargetClosedError(error) {
  return TARGET_CLOSED.test(String(error?.message || error || ''));
}

export async function connectExistingChrome(endpoint = DEFAULT_CDP_ENDPOINT) {
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context) throw new Error('Connected Chrome has no browser context.');
  return { browser, context };
}

export function isBookingContentReady(bodyText) {
  const text = String(bodyText || '').trim();
  if (!text || /^Loading(?:\.\.\.|…)/.test(text)) return false;
  return /Court\s+[1-6]/i.test(text) && text.length >= 30;
}

export async function isPagePreloading(page) {
  return page.evaluate(() => {
    const text = String(document.body?.innerText || '').trim();
    if (/^Loading(?:\.\.\.|…)/.test(text)) return true;
    const preloader = document.querySelector('#Preloader');
    if (preloader) {
      const style = getComputedStyle(preloader);
      if (style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0) return true;
    }
    const host = document.querySelector('booking-grid');
    const ctrl = host && window.angular ? window.angular.element(host).scope?.()?.$ctrl : null;
    return Boolean(ctrl && Array.isArray(ctrl.loadOps) && ctrl.loadOps.length > 0);
  });
}

export async function waitForBookingGridReady(page, timeout = 30_000) {
  await page.waitForFunction(() => {
    const text = String(document.body?.innerText || '').trim();
    if (/^Loading(?:\.\.\.|…)/.test(text)) return false;
    const preloader = document.querySelector('#Preloader');
    if (preloader) {
      const style = getComputedStyle(preloader);
      if (style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0) return false;
    }
    const grid = [...document.querySelectorAll('.BookingGrid')]
      .find((candidate) => candidate.querySelectorAll('.BookingGrid-column booking-grid-slot').length >= 48 * 6);
    if (!grid) return false;
    const host = grid.closest('booking-grid');
    const ctrl = host && window.angular ? window.angular.element(host).scope?.()?.$ctrl : null;
    if (!ctrl || ctrl.hasLoadedData !== true) return false;
    if (Array.isArray(ctrl.loadOps) && ctrl.loadOps.length > 0) return false;
    return document.querySelectorAll('booking-grid-slot.ng-animate').length === 0;
  }, { timeout });
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

export function isTargetBookingUrl(currentUrl, targetUrl) {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    return current.origin === target.origin && current.pathname === target.pathname;
  } catch {
    return false;
  }
}

export async function openBookingPage(context, date, baseUrl = DEFAULT_BASE_URL) {
  const targetUrl = bookingUrl(date, baseUrl);
  const page = await openRawBookingPage(context, date, baseUrl);
  await waitForBookingGridReady(page);
  if (!isTargetBookingUrl(page.url(), targetUrl)) {
    throw new Error(`Booking page did not open the target date ${date}; it redirected to ${page.url()}`);
  }
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
