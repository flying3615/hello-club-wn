import { chromium } from 'playwright';
import { isBookingContentReady, likelyAuthenticated } from './session.mjs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const pages = browser.contexts().flatMap((context) => context.pages());
const result = [];
for (const page of pages) {
  const rawUrl = page.url();
  let safeUrl = rawUrl;
  try {
    const parsed = new URL(rawUrl);
    safeUrl = `${parsed.origin}${parsed.pathname}`;
  } catch {
    // Keep an opaque/non-HTTP URL unchanged.
  }
  const bodyText = await page.locator('body').innerText().catch(() => '');
  result.push({
    url: safeUrl,
    title: await page.title().catch(() => ''),
    bookingContentReady: isBookingContentReady(bodyText),
    likelyAuthenticated: likelyAuthenticated({ title: await page.title().catch(() => ''), bodyText }),
    bodyTextLength: bodyText.length,
  });
}
console.log(JSON.stringify({ pages: result }, null, 2));
process.exit(0);
