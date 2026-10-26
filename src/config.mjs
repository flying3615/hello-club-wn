import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_DIR = path.resolve(here, '..');
export const STATE_DIR = path.join(PROJECT_DIR, 'state');
export const USER_DATA_DIR = path.join(STATE_DIR, 'browser-profile');
export const DEFAULT_BASE_URL = 'https://bookings.wnba.org.nz/bookings/wellington-north-badminton-stadium';
export const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const DEFAULT_CDP_ENDPOINT = process.env.CHROME_CDP_ENDPOINT || 'http://127.0.0.1:9223';

export function bookingUrl(date, baseUrl = DEFAULT_BASE_URL) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid booking date: ${date}`);
  return `${baseUrl}/${date}`;
}

export function validateJob(job) {
  const required = ['date', 'start', 'end', 'bookingType', 'participants'];
  for (const key of required) {
    if (job[key] === undefined || job[key] === null || job[key] === '') {
      throw new Error(`Missing job field: ${key}`);
    }
  }
  if (!Array.isArray(job.participants) || job.participants.length < 2) {
    throw new Error('At least two named participants are required for Singles.');
  }
  if (typeof job.allowUnpaidHold !== 'boolean') {
    throw new Error('allowUnpaidHold must be explicitly true or false.');
  }
  if (typeof job.submit !== 'boolean') {
    throw new Error('submit must be explicitly true or false.');
  }
  return job;
}
