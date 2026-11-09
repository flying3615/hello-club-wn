import { buildRecurringJob, mainForTask, runRecurringBooking, targetDateForTask } from './recurring-booking.mjs';
import { getRecurringTask } from './recurring-tasks.mjs';

export const WEEKEND_TASK = getRecurringTask('weekend');

export function targetDateFor(now = new Date()) {
  return targetDateForTask(now, WEEKEND_TASK);
}

export function buildWeekendJob(options = {}) {
  return buildRecurringJob({ task: WEEKEND_TASK, ...options });
}

export async function runWeekendBooking(options = {}) {
  return runRecurringBooking({ taskId: 'weekend', ...options });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mainForTask('weekend');
}

export { WEEKEND_TASK as TASK };
