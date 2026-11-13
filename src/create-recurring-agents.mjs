import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { buildRecurringTaskPlist } from './launchd-plist.mjs';
import { RECURRING_TASKS } from './recurring-tasks.mjs';

// Writes state/launchd/<task>.plist for every recurring task. Install them with:
//   cp state/launchd/<task>.plist ~/Library/LaunchAgents/<label>.plist
//   launchctl bootout gui/$(id -u)/<label>; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist
async function main() {
  const projectDir = path.resolve(new URL('..', import.meta.url).pathname);
  const directory = path.join(projectDir, 'state', 'launchd');
  await fs.mkdir(path.join(directory, 'logs'), { recursive: true, mode: 0o700 });
  const created = [];
  for (const task of Object.values(RECURRING_TASKS)) {
    const plist = buildRecurringTaskPlist({ task, nodePath: process.execPath, projectDir });
    const output = path.join(directory, `${task.id}.plist`);
    await fs.writeFile(output, plist, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(output, 0o600);
    created.push({ task: task.id, label: task.launchdLabel, output });
  }
  console.log(JSON.stringify({ status: 'recurring_plists_created', created }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
