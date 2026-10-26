import { readRemoteBookings } from './remote-bookings.mjs';
import {
  classifyPostConfirm, verifyFinalReview, verifyRemoteBookingRecord, verifySelection,
} from './booking-execution.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slotIndex = (value) => {
  const [hour, minute] = value.split(':').map(Number);
  return (hour * 60 + minute) / 30;
};

export function visibleModal(page) {
  return page.locator('.modal-wrapper:visible').last();
}

async function clickExact(locator, label) {
  const buttons = locator.locator('button');
  const indices = await buttons.evaluateAll((nodes, expected) => nodes.flatMap((node, index) => (
    (node.innerText || '').trim().toLowerCase() === expected.toLowerCase() ? [index] : []
  )), label);
  if (indices.length !== 1) throw new Error(`Expected exactly one ${label} button`);
  await buttons.nth(indices[0]).click();
}

function assertVenue(text) {
  if (!String(text || '').includes('Wellington North Badminton Stadium')) {
    throw new Error('Expected venue was not rendered; refusing booking action');
  }
}

async function chooseLinkedMember(modal, name) {
  const selected = await modal.evaluate((root, target) => {
    const norm = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const group = [...root.querySelectorAll('.Group')].find((item) => norm(item.querySelector('.Label')?.textContent) === 'linked members');
    const matches = group ? [...group.querySelectorAll('icon-label')].filter((item) => norm(item.textContent).endsWith(norm(target))) : [];
    if (matches.length !== 1) return false;
    matches[0].click();
    return true;
  }, name);
  if (!selected) throw new Error('Required linked member was not found uniquely');
}

export async function waitForFinalReview(modal) {
  await modal.locator('button').filter({ hasText: 'CONFIRM BOOKING' }).waitFor({ state: 'visible', timeout: 5_000 });
}

export async function revealSlot(slot) {
  await slot.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'center' }));
}

export function remoteBookingMatches(record, job, court) {
  return record?.date === job.date
    && record.start === job.start
    && record.end === job.end
    && record.court === court
    && record.bookingType === job.bookingType
    && Array.isArray(record.participants)
    && record.participants.length === job.participants.length
    && [...record.participants].map((name) => String(name).trim().toLowerCase()).sort()
      .every((participant, index) => participant === [...job.participants].map((name) => name.trim().toLowerCase()).sort()[index]);
}

export function findNewMatchingRemoteBooking(records, job, court, priorBookingIds) {
  return (records || []).find((record) => remoteBookingMatches(record, job, court) && !priorBookingIds.has(record.id)) || null;
}

export async function waitForNewRemoteBooking({
  job,
  court,
  priorBookingIds,
  read = readRemoteBookings,
  attempts = 5,
  delayMs = 2_000,
  sleep = pause,
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const record = findNewMatchingRemoteBooking(await read(), job, court, priorBookingIds);
    if (record) return record;
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error('Remote calendar did not show a newly created exact booking in time');
}

export async function submitBooking({ context, page, job, grid, gridRoot, court }) {
  const scope = gridRoot || page;
  assertVenue(await page.locator('body').innerText());
  const courtIndex = grid.findIndex((column) => column.court === court);
  if (courtIndex < 0) throw new Error(`Selected court ${court} was not found in the verified grid`);
  const priorBookings = await readRemoteBookings();
  if (priorBookings.some((record) => remoteBookingMatches(record, job, court))) {
    throw new Error('Exact booking already exists remotely; refusing a duplicate submission');
  }
  const priorBookingIds = new Set(priorBookings.map((record) => record.id));
  const column = scope.locator('.BookingGrid-column').filter({ hasText: court });
  if (await column.count() !== 1) throw new Error(`Expected one scoped grid column for ${court}`);
  const slots = column.locator('booking-grid-slot');
  const start = slotIndex(job.start);
  const end = slotIndex(job.end) - 1;
  const startSlot = slots.nth(start);
  const endSlot = slots.nth(end);
  await revealSlot(startSlot);
  await startSlot.click();
  await revealSlot(endSlot);
  await endSlot.hover();
  await endSlot.click();
  const modal = visibleModal(page);
  await modal.waitFor({ state: 'visible', timeout: 5_000 });
  verifySelection(await modal.innerText(), job, court);

  await modal.locator('select-box .InputWrapper').click();
  const option = page.locator('.SelectBox-options li').filter({ hasText: job.bookingType });
  if (await option.count() !== 1) throw new Error('Expected exactly one approved booking-type option');
  await option.click();
  if ((await modal.locator('input.Input').inputValue()) !== job.bookingType) throw new Error('Booking-type selection mismatch');
  await clickExact(modal, 'Next');
  await pause(250);

  const members = visibleModal(page);
  await members.waitFor({ state: 'visible', timeout: 5_000 });
  await chooseLinkedMember(members, job.participants[1]);
  const memberText = await members.locator('member-picker').innerText();
  for (const person of job.participants) if (!memberText.includes(person)) throw new Error('Participant selection mismatch');
  await clickExact(members, 'Next');
  await pause(300);

  const review = visibleModal(page);
  await review.waitFor({ state: 'visible', timeout: 5_000 });
  await waitForFinalReview(review);
  verifyFinalReview(await review.innerText(), job, court);
  const agreement = review.locator('check-box').filter({ hasText: 'All players are registered' }).locator('label');
  if (await agreement.count() !== 1) throw new Error('Required player-registration acknowledgement was not found uniquely');
  if (!/\bchecked\b/.test(await agreement.getAttribute('class') || '')) await agreement.click();
  if (!/\bchecked\b/.test(await agreement.getAttribute('class') || '')) throw new Error('Required player-registration acknowledgement was not confirmed');
  await clickExact(review, 'CONFIRM BOOKING');
  await pause(1_000);

  let paymentStatus = classifyPostConfirm(await page.locator('body').innerText());
  if (paymentStatus === 'payment_required') {
    const bodyText = await page.locator('body').innerText();
    const onCalendar = page.url().includes('/bookings/wellington-north-badminton-stadium/');
    if (onCalendar || !/payment/i.test(bodyText)) throw new Error('Payment handoff identity is ambiguous; refusing to click CANCEL');
    const cancel = page.getByRole('button', { name: 'CANCEL', exact: true });
    if (await cancel.count() !== 1) throw new Error('Payment page did not expose exactly one CANCEL action');
    await cancel.click();
    await pause(1_000);
    paymentStatus = 'unpaid_hold';
  }
  if (paymentStatus === 'unknown') throw new Error('Post-confirmation state is unknown; refusing to infer booking success');

  const remoteBooking = await waitForNewRemoteBooking({ job, court, priorBookingIds });
  verifyRemoteBookingRecord(remoteBooking, job, court, paymentStatus);
  return { court, paymentStatus };
}
