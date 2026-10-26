import path from 'node:path';

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function calendarFields(runAt) {
  const date = new Date(runAt);
  if (!Number.isFinite(date.getTime())) throw new Error('runAt must be an ISO timestamp');
  return {
    Year: date.getFullYear(),
    Month: date.getMonth() + 1,
    Day: date.getDate(),
    Hour: date.getHours(),
    Minute: date.getMinutes(),
  };
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
  <key>KeepAlive</key><false/>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StandardOutPath</key><string>${escapeXml(path.join(logDirectory, `${label}.out.log`))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(logDirectory, `${label}.err.log`))}</string>
</dict></plist>
`;
}

export function buildLaunchAgentPlist({ label, nodePath, projectDir, jobPath, runAt, cdpEndpoint = 'http://127.0.0.1:9223' }) {
  if (!/^com\.[a-z0-9.-]+$/.test(label || '')) throw new Error('label must be a reverse-DNS identifier');
  for (const [name, value] of Object.entries({ nodePath, projectDir, jobPath })) {
    if (!path.isAbsolute(value || '')) throw new Error(`${name} must be an absolute path`);
  }
  const fields = calendarFields(runAt);
  const logDirectory = path.join(projectDir, 'state', 'launchd', 'logs');
  const args = [
    '/usr/bin/caffeinate', '-dimsu', '-t', '600', nodePath,
    path.join(projectDir, 'src', 'launchd-runner.mjs'),
    '--job', jobPath, '--mode', 'watch', '--cdp-endpoint', cdpEndpoint,
  ];
  const calendar = Object.entries(fields).map(([key, value]) => `<key>${key}</key><integer>${value}</integer>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>${plistArray(args)}
  <key>WorkingDirectory</key><string>${escapeXml(projectDir)}</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Background</string>
  <key>StartCalendarInterval</key><dict>${calendar}</dict>
  <key>KeepAlive</key><false/>
  <key>RunAtLoad</key><false/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StandardOutPath</key><string>${escapeXml(path.join(logDirectory, `${label}.out.log`))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(logDirectory, `${label}.err.log`))}</string>
</dict></plist>
`;
}
