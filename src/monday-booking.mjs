import { buildRecurringJob, mainForTask, runRecurringBooking, targetDateForTask } from './recurring-booking.mjs';
import { getRecurringTask } from './recurring-tasks.mjs';

export const MONDAY_TASK = getRecurringTask('monday');

export function targetDateForMonday(now = new Date()) {
  return targetDateForTask(now, MONDAY_TASK);
}

export function buildMondayJob(options = {}) {
  return buildRecurringJob({ task: MONDAY_TASK, ...options });
}

export async function runMondayBooking(options = {}) {
  return runRecurringBooking({ taskId: 'monday', ...options });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mainForTask('monday');
}

export { MONDAY_TASK as TASK };
