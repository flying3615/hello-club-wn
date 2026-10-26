import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes('/bookings/wellington-north-badminton-stadium/'));
if (!page) throw new Error('Booking page not found');
const result = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('[class*="Slot"], [class*="Booking"], [class*="Grid"]')];
  return nodes.slice(0, 500).map((node) => {
    const rect = node.getBoundingClientRect();
    const attrs = {};
    for (const attr of node.attributes) {
      if (attr.name === 'class' || attr.name === 'style' || attr.name.startsWith('data-') || attr.name === 'href' || attr.name === 'title') {
        attrs[attr.name] = attr.value;
      }
    }
    return {
      tag: node.tagName,
      text: (node.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 160),
      attrs,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    };
  });
});
console.log(JSON.stringify(result, null, 2));
process.exit(0);
