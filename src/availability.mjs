function timeToMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) throw new Error(`Invalid 24-hour time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function availableRuns(grid) {
  if (!Array.isArray(grid)) throw new Error('Availability grid must be an array');
  return grid.map((column) => {
    if (!column?.court || !Array.isArray(column.slots)) {
      throw new Error('Availability grid column is invalid');
    }
    const runs = [];
    let startIndex = null;
    column.slots.forEach((slot, index) => {
      if (slot?.available && startIndex === null) startIndex = index;
      if ((!slot?.available || index === column.slots.length - 1) && startIndex !== null) {
        const endIndex = slot?.available ? index + 1 : index;
        if (endIndex > startIndex) {
          runs.push({ start: column.slots[startIndex].start, end: column.slots[endIndex - 1].end });
        }
        startIndex = null;
      }
    });
    return { court: column.court, runs };
  });
}

export function nearbyAvailableRuns(grid, { windowStart = '06:00', windowEnd = '12:00' } = {}) {
  const startMinutes = timeToMinutes(windowStart);
  const endMinutes = timeToMinutes(windowEnd);
  if (endMinutes <= startMinutes) throw new Error('Availability window must end after it starts');
  const runs = availableRuns(grid).flatMap(({ court, runs: courtRuns }) => courtRuns
    .map(({ start, end }) => ({ court, start, end }))
    .filter((run) => timeToMinutes(run.end) > startMinutes && timeToMinutes(run.start) < endMinutes));
  runs.sort((left, right) => left.start.localeCompare(right.start) || left.court.localeCompare(right.court));
  return { window: { start: windowStart, end: windowEnd }, runs };
}
