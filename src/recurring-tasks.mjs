export const RECURRING_TASKS = {
  monday: {
    id: 'monday',
    label: '周一',
    weekdays: ['Monday'],
    start: '15:30',
    end: '17:00',
    runTime: { hour: 6, minute: 54 },
    launchdLabel: 'com.hermes.hello-club.monday',
    script: 'src/monday-booking.mjs',
  },
  weekend: {
    id: 'weekend',
    label: '周末',
    weekdays: ['Saturday', 'Sunday'],
    start: '08:00',
    end: '09:30',
    runTime: { hour: 6, minute: 54 },
    launchdLabel: 'com.hermes.hello-club.weekend',
    script: 'src/weekend-booking.mjs',
  },
};

export function getRecurringTask(id) {
  const task = RECURRING_TASKS[id];
  if (!task) throw new Error(`Unknown recurring task: ${id}`);
  return task;
}
