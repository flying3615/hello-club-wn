const AUCKLAND_ZONE = 'Pacific/Auckland';
const RUN_TIME = { hour: 6, minute: 54 };

function localParts(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: AUCKLAND_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'long',
  }).formatToParts(value);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function localInstant(date, { hour, minute }) {
  const desiredUtc = Date.parse(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  let candidate = desiredUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = localParts(new Date(candidate));
    const observedUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    const adjustment = desiredUtc - observedUtc;
    if (adjustment === 0) return candidate;
    candidate += adjustment;
  }
  throw new Error(`Could not resolve ${date} ${hour}:${minute} in ${AUCKLAND_ZONE}`);
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function nextRecurringRun(now, task) {
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error('A valid current time is required');
  if (!Array.isArray(task?.weekdays) || task.weekdays.length === 0) throw new Error('A recurring task needs at least one weekday');
  const today = localParts(now);
  const runTime = task.runTime || RUN_TIME;
  const localTime = `${String(runTime.hour).padStart(2, '0')}:${String(runTime.minute).padStart(2, '0')}`;
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = addDays(`${today.year}-${today.month}-${today.day}`, offset);
    const weekday = new Intl.DateTimeFormat('en-NZ', { timeZone: AUCKLAND_ZONE, weekday: 'long' })
      .format(new Date(`${date}T00:00:00Z`));
    if (!task.weekdays.includes(weekday)) continue;
    const at = localInstant(date, runTime);
    if (at <= now.getTime()) continue;
    return {
      at: new Date(at).toISOString(),
      local: `${date} ${localTime}`,
      date,
      weekday,
      targetDate: addDays(date, 7),
    };
  }
  throw new Error(`Could not determine the next ${task.id || 'recurring'} run`);
}

export function nextWeekendRun(now = new Date()) {
  return nextRecurringRun(now, { id: 'weekend', weekdays: ['Saturday', 'Sunday'], runTime: RUN_TIME });
}

export { AUCKLAND_ZONE, RUN_TIME };
