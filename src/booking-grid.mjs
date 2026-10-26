const SLOT_MINUTES = 30;
const SLOTS_PER_DAY = 24 * 60 / SLOT_MINUTES;

function formatTime(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function parseGridSnapshot(columns) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('Booking grid returned no court columns.');
  }
  return columns.map((column) => {
    if (!column?.court || !Array.isArray(column.slots) || column.slots.length !== SLOTS_PER_DAY) {
      throw new Error(`Invalid grid column for ${column?.court || 'unknown court'}.`);
    }
    return {
      court: column.court,
      slots: column.slots.map((slot, index) => {
        const startMinutes = index * SLOT_MINUTES;
        const className = String(slot.className || '');
        return {
          start: formatTime(startMinutes),
          end: formatTime(startMinutes + SLOT_MINUTES),
          available: /\bavailable\b/.test(className) && !/\bdisabled\b/.test(className),
          peak: /\bpeak\b/.test(className),
          text: String(slot.text || '').trim(),
        };
      }),
    };
  });
}

export async function scanBookingGrid(root) {
  const snapshot = await root.evaluate((rootElement) => {
    const scope = rootElement || document;
    const columns = [...scope.querySelectorAll('.BookingGrid-column')];
    const courtNames = [...new Set(
      columns
        .map((column) => column.querySelector('.BookingGridArea-name')?.textContent?.trim() || '')
        .filter((name) => /^Court [1-6]$/.test(name)),
    )].slice(0, 6);
    const bodyColumns = columns.filter((column) => column.querySelectorAll('booking-grid-slot').length === 48);
    return bodyColumns.slice(0, 6).map((column, index) => ({
      court: courtNames[index] || `Court ${index + 1}`,
      slots: [...column.querySelectorAll('booking-grid-slot')].map((slot) => ({
        text: slot.innerText || '',
        className: slot.className || '',
      })),
    }));
  });
  return parseGridSnapshot(snapshot);
}

export { SLOT_MINUTES, SLOTS_PER_DAY };
