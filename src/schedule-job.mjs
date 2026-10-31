import process from 'node:process';
import { buildRtcWakePlan } from './rtc-wake.mjs';
import { buildScheduledJob, scheduleFutureJob } from './scheduled-job.mjs';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    const key = argument.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      result[key] = true;
    } else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function usage() {
  console.log(`Usage:
  node src/schedule-job.mjs --date YYYY-MM-DD --start HH:MM --end HH:MM \\
    --participants "Name One,Name Two" [--submit true|false] [--courts "Court 4,Court 5,..."] \\
    [--id job-id] [--latest-start ISO_TIMESTAMP] [--dry-run]

The job's openAt, prepareAt (exactly three minutes earlier), and default latestStart
(openAt plus five minutes) are derived from the target date. --dry-run prints the
validated job and RTC wake plan without arming the wake or writing the active job.`);
}

function list(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a comma-separated list`);
  const values = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`${label} must not be empty`);
  return values;
}

function parseSubmit(value) {
  if (value === undefined) return false;
  if (value === true || value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('--submit must be true or false');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!args.date || !args.start || !args.end || !args.participants) {
    usage();
    throw new Error('--date, --start, --end, and --participants are required');
  }
  let latestStartMs;
  if (args['latest-start'] !== undefined) {
    latestStartMs = Date.parse(args['latest-start']);
    if (!Number.isFinite(latestStartMs)) throw new Error('--latest-start must be an ISO timestamp');
  }
  const job = buildScheduledJob({
    date: args.date,
    start: args.start,
    end: args.end,
    participants: list(args.participants, '--participants'),
    courtOrder: args.courts === undefined ? undefined : list(args.courts, '--courts'),
    submit: parseSubmit(args.submit),
    id: args.id,
    latestStartMs,
  });
  if (args['dry-run']) {
    console.log(JSON.stringify({ status: 'dry_run', job, wake: buildRtcWakePlan(job) }, null, 2));
    return;
  }
  const result = await scheduleFutureJob({ job });
  console.log(JSON.stringify(result));
}

main().catch((error) => {
  console.error(String(error.message || error));
  process.exitCode = 1;
});
