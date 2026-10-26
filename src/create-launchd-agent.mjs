import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { validateBookingJob } from './launchd-job.mjs';
import { buildLaunchAgentPlist } from './launchd-plist.mjs';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) args[argv[index].slice(2)] = argv[index + 1];
  }
  return args;
}

function usage() {
  console.log('Usage: node src/create-launchd-agent.mjs --job /absolute/job.json --run-at ISO --label com.example.booking [--output /absolute/file.plist]');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.job || !args['run-at'] || !args.label) {
    usage();
    process.exitCode = 2;
    return;
  }
  if (!path.isAbsolute(args.job)) throw new Error('--job must be absolute');
  const runAt = Date.parse(args['run-at']);
  if (!Number.isFinite(runAt) || runAt <= Date.now()) throw new Error('--run-at must be a future ISO timestamp');
  const stat = await fs.stat(args.job);
  if ((stat.mode & 0o077) !== 0) throw new Error('Job file must not be group/world readable');
  const job = validateBookingJob(JSON.parse(await fs.readFile(args.job, 'utf8')), { mode: 'watch' });
  const projectDir = path.resolve(new URL('..', import.meta.url).pathname);
  const output = args.output || path.join(process.env.HOME, 'Library', 'LaunchAgents', `${args.label}.plist`);
  if (!path.isAbsolute(output)) throw new Error('--output must be absolute');
  await fs.mkdir(path.join(projectDir, 'state', 'launchd', 'logs'), { recursive: true, mode: 0o700 });
  const plist = buildLaunchAgentPlist({
    label: args.label,
    nodePath: process.execPath,
    projectDir,
    jobPath: args.job,
    runAt: args['run-at'],
  });
  await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await fs.writeFile(output, plist, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(output, 0o600);
  console.log(JSON.stringify({
    status: 'plist_created', label: args.label, runAt: args['run-at'],
    mode: 'watch', jobId: job.id, output,
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
