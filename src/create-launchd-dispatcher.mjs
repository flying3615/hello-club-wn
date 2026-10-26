import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { buildPersistentDispatcherPlist } from './launchd-plist.mjs';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) args[argv[index].slice(2)] = argv[index + 1];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const label = args.label || 'com.hermes.hello-club.dispatcher';
  const projectDir = path.resolve(new URL('..', import.meta.url).pathname);
  const jobPath = path.join(projectDir, 'state', 'jobs', 'active.json');
  const output = args.output || path.join(process.env.HOME, 'Library', 'LaunchAgents', `${label}.plist`);
  if (!path.isAbsolute(output)) throw new Error('--output must be absolute');
  await fs.mkdir(path.dirname(jobPath), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(projectDir, 'state', 'launchd', 'logs'), { recursive: true, mode: 0o700 });
  const plist = buildPersistentDispatcherPlist({
    label,
    nodePath: process.execPath,
    projectDir,
    jobPath,
  });
  await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await fs.writeFile(output, plist, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(output, 0o600);
  console.log(JSON.stringify({ status: 'dispatcher_plist_created', label, jobPath, output }));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
