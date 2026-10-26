import { connectExistingChrome } from './session.mjs';

const VENUE = 'Wellington North Badminton Stadium';
const TIME_ZONE = 'Pacific/Auckland';

function localParts(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function localDateTime(value) {
  const parts = localParts(value);
  if (!parts.year || !parts.month || !parts.day || !parts.hour || !parts.minute) return null;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function monthSyncAnchors(now = new Date().toISOString()) {
  const { year, month } = localParts(now);
  const base = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  return [-1, 0, 1, 2].map((offset) => {
    const cursor = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offset, 1));
    return `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}-01`;
  });
}

export function remoteBookingRecord(booking, verifiedAt = new Date().toISOString()) {
  const start = localDateTime(booking?.startDate);
  const end = localDateTime(booking?.endDate);
  const participants = Array.isArray(booking?.profiles)
    ? booking.profiles.map((profile) => String(profile?.name || '').trim()).filter(Boolean)
    : [];
  if (!booking || typeof booking.id !== 'string' || booking.activity?.name !== VENUE || !/^Court [1-6]$/.test(booking.area?.name || '')
    || !String(booking.mode?.name || '').trim() || !start || !end || !participants.length || booking.isRefunded) return null;
  const paymentStatus = booking.isPaid ? 'paid' : booking.hasInAdvancePayableFee ? 'unpaid_hold' : 'free';
  return {
    id: booking.id,
    date: start.date,
    start: start.time,
    end: end.time,
    court: booking.area.name,
    bookingType: booking.mode.name.trim(),
    participants,
    startsAt: booking.startDate,
    paymentStatus,
    verifiedAt,
    source: 'helloclub',
  };
}

export function partitionRemoteBookings(records, now = new Date().toISOString()) {
  const current = Date.parse(now);
  const upcoming = [];
  const past = [];
  for (const record of records || []) {
    const startsAt = Date.parse(record?.startsAt);
    if (!Number.isFinite(startsAt)) continue;
    (startsAt >= current ? upcoming : past).push(record);
  }
  upcoming.sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
  past.sort((left, right) => Date.parse(right.startsAt) - Date.parse(left.startsAt));
  return { upcoming, past };
}

async function calendarMonthBookings(context, anchor) {
  const page = await context.newPage();
  try {
    const payload = await new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Hello Club calendar did not return bookings in time')), 30_000);
      const onResponse = async (response) => {
        if (!response.url().startsWith('https://api-v2.helloclub.com/bookings') || response.request().method() !== 'GET') return;
        page.off('response', onResponse);
        clearTimeout(timeout);
        try { resolve(await response.json()); } catch { reject(new Error('Hello Club booking response was not valid JSON')); }
      };
      page.on('response', onResponse);
      try {
        await page.goto(`https://bookings.wnba.org.nz/calendar/month/all/${anchor}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      } catch (error) {
        page.off('response', onResponse);
        clearTimeout(timeout);
        reject(error);
      }
    });
    if (!Array.isArray(payload?.bookings)) throw new Error('Hello Club booking response did not contain a bookings list');
    return payload.bookings;
  } finally {
    await page.close();
  }
}

export function createRemoteBookingCache({ read, now = () => Date.now(), ttlMs = 300_000 } = {}) {
  if (typeof read !== 'function') throw new Error('Remote booking cache requires a read function');
  let bookings = [];
  let syncedAt = null;
  let inFlight = null;
  return {
    async get() {
      const current = now();
      if (syncedAt !== null && current - syncedAt < ttlMs) return { bookings, syncedAt, state: 'fresh' };
      if (!inFlight) {
        inFlight = (async () => {
          try {
            bookings = await read();
            syncedAt = now();
            return { bookings, syncedAt, state: 'fresh' };
          } catch {
            return { bookings, syncedAt, state: syncedAt === null ? 'unavailable' : 'stale' };
          } finally {
            inFlight = null;
          }
        })();
      }
      return inFlight;
    },
  };
}

export async function readRemoteBookings({ now = new Date().toISOString(), connect = connectExistingChrome } = {}) {
  const { browser, context } = await connect();
  try {
    const verifiedAt = new Date().toISOString();
    const months = monthSyncAnchors(now);
    const records = [];
    for (const anchor of months) {
      const bookings = await calendarMonthBookings(context, anchor);
      records.push(...bookings.map((booking) => remoteBookingRecord(booking, verifiedAt)).filter(Boolean));
    }
    return [...new Map(records.map((record) => [record.id, record])).values()]
      .sort((left, right) => `${right.date} ${right.start}`.localeCompare(`${left.date} ${left.start}`));
  } finally {
    await browser.close();
  }
}
