import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes('/bookings/wellington-north-badminton-stadium/'));
if (!page) throw new Error('Booking page not found');
const result = await page.evaluate(() => [...document.querySelectorAll('.BookingGrid-column')].map((column) => ({
  name: column.querySelector('.BookingGridArea-name')?.textContent?.trim() || '',
  slots: [...column.querySelectorAll('booking-grid-slot')].map((slot, index) => ({
    index,
    text: (slot.innerText || '').trim().replace(/\\s+/g, ' '),
    className: slot.className,
  })),
})));
console.log(JSON.stringify(result, null, 2));
process.exit(0);
