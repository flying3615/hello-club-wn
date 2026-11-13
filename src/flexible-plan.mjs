// Flexible weekend planning: which court(s) and times to book from one scanned grid.
//
// Preference order (job window is e.g. 08:00–10:00, target = its length):
//   1. Plans starting at the window start: longest total (capped at the target), then
//      fewer bookings (one court beats a court switch), then court priority.
//      This covers "one court for the whole window", "two courts covering the whole
//      window", and "longest continuous time from 08:00, even if short".
//   2. Only if no court is free at the window start: plans starting later, longest total
//      (capped at the target), then fewer bookings, then earliest start, then court priority.
// A plan has at most `maxSegments` contiguous bookings and never crosses `latestEnd`
// (the peak boundary).

const SLOT_MINUTES = 30;

export function toMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) throw new Error(`Invalid 24-hour time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatMinutes(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function availabilityIndex(grid) {
  const byCourt = new Map();
  for (const column of grid || []) {
    if (!column?.court || !Array.isArray(column.slots)) continue;
    const free = new Set(column.slots.filter((slot) => slot?.available === true).map((slot) => toMinutes(slot.start)));
    byCourt.set(column.court, free);
  }
  return byCourt;
}

/** Number of consecutive free slots on `court` starting at `startMinutes`, up to `limitMinutes`. */
function freeRunSlots(byCourt, court, startMinutes, limitMinutes) {
  const free = byCourt.get(court);
  if (!free) return 0;
  let count = 0;
  for (let cursor = startMinutes; cursor + SLOT_MINUTES <= limitMinutes && free.has(cursor); cursor += SLOT_MINUTES) count += 1;
  return count;
}

function segment(court, startMinutes, slots) {
  return { court, start: formatMinutes(startMinutes), end: formatMinutes(startMinutes + slots * SLOT_MINUTES) };
}

function candidatePlans(byCourt, { startMinutes, targetSlots, maxSegments, latestEnd, courtOrder }) {
  const plans = [];
  for (const first of courtOrder) {
    const firstMax = Math.min(targetSlots, freeRunSlots(byCourt, first, startMinutes, latestEnd));
    for (let firstSlots = firstMax; firstSlots >= 1; firstSlots -= 1) {
      plans.push([segment(first, startMinutes, firstSlots)]);
      if (maxSegments < 2 || firstSlots >= targetSlots) continue;
      const secondStart = startMinutes + firstSlots * SLOT_MINUTES;
      for (const second of courtOrder) {
        if (second === first) continue;
        const secondSlots = Math.min(targetSlots - firstSlots, freeRunSlots(byCourt, second, secondStart, latestEnd));
        if (secondSlots >= 1) plans.push([segment(first, startMinutes, firstSlots), segment(second, secondStart, secondSlots)]);
      }
    }
  }
  return plans;
}

function planMinutes(plan) {
  return plan.reduce((total, item) => total + toMinutes(item.end) - toMinutes(item.start), 0);
}

function priorityKey(plan, courtOrder) {
  return plan.map((item) => courtOrder.indexOf(item.court));
}

function comparePlans(left, right, courtOrder) {
  const byMinutes = planMinutes(right) - planMinutes(left);
  if (byMinutes) return byMinutes;
  const bySegments = left.length - right.length;
  if (bySegments) return bySegments;
  const byStart = toMinutes(left[0].start) - toMinutes(right[0].start);
  if (byStart) return byStart;
  const leftKey = priorityKey(left, courtOrder);
  const rightKey = priorityKey(right, courtOrder);
  for (let index = 0; index < Math.max(leftKey.length, rightKey.length); index += 1) {
    const diff = (leftKey[index] ?? -1) - (rightKey[index] ?? -1);
    if (diff) return diff;
  }
  // Prefer the longer first booking: the most time is secured by the first submission.
  return (toMinutes(right[0].end) - toMinutes(left[0].end));
}

export function planFlexibleBooking(grid, {
  windowStart,
  windowEnd,
  latestEnd,
  courtOrder,
  maxSegments = 2,
}) {
  const start = toMinutes(windowStart);
  const targetMinutes = toMinutes(windowEnd) - start;
  const limit = toMinutes(latestEnd);
  if (targetMinutes <= 0 || targetMinutes % SLOT_MINUTES) throw new Error('Flexible window must be a positive half-hour range');
  if (toMinutes(windowEnd) > limit) throw new Error('Flexible window must end before the peak boundary');
  const byCourt = availabilityIndex(grid);
  const options = { targetSlots: targetMinutes / SLOT_MINUTES, maxSegments, latestEnd: limit, courtOrder };

  const atStart = candidatePlans(byCourt, { ...options, startMinutes: start });
  if (atStart.length) {
    const [best] = atStart.sort((left, right) => comparePlans(left, right, courtOrder));
    return { tier: planMinutes(best) === targetMinutes ? 'full_window' : 'longest_from_start', segments: best, minutes: planMinutes(best) };
  }
  const later = [];
  for (let cursor = start + SLOT_MINUTES; cursor < limit; cursor += SLOT_MINUTES) {
    later.push(...candidatePlans(byCourt, { ...options, startMinutes: cursor }));
  }
  if (!later.length) return null;
  const [best] = later.sort((left, right) => comparePlans(left, right, courtOrder));
  return { tier: 'later_start', segments: best, minutes: planMinutes(best) };
}

/** Best single booking that continues exactly at `from`, up to `remainingMinutes`. */
export function planContinuation(grid, { from, remainingMinutes, latestEnd, courtOrder }) {
  if (remainingMinutes < SLOT_MINUTES) return null;
  const byCourt = availabilityIndex(grid);
  const start = toMinutes(from);
  const plans = candidatePlans(byCourt, {
    startMinutes: start, targetSlots: Math.floor(remainingMinutes / SLOT_MINUTES), maxSegments: 1, latestEnd: toMinutes(latestEnd), courtOrder,
  });
  if (!plans.length) return null;
  return plans.sort((left, right) => comparePlans(left, right, courtOrder))[0][0];
}

/** Marks slots as unavailable (e.g. slots that repeatedly failed to open a booking dialog). */
export function maskGrid(grid, blocked) {
  if (!blocked?.length) return grid;
  return grid.map((column) => ({
    ...column,
    slots: column.slots.map((slot) => {
      const minutes = toMinutes(slot.start);
      const hit = blocked.some((item) => item.court === column.court
        && minutes >= toMinutes(item.start) && minutes < toMinutes(item.end));
      return hit ? { ...slot, available: false } : slot;
    }),
  }));
}

export function segmentsOverlap(left, right) {
  return toMinutes(left.start) < toMinutes(right.end) && toMinutes(right.start) < toMinutes(left.end);
}
