import path from 'node:path';

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function plistArray(values) {
  return `<array>${values.map((value) => `<string>${escapeXml(value)}</string>`).join('')}</array>`;
}

export function buildPersistentDispatcherPlist({ label, nodePath, projectDir, jobPath }) {
  if (!/^com\.[a-z0-9.-]+$/.test(label || '')) throw new Error('label must be a reverse-DNS identifier');
  for (const [name, value] of Object.entries({ nodePath, projectDir, jobPath })) {
    if (!path.isAbsolute(value || '')) throw new Error(`${name} must be an absolute path`);
  }
  const logDirectory = path.join(projectDir, 'state', 'launchd', 'logs');
  const args = [nodePath, path.join(projectDir, 'src', 'launchd-dispatcher.mjs'), '--job', jobPath];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>${plistArray(args)}
  <key>WorkingDirectory</key><string>${escapeXml(projectDir)}</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Background</string>
  <key>StartInterval</key><integer>900</integer>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>55</integer></dict>
  <key>KeepAlive</key><false/>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StandardOutPath</key><string>${escapeXml(path.join(logDirectory, `${label}.out.log`))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(logDirectory, `${label}.err.log`))}</string>
</dict></plist>
`;
}

const LAUNCHD_WEEKDAY = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6,
};

/**
 * Weekly recurring booking agent. The run is wrapped in caffeinate so the Mac cannot
 * idle-sleep (and Chrome cannot be backgrounded by display sleep) between the 06:56
 * wake, the 06:57 start and the 07:00 opening.
 */
export function buildRecurringTaskPlist({ task, nodePath, projectDir, caffeinateSeconds = 1_200 }) {
  if (!/^com\.[a-z0-9.-]+$/.test(task?.launchdLabel || '')) throw new Error('task.launchdLabel must be a reverse-DNS identifier');
  for (const [name, value] of Object.entries({ nodePath, projectDir })) {
    if (!path.isAbsolute(value || '')) throw new Error(`${name} must be an absolute path`);
  }
  if (!Array.isArray(task.weekdays) || task.weekdays.length === 0) throw new Error('task.weekdays must not be empty');
  const { hour, minute } = task.runTime || {};
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) throw new Error('task.runTime must have integer hour and minute');
  const intervals = task.weekdays.map((weekday) => {
    if (!(weekday in LAUNCHD_WEEKDAY)) throw new Error(`Unsupported weekday: ${weekday}`);
    return `<dict><key>Weekday</key><integer>${LAUNCHD_WEEKDAY[weekday]}</integer><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`;
  });
  const logDirectory = path.join(projectDir, 'state', 'launchd', 'logs');
  const args = [
    '/usr/bin/caffeinate', '-dimsu', '-t', String(caffeinateSeconds),
    nodePath, path.join(projectDir, task.script),
  ];
  const label = task.launchdLabel;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>${plistArray(args)}
  <key>WorkingDirectory</key><string>${escapeXml(projectDir)}</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key><false/>
  <key>StartCalendarInterval</key><array>
    ${intervals.join('\n    ')}
  </array>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StandardOutPath</key><string>${escapeXml(path.join(logDirectory, `${label}.out.log`))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(logDirectory, `${label}.err.log`))}</string>
</dict></plist>
`;
}
