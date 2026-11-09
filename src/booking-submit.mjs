import { writeIntentFence, clearIntentFence } from './intent-fence.mjs';
import { remoteRecordMatchesIntent } from './booking-intent.mjs';
import { readRemoteBookings } from './remote-bookings.mjs';
import { assertPeakBoundary } from './peak-time.mjs';
import {
  classifyPostConfirm, verifyExactParticipantSet, verifyFinalReview, verifyPaymentPage, verifyRemoteBookingRecord, verifySelection,
} from './booking-execution.mjs';

const SLOTS_PER_COURT = 48;
const SLOT_ACTIONABILITY_TIMEOUT_MS = 2_000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SlotActionabilityError extends Error {
  constructor(court, cause) {
    super(`Rendered slot is not safely actionable for ${court}`);
    this.name = 'SlotActionabilityError';
    this.code = 'slot_not_actionable';
    this.court = court;
    this.cause = cause;
  }
}

export { remoteRecordMatchesIntent };

export function slotRangeIndices(startTime, endTime) {
  const boundaryIndex = (value) => {
    if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) {
      throw new Error('Booking times must use half-hour boundaries');
    }
    const [hour, minute] = value.split(':').map(Number);
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute !== 0 && minute !== 30 || hour < 0 || hour > 24 || hour === 24 && minute !== 0) {
      throw new Error('Booking times must use half-hour boundaries');
    }
    return hour * 2 + minute / 30;
  };
  const startIndex = boundaryIndex(startTime);
  const endIndex = boundaryIndex(endTime) - 1;
  if (startIndex < 0 || startIndex >= SLOTS_PER_COURT || endIndex < 0 || endIndex >= SLOTS_PER_COURT || startIndex > endIndex) {
    throw new Error('Booking times must form a valid positive range');
  }
  return { startIndex, endIndex };
}

function courtIndexForVerifiedGrid(grid, court) {
  if (!Array.isArray(grid) || grid.length !== 6 || grid.some((column) => (
    !Array.isArray(column?.slots)
    || column.slots.length !== SLOTS_PER_COURT
    || !Array.from({ length: SLOTS_PER_COURT }, (_, index) => (
      Object.hasOwn(column.slots, index)
      && column.slots[index] !== null
      && typeof column.slots[index] === 'object'
    )).every(Boolean)
  ))) {
    throw new Error('Verified grid must contain exactly six complete courts');
  }
  const courts = grid.map((column) => column.court);
  const expectedCourts = ['Court 1', 'Court 2', 'Court 3', 'Court 4', 'Court 5', 'Court 6'];
  if (courts.some((name, index) => name !== expectedCourts[index])) {
    throw new Error('Verified grid must contain exactly one entry for each ordered Court 1 through Court 6');
  }
  const courtIndex = expectedCourts.indexOf(court);
  if (courtIndex < 0) throw new Error(`Selected court ${court} was not found in the verified grid`);
  return courtIndex;
}

export function preflightBookingSubmission({ grid, court, start, end }) {
  return { courtIndex: courtIndexForVerifiedGrid(grid, court), ...slotRangeIndices(start, end) };
}

export function bodyColumnIndexForCourt(grid, court, columns) {
  const courtIndex = courtIndexForVerifiedGrid(grid, court);
  if (!Array.isArray(columns)) throw new Error('Expected rendered grid column metadata');
  const expectedCourts = ['Court 1', 'Court 2', 'Court 3', 'Court 4', 'Court 5', 'Court 6'];
  const headerColumns = expectedCourts.map((name) => ({
    name,
    matches: columns.flatMap((column, index) => column?.court === name ? [{ ...column, index }] : []),
  }));
  if (headerColumns.some(({ matches }) => matches.length !== 1)) {
    throw new Error('Expected exactly one rendered header for every court');
  }
  const headerGridIndices = new Set(headerColumns.map(({ matches }) => matches[0].parentGridIndex));
  const bodyColumns = columns.flatMap((column, index) => column?.slotCount === SLOTS_PER_COURT ? [{ ...column, index }] : []);
  const bodyGridIndices = new Set(bodyColumns.map((column) => column.parentGridIndex));
  const bodyParentIndex = bodyGridIndices.size === 1 ? [...bodyGridIndices][0] : null;
  const bodyParentColumns = bodyParentIndex === null ? [] : columns.filter((column) => column?.parentGridIndex === bodyParentIndex);
  if (
    headerGridIndices.size !== 1
    || bodyColumns.length !== 6
    || bodyGridIndices.size !== 1
    || bodyParentColumns.length !== 6
    || bodyParentColumns.some((column) => column?.slotCount !== SLOTS_PER_COURT)
    || [...headerGridIndices][0] === bodyParentIndex
  ) {
    throw new Error('Expected exactly six complete body grid columns');
  }
  const alignedBodyIndices = headerColumns.map(({ matches: [header] }) => {
    const matches = bodyColumns.filter((body) => Math.abs(body.x - header.x) < 1 && Math.abs(body.width - header.width) < 1);
    if (matches.length !== 1) throw new Error('Court header and body column geometry is not uniquely aligned');
    return matches[0].index;
  });
  if (new Set(alignedBodyIndices).size !== 6) throw new Error('Court header and body column geometry is ambiguous');
  return alignedBodyIndices[courtIndex];
}

