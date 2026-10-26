import fs from 'node:fs/promises';
import { connectExistingChrome, launchPersistentSession, openBookingPage, openRawBookingPage, captureInspection, likelyAuthenticated } from './session.mjs';
import { STATE_DIR, DEFAULT_BASE_URL, DEFAULT_CDP_ENDPOINT } from './config.mjs';

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function usage() {
  console.log(`Usage:\n  node src/runner.mjs setup --date YYYY-MM-DD [--wait-seconds 300]\n  node src/runner.mjs inspect --date YYYY-MM-DD [--cdp]\n\nsetup opens the persistent browser for one-time manual authentication.\ninspect reads the authenticated page without submitting a booking.\n--cdp connects to an already running normal Chrome via CDP.`);
}

async function saveInspection(inspection) {
  await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const output = `${JSON.stringify(inspection, null, 2)}\n`;
  await fs.writeFile(`${STATE_DIR}/last-inspection.json`, output, { mode: 0o600 });
}

async function main() {
  const command = process.argv[2];
  const date = arg('date');
  if (!command || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    usage();
    process.exitCode = 2;
    return;
  }

  const useCdp = process.argv.includes('--cdp');
  const connection = useCdp
    ? await connectExistingChrome(arg('cdp-endpoint', DEFAULT_CDP_ENDPOINT))
    : { context: await launchPersistentSession({ headless: false }) };
  const { context } = connection;
  try {
    const page = command === 'setup'
      ? await openRawBookingPage(context, date, arg('base-url', DEFAULT_BASE_URL))
      : await openBookingPage(context, date, arg('base-url', DEFAULT_BASE_URL));
    if (command === 'setup') {
      const waitSeconds = Number(arg('wait-seconds', '300'));
      if (!Number.isInteger(waitSeconds) || waitSeconds < 10 || waitSeconds > 1800) {
        throw new Error('--wait-seconds must be an integer from 10 to 1800');
      }
      console.log(`浏览器已打开：${page.url()}`);
      console.log(`请在这个专用浏览器中手动完成 Google/Hello Club 登录；程序不会读取或输入凭据。等待 ${waitSeconds} 秒。`);
      await page.waitForTimeout(waitSeconds * 1000);
    } else if (command !== 'inspect') {
      usage();
      process.exitCode = 2;
      return;
    }

    const inspection = await captureInspection(page);
    await saveInspection(inspection);
    console.log(JSON.stringify({
      title: inspection.title,
      url: inspection.url,
      likelyAuthenticated: likelyAuthenticated(inspection),
      inspectionFile: `${STATE_DIR}/last-inspection.json`,
    }, null, 2));
  } finally {
    if (!useCdp) await context.close();
  }
  if (useCdp) process.exit(0);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
