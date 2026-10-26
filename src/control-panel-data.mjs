import fs from 'node:fs/promises';
import path from 'node:path';

const PUBLIC_JOB_FIELDS = [
  'id', 'date', 'start', 'end', 'openAt', 'prepareAt', 'latestStart',
  'bookingType', 'participants', 'courtOrder', 'paymentPolicy', 'submit',
];

function pick(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(fields.flatMap((field) => (
    Object.hasOwn(value, field) ? [[field, value[field]]] : []
  )));
}

export function safeErrorCode(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || /password|token|cookie|secret|credential|card|cvc|api.?key/i.test(normalized)) {
    return 'redacted_error';
  }
  return normalized.slice(0, 160);
}

export function publicJob(job) {
  const safe = pick(job, PUBLIC_JOB_FIELDS);
  if (!safe?.id || !safe.date || !safe.start || !safe.end) return null;
  return safe;
}

export function publicRun(run) {
  const safe = pick(run, [
    'status', 'mode', 'jobId', 'timestamp', 'startedAt', 'firstGridAt', 'finishedAt', 'attempts', 'selection',
  ]);
  if (!safe?.status || !safe.timestamp) return null;
  if (typeof run.errorCode === 'string') safe.errorCode = safeErrorCode(run.errorCode);
  if (safe.selection && typeof safe.selection === 'object') {
    safe.selection = pick(safe.selection, ['status', 'court', 'checked']);
  }
  return safe;
}

export function publicDispatch(marker) {
  const safe = pick(marker, ['status', 'jobId', 'timestamp', 'exitCode', 'reason']);
  if (!safe?.status || !safe.timestamp) return null;
  if (typeof safe.reason === 'string') safe.reason = safeErrorCode(safe.reason);
  return safe;
}

export function publicBooking(record) {
  const safe = pick(record, [
    'id', 'date', 'start', 'end', 'court', 'bookingType', 'participants', 'paymentStatus', 'verifiedAt', 'source',
  ]);
  const valid = safe && typeof safe.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(safe.date)
    && typeof safe.start === 'string' && typeof safe.end === 'string'
    && /^Court [1-6]$/.test(safe.court)
    && Array.isArray(safe.participants) && safe.participants.length >= 1
    && ['free', 'unpaid_hold', 'paid'].includes(safe.paymentStatus)
    && typeof safe.verifiedAt === 'string';
  return valid ? safe : null;
}

export function parseJsonLines(text, mapper) {
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const mapped = mapper(JSON.parse(line));
      return mapped ? [mapped] : [];
    } catch {
      return [];
    }
  });
}

export async function readJsonLines(directory, mapper, { limit = 50 } = {}) {
  let entries;
  try {
    const metadata = await fs.stat(directory);
    if (metadata.isFile()) {
      const content = await fs.readFile(directory, 'utf8');
      return parseJsonLines(content, mapper)
        .sort((a, b) => String(b.timestamp || b.verifiedAt).localeCompare(String(a.timestamp || a.verifiedAt)))
        .slice(0, limit);
    }
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const values = [];
  for (const file of files) {
    const content = await fs.readFile(path.join(directory, file), 'utf8');
    values.push(...parseJsonLines(content, mapper));
  }
  return values.sort((a, b) => String(b.timestamp || b.verifiedAt).localeCompare(String(a.timestamp || a.verifiedAt))).slice(0, limit);
}

export function presentActivity({ dispatches = [], runs = [] }) {
  return [
    ...dispatches.map((event) => ({ ...event, kind: 'dispatcher' })),
    ...runs.map((event) => ({ ...event, kind: 'runner' })),
  ].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, 24);
}