export async function renderedBookingSlots(scope, grid, court, startTime, endTime) {
  const { startIndex, endIndex } = slotRangeIndices(startTime, endTime);
  const columns = scope.locator('.BookingGrid-column');
  const columnMetadata = await columns.evaluateAll((nodes) => {
    const parents = [...new Set(nodes.map((node) => node.parentElement))];
    return nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        court: node.querySelector('.BookingGridArea-name')?.textContent?.trim() || null,
        slotCount: node.querySelectorAll('booking-grid-slot').length,
        parentGridIndex: parents.indexOf(node.parentElement),
        x: rect.x,
        width: rect.width,
      };
    });
  });
  const bodyColumnIndex = bodyColumnIndexForCourt(grid, court, columnMetadata);
  const slots = columns.nth(bodyColumnIndex).locator('booking-grid-slot');
  if (await slots.count() !== SLOTS_PER_COURT) throw new Error(`Selected court ${court} did not expose a complete slot column`);
  return {
    startSlot: slots.nth(startIndex),
    endSlot: slots.nth(endIndex),
  };
}

export async function assertSlotsActionable({ startSlot, endSlot, court }) {
  for (const slot of [startSlot, endSlot]) {
    try {
      await revealSlot(slot);
      await slot.hover({ trial: true, timeout: SLOT_ACTIONABILITY_TIMEOUT_MS });
    } catch (error) {
      throw new SlotActionabilityError(court, error);
    }
  }
}

export async function preflightRenderedBookingSlots({ scope, grid, court, start, end }) {
  const slots = await renderedBookingSlots(scope, grid, court, start, end);
  await assertSlotsActionable({ ...slots, court });
  return slots;
}

export function visibleModal(page) {
  return page.locator('.modal-wrapper:visible').last();
}

export async function waitForPostConfirmState(page, { attempts = 20, delayMs = 250, sleep = pause } = {}) {
  let classification = 'unknown';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    classification = classifyPostConfirm(await page.locator('body').innerText());
    if (classification !== 'unknown') return classification;
    if (attempt < attempts) await sleep(delayMs);
  }
  return classification;
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
    const matches = group ? [...group.querySelectorAll('icon-label')].filter((item) => (
      norm(item.querySelector('.IconLabel-text')?.textContent) === norm(target)
    )) : [];
    if (matches.length !== 1) return false;
    matches[0].click();
    return true;
  }, name);
  if (!selected) throw new Error('Required linked member was not found uniquely');
}

