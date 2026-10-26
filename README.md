# Hello Club Playwright runner

This profile-local project prepares a Playwright controller for Wellington North Badminton bookings.

## Current status

- Policy core implemented and covered by Node tests.
- Normal Google Chrome + CDP session verified on port `9223`.
- The authenticated booking page was read successfully through CDP.
- The booking grid was parsed read-only into 48 half-hour slots per court.
- A deterministic opening watcher now pre-warms the target page, waits until a bounded pre-opening window, polls every 2.5 seconds by default, verifies the exact rendered target date, and stops as soon as the real grid is available.
- The watcher has been exercised read-only through the live CDP session; it correctly identified the exact target date and returned no complete interval for the tested 2026-10-31 08:30–10:30 target without clicking.
- Court-selection logic was exercised against the live page and selected the first complete interval according to policy.
- A macOS `launchd` user-session runner is implemented and validated in read-only mode. It attaches to the existing Chrome/CDP session directly; Hermes cron is not in its execution path.
- Automatic submission remains deliberately disabled: the final review/payment verification path has not yet passed a controlled end-to-end calibration.
- No booking is submitted by this project yet.

## One-time session setup

The login must happen in a normal visible Chrome window, not a Playwright-launched browser. The current setup uses the independent profile at `state/chrome-cdp-profile` and CDP port `9223`. Enter credentials manually in that window; the program never types or stores them.

The CDP endpoint can be checked with:

```bash
curl http://127.0.0.1:9223/json/version
```

## Read-only inspection

```bash
node src/runner.mjs inspect --date YYYY-MM-DD --cdp
```

Inspection is read-only. It does not select a slot, create a booking, open a payment flow, or cancel anything. The grid parser uses the live `booking-grid-slot` DOM and rejects incomplete columns.

The watcher is read-only: it never selects a slot or submits a booking. Example:

```bash
node src/opening-watch.mjs \
  --date 2026-10-31 \
  --start 08:30 \
  --end 10:30 \
  --open-at 2026-10-24T07:00:00+13:00 \
  --lead-ms 15000 \
  --poll-ms 2500 \
  --timeout-ms 180000 \
  --cdp
```

It connects to the already-running normal Chrome session, waits until 15 seconds before the configured opening time, refreshes at most every 2.5 seconds within the bounded window, verifies the exact target-date heading, scans the grid, and reports the first complete preferred court. A CDP connection is disconnected with `process.exit(0)`; it never closes the user's Chrome.

## Native macOS launchd runner

Use a **LaunchAgent**, not a LaunchDaemon: it runs in the logged-in Aqua session and can attach to the already-authenticated visible Chrome through loopback CDP. It does not depend on Hermes cron or a freshly spawned LLM session.

A job JSON is intentionally restrictive: it must be mode `0600`, uses only `http://127.0.0.1:<port>`, specifies a half-hour range, exact booking type/players/court order, an opening time and late-start cutoff, and permits only `cancel-on-payment`. It rejects credential-like fields. The current runner supports only `inspect` and `watch`; `execute` is fail-closed until final-review/payment/remote-readback calibration passes.

Read-only validation:

```bash
node src/launchd-runner.mjs \
  --job /absolute/path/to/job.json \
  --mode inspect \
  --cdp-endpoint http://127.0.0.1:9223
```

The runner writes redacted JSONL results under `state/launchd/runs/` and uses an atomic per-job lock. It records no raw DOM, Chrome profile paths, cookies, credentials, payment data, or player names.

### Recommended: one-time persistent dispatcher

The recommended setup is one persistent LaunchAgent that uses a low-overhead 15-minute idle check, reads `state/jobs/active.json`, and starts a watcher only inside that job's explicit `prepareAt` → `latestStart` window. Each job is written with `prepareAt` at least 30 minutes before `openAt`, so a worst-case idle delay still leaves at least 15 minutes to prewarm Chrome and wait for the opening boundary. With no active job it does not connect to Chrome or poll the booking site. It claims each job atomically, so it cannot repeat a completed, failed, or missed booking attempt.

Create the dispatcher plist once:

```bash
node src/create-launchd-dispatcher.mjs
```

Then load it **once** from a normal macOS Terminal:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hermes.hello-club.dispatcher.plist
launchctl print gui/$(id -u)/com.hermes.hello-club.dispatcher
```

After this one-time load, future booking requests need no Terminal command: the assistant writes a new protected `state/jobs/active.json`, and the dispatcher starts the local runner at the configured prewarm time. The job ID must be unique per target, and the dispatcher never retries a terminal/unknown result automatically.

### One-shot agent: diagnostics only

`src/create-launchd-agent.mjs` can still generate a one-shot `watch` LaunchAgent for isolated diagnostics. It is not the normal future-booking workflow.

## Local control panel

The local, read-only control panel is served only on loopback at `http://127.0.0.1:8787`. It refreshes every five seconds and shows the persistent dispatcher, the dedicated Chrome/CDP connection, any active runner lock, the strictly configured active job, recent runner/dispatcher activity, and **only remote-verified bookings**.

```bash
npm run panel
```

It never exposes Chrome profile data, CDP URLs, raw page content, credentials, payment data, prompts, or arbitrary log contents. A preferred-court candidate from a read-only scan is intentionally not displayed as a booking. With no verified booking record, the confirmed-bookings list remains empty.

## Safety policy

- Court order is Court 4, Court 5, Court 6, then Court 1, 2, 3.
- A complete interval is required; a single free half-hour is not enough.
- Payment is never approved by default.
- For an explicitly authorized unpaid hold, the payment-page `CANCEL` path must be used, then the pending booking must be verified; `REMOVE BOOKING` is never used in the booking path.
- Unknown remote state blocks retries to avoid duplicate bookings.
- The project never accepts credentials from chat, reads authentication cookies, or copies a Chrome profile.
