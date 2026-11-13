export const RECURRING_TASKS = {
  monday: {
    id: 'monday',
    label: '周一',
    weekdays: ['Monday'],
    start: '15:30',
    end: '17:00',
    runTime: { hour: 6, minute: 57 },
    launchdLabel: 'com.hermes.hello-club.monday',
    script: 'src/monday-booking.mjs',
  },
  weekend: {
    id: 'weekend',
    label: '周末',
    weekdays: ['Saturday', 'Sunday'],
    start: '08:00',
    end: '10:00',
    // Any court(s): one court 08:00–10:00, else two courts covering it, else the longest
    // time from 08:00, else the longest (up to 2h) later start before the 13:00 peak.
    flexible: true,
    runTime: { hour: 6, minute: 57 },
    launchdLabel: 'com.hermes.hello-club.weekend',
    script: 'src/weekend-booking.mjs',
  },
};

export function getRecurringTask(id) {
  const task = RECURRING_TASKS[id];
  if (!task) throw new Error(`Unknown recurring task: ${id}`);
  return task;
}