export function normalizeMemberNames(rows) {
  if (!Array.isArray(rows)) throw new Error('Member list did not expose structured participant rows');
  const names = rows.map((row) => String(row || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (names.length === 0) throw new Error('Member list did not expose any selected participants');
  return names;
}

export async function readSelectedMemberNames(modal) {
  const pickers = modal.locator('member-picker');
  if (await pickers.count() !== 1) throw new Error('Expected exactly one member picker');
  const rows = await pickers.evaluate((root) => [...root.querySelectorAll('.MemberPicker > .Input .IconLabel-text')]
    .map((node) => {
      const clone = node.cloneNode(true);
      clone.querySelectorAll('a, .Icon').forEach((child) => child.remove());
      return (clone.textContent || '').replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean));
  return normalizeMemberNames(rows);
}

export async function readFinalReviewMemberNames(modal) {
  const containers = modal.locator('.BookingView-members');
  if (await containers.count() !== 1) throw new Error('Final review does not expose exactly one structured member list');
  const rows = await containers.evaluate((root) => [...root.querySelectorAll(':scope > .AvatarMember')]
    .map((row) => {
      const clone = row.cloneNode(true);
      clone.querySelectorAll('avatar, .AvatarWrapper, .Icon').forEach((child) => child.remove());
      return (clone.textContent || '').replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean));
  return normalizeMemberNames(rows);
}


export async function waitForFinalReview(modal) {
  await modal.locator('button').filter({ hasText: 'CONFIRM BOOKING' }).waitFor({ state: 'visible', timeout: 5_000 });
}

export async function revealSlot(slot) {
  await slot.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'center' }));
}

export async function selectRenderedSlotRange({ startSlot, endSlot, assertDeadline = () => {} }) {
  assertDeadline();
  await revealSlot(startSlot);
  assertDeadline();
  await startSlot.click();
  assertDeadline();
  await revealSlot(endSlot);
  assertDeadline();
  await endSlot.hover();
  assertDeadline();
  await endSlot.click();
  assertDeadline();
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

export function findNewMatchingRemoteBooking(records, job, court, priorBookingIds, bookingId = null) {
  return (records || []).find((record) => remoteBookingMatches(record, job, court)
    && !priorBookingIds.has(record.id)
    && (bookingId === null || record.id === bookingId)) || null;
}

export async function waitForNewRemoteBooking({
  job,
  court,
  priorBookingIds,
  bookingId = null,
  read = readRemoteBookings,
  attempts = 5,
  delayMs = 2_000,
  sleep = pause,
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const record = findNewMatchingRemoteBooking(await read(), job, court, priorBookingIds, bookingId);
    if (record) return record;
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error('Remote calendar did not show a newly created exact booking in time');
}

export async function submitBooking({
  context,
  page,
  job,
  grid,
  gridRoot,
  court,
  read = readRemoteBookings,
  writeFence = writeIntentFence,
  clearFence = clearIntentFence,
  assertDeadline = () => {},
}) {
  const scope = gridRoot || page;
  assertDeadline();
  assertPeakBoundary({ date: job.date, start: job.start, end: job.end });
  assertVenue(await page.locator('body').innerText());
  preflightBookingSubmission({ grid, court, start: job.start, end: job.end });
  const { startSlot, endSlot } = await preflightRenderedBookingSlots({
    scope, grid, court, start: job.start, end: job.end,
  });
  const priorBookings = await read();
  if (priorBookings.some((record) => remoteRecordMatchesIntent(record, job))) {
    throw new Error('Equivalent booking intent already exists remotely; refusing a duplicate submission');
  }
  const priorBookingIds = new Set(priorBookings.map((record) => record.id));
  await writeFence({ job, phase: 'selection_unknown', priorBookingIds: [...priorBookingIds], selectedCourt: court });
  assertDeadline();
  await selectRenderedSlotRange({ startSlot, endSlot, assertDeadline });
  const modal = visibleModal(page);
  await modal.waitFor({ state: 'visible', timeout: 5_000 });
  verifySelection(await modal.innerText(), job, court);

  await modal.locator('select-box .InputWrapper').click();
  const option = page.locator('.SelectBox-options li').filter({ hasText: job.bookingType });
  if (await option.count() !== 1) throw new Error('Expected exactly one approved booking-type option');
  await option.click();
  if ((await modal.locator('input.Input').inputValue()) !== job.bookingType) throw new Error('Booking-type selection mismatch');
  assertDeadline();
  await clickExact(modal, 'Next');
  await pause(250);

  const members = visibleModal(page);
  await members.waitFor({ state: 'visible', timeout: 5_000 });
  await chooseLinkedMember(members, job.participants[1]);
  verifyExactParticipantSet(await readSelectedMemberNames(members), job.participants);
  assertDeadline();
  await clickExact(members, 'Next');
  await pause(300);

  const review = visibleModal(page);
  await review.waitFor({ state: 'visible', timeout: 5_000 });
  await waitForFinalReview(review);
  verifyExactParticipantSet(await readFinalReviewMemberNames(review), job.participants);
  verifyFinalReview(await review.innerText(), job, court);
  const agreement = review.locator('check-box').filter({ hasText: 'All players are registered' }).locator('label');
  if (await agreement.count() !== 1) throw new Error('Required player-registration acknowledgement was not found uniquely');
  if (!/\bchecked\b/.test(await agreement.getAttribute('class') || '')) await agreement.click();
  if (!/\bchecked\b/.test(await agreement.getAttribute('class') || '')) throw new Error('Required player-registration acknowledgement was not confirmed');
  await writeFence({ job, phase: 'confirmation_unknown', priorBookingIds: [...priorBookingIds], selectedCourt: court });
  assertDeadline();
  await clickExact(review, 'CONFIRM BOOKING');
  await pause(1_000);

  let paymentStatus = await waitForPostConfirmState(page);
  let remoteBookingId = null;
  if (paymentStatus === 'payment_required') {
    const payment = verifyPaymentPage({
      url: page.url(),
      text: await page.locator('body').innerText(),
      job,
      court,
    });
    const paymentRoot = page.locator('.Page').filter({ hasText: 'Pay for booking' });
    if (await paymentRoot.count() !== 1) throw new Error('Payment page did not expose exactly one page root');
    assertDeadline();
    await clickExact(paymentRoot, 'Cancel');
    await page.waitForURL((url) => !/^\/account\/booking\//.test(url.pathname), { timeout: 5_000 }).catch(() => {
      throw new Error('Payment page did not leave the account payment route after CANCEL');
    });
    remoteBookingId = payment.bookingId;
    paymentStatus = 'unpaid_hold';
  }
  if (paymentStatus === 'unknown') throw new Error('Post-confirmation state is unknown; refusing to infer booking success');

  const remoteBooking = await waitForNewRemoteBooking({ job, court, priorBookingIds, read, bookingId: remoteBookingId });
  verifyRemoteBookingRecord(remoteBooking, job, court, paymentStatus, remoteBookingId);
  await clearFence({ job });
  return { court, paymentStatus };
}
