# Hello Club booking automation

A profile-local Node.js/Playwright controller for **Wellington North Badminton Stadium** bookings through an already authenticated, visible Google Chrome session. It can inspect availability, wait for the weekly opening instant, and—only for an explicit protected job—submit a booking and verify it against the authenticated Hello Club calendar.

## What it does

- Uses an existing normal Chrome session through a loopback-only Chrome DevTools Protocol (CDP) endpoint. It never types, stores, copies, or exports login credentials, cookies, or browser profiles.
- Reads the rendered six-court booking grid and accepts only a complete requested interval, in the configured court priority order: **Court 4 → Court 5 → Court 6 → Court 1 → Court 2 → Court 3**.
- Supports `inspect`, `watch`, and explicit `execute` modes. Only `execute` with `submit: true` can submit a booking.
- Enforces the weekly opening rule: a target Monday becomes available at **07:00 Pacific/Auckland on the preceding Monday**. Prewarming is permitted, but grid scanning, selection, and submission wait until the exact opening instant and a fresh target-page reload.
- Verifies date, time, court, booking type, participants, and payment state against the authenticated remote calendar after submission. A local record alone never proves that a booking exists remotely.
- Runs scheduled work through a logged-in macOS `launchd` LaunchAgent, rather than Hermes cron.

A successful real booking has been submitted and remotely verified with this project. The read-only commands below do **not** make a booking.

## Safety boundaries

- A job is schema-validated and must use a loopback CDP endpoint, an exact half-hour range, `Stadium Pass - Singles`, exactly two named participants, an allowed court order, opening and late-start timestamps, `paymentPolicy: "cancel-on-payment"`, and an explicit boolean `submit` field.
- `execute` requires `submit: true`; all other modes are read-only.
- Payment is never automatically approved. If Hello Club hands off to a payment page, the only permitted action is **CANCEL**; the automation never clicks **NEXT**, enters payment data, or uses **REMOVE BOOKING**.
- The local control panel is loopback-only and read-only. It cannot create, change, pay for, remove, or cancel bookings.
- Runtime state is intentionally excluded from Git: `state/` contains the Chrome profile, jobs, booking records, logs, diagnostics, and screenshots.

## Prerequisites

- Node.js with dependencies installed: `npm install`
- A normal visible Google Chrome window using the independent local profile under `state/chrome-cdp-profile`, already signed in manually to Hello Club.
- Chrome started with a loopback CDP endpoint, normally `http://127.0.0.1:9223`.

Check the endpoint without exposing credentials:

```bash
curl http://127.0.0.1:9223/json/version
```

## Read-only inspection

Inspecting a date reads availability only; it does not select a slot, open a payment flow, create, cancel, or remove a booking.

```bash
npm run run -- inspect --date YYYY-MM-DD --cdp
```

The grid parser reads the live `booking-grid-slot` DOM and rejects incomplete court columns.

## Opening watcher

The watcher waits for a configured opening boundary, refreshes the target page at most every 2.5 seconds in its bounded window, verifies the venue/date/courts, and reports a suitable complete interval. It remains read-only.

```bash
npm run watch:opening -- \
  --date YYYY-MM-DD \
  --start 15:30 \
  --end 16:30 \
  --open-at 2026-10-26T07:00:00+13:00 \
  --lead-ms 15000 \
  --poll-ms 2500 \
  --timeout-ms 180000 \
  --cdp
```

The watcher disconnects from CDP when it finishes; it never closes the user’s Chrome.

## Scheduled booking workflow

The normal automated workflow is a persistent user LaunchAgent:

1. An explicit job is placed at `state/jobs/active.json` with restrictive permissions.
2. The dispatcher performs a low-overhead idle check every 15 minutes. It only starts the runner inside the job’s explicit `prepareAt` → `latestStart` window.
3. The runner may prewarm before the opening instant, but waits until `openAt` before scanning, selecting, or submitting.
4. In `execute` mode, the runner submits only when `submit: true`, then requires authenticated remote-calendar evidence before recording success.

Create the persistent dispatcher plist once:

```bash
npm run create:dispatcher
```

Load it once from a normal macOS Terminal in the logged-in Aqua session:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hermes.hello-club.dispatcher.plist
launchctl print gui/$(id -u)/com.hermes.hello-club.dispatcher
```

For diagnostics, the runner can be invoked in read-only mode:

```bash
npm run run:launchd -- \
  --job /absolute/path/to/job.json \
  --mode inspect \
  --cdp-endpoint http://127.0.0.1:9223
```

`src/create-launchd-agent.mjs` generates a one-shot watch LaunchAgent for isolated diagnostics; it is not the normal scheduled-booking workflow.

## Local control panel

Start the read-only local panel:

```bash
npm run panel
```

Open `http://127.0.0.1:8787`. It shows safe status information for the dispatcher, Chrome/CDP reachability, active runner locks, any active job, recent activity, and only authenticated-remote verified bookings. The browser UI refreshes hourly; its remote booking cache is refreshed at most every 12 hours.

The panel does not display raw page content, Chrome profile data, CDP details, credentials, cookies, payment data, prompts, or arbitrary log contents.

## Development

```bash
npm test
```

The project is intentionally private. Before committing, confirm that Git does not stage `state/`, environment files, Chrome profile data, screenshots, temporary scripts, or logs:

```bash
git status --short
git check-ignore -v state/chrome-cdp-profile/Default/Cookies
```
