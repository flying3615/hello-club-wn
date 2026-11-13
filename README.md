# Hello Club booking automation

A profile-local Node.js/Playwright controller for **Wellington North Badminton Stadium** bookings through an already authenticated, visible Google Chrome session. It can inspect availability, wait for the weekly opening instant, and—only for an explicit protected job—submit a booking and verify it against the authenticated Hello Club calendar.

## What it does

- Uses an existing normal Chrome session through a loopback-only Chrome DevTools Protocol (CDP) endpoint. It never types, stores, copies, or exports login credentials, cookies, or browser profiles.
- Reads the rendered six-court booking grid and accepts only a complete requested interval, in the configured court priority order: **Court 4 → Court 5 → Court 6 → Court 1 → Court 2 → Court 3**.
- Supports `inspect`, `watch`, and explicit `execute` modes. Only `execute` with `submit: true` can submit a booking.
- Enforces the weekly opening rule: a target date becomes available at **07:00 Pacific/Auckland exactly seven calendar days earlier, on the same weekday**. For example, Tuesday 2026-11-03 opens Tuesday 2026-10-27 at 07:00 NZDT. Prewarming is permitted, but grid scanning, selection, and submission wait until the exact opening instant and a fresh target-page reload.
- Verifies date, time, court, booking type, participants, and payment state against the authenticated remote calendar after submission. A local record alone never proves that a booking exists remotely.
- Runs scheduled work through a logged-in macOS `launchd` LaunchAgent, rather than Hermes cron.

A successful real booking has been submitted and remotely verified with this project. The read-only commands below do **not** make a booking.

## Safety boundaries

- A job is schema-validated and must use a loopback CDP endpoint, an exact half-hour range, `Stadium Pass - Singles`, exactly two named participants, an allowed court order, opening and late-start timestamps, `paymentPolicy: "cancel-on-payment"`, and an explicit boolean `submit` field.
- `execute` requires `submit: true`; all other modes are read-only.
- Payment is never automatically approved. If Hello Club hands off to a payment page, the only permitted action is **CANCEL**, and only on the authenticated `/account/booking/<id>` page whose rendered venue, date, start time, and court match the job. The public `/booking/<id>` handoff is refused because its CANCEL flow can remove the booking. The automation never clicks **NEXT**, enters payment data, confirms a cancel-booking dialog, or uses **REMOVE BOOKING**.
- The final review and member picker are read as structured DOM lists, not free text. Any extra member, visitor, or service tag causes the submission to stop before **CONFIRM BOOKING**.
- The payment-page booking ID, when present, must match the newly created remote record; a same-shaped booking on another record is never accepted as evidence.
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

The normal automated workflow uses a logged-in macOS `launchd` LaunchAgent plus a one-time RTC wake plan. It is designed for an always-powered Mac mini that may be sleeping overnight:

1. An explicit job is created through `npm run schedule:job`. The command derives `openAt`, the exact three-minute `prepareAt` lead, and the default `latestStart`, validates the job, arms the RTC wake, and writes `state/jobs/active.json` atomically with restrictive permissions. A terminal job (completed, failed, or missed) is archived under `state/jobs/<status>/` and its dispatch marker is cleared, so the next job can be scheduled.
2. The job’s RTC plan wakes the Mac at **06:53 Pacific/Auckland**, four minutes before the fixed **06:57** prewarm time. After the one-time restricted helper installation below, job creation arms this wake automatically; it never stores an administrator password or grants arbitrary root access.
3. The persistent dispatcher has an exact daily **06:55** `StartCalendarInterval`. It exits immediately on unrelated days, waits locally through `prepareAt`, and invokes the runner only within the job’s explicit prewarm → late-start window. The runner is wrapped in `caffeinate` only after it has started.
4. The runner waits until `openAt` before scanning, selecting, or submitting. In `execute` mode it submits only when `submit: true`, then requires authenticated remote-calendar evidence before recording success.

Preview a job without arming the wake or writing `active.json`, then create it by removing `--dry-run`:

```bash
npm run schedule:job -- \
  --date 2026-11-06 \
  --start 17:00 \
  --end 18:00 \
  --participants "Yufei Liu,Zijia Liu" \
  --submit true \
  --dry-run
```

`--submit` defaults to `false`; only an explicit `--submit true` creates an executing job. Use `--courts` to override the court priority order and `--id` to choose a stable job ID.

> **macOS launchd note:** launchd agents cannot read a checkout under `~/Documents` without Full Disk Access; the agent exits with `EX_CONFIG` 78 and the log shows `Operation not permitted`. The git checkout therefore lives at `~/hello-club-playwright`, which is also the runtime root: launchd, the control panel, and the dedicated Chrome profile (`state/chrome-cdp-profile`) all run from this one checkout, so there is no separate copy to sync. Do not move it under `~/Documents`, and do not keep runtime state under `~/.hermes`, because Hermes updates can remove it.

Create or regenerate the persistent dispatcher plist:

```bash
npm run create:dispatcher
```

Reload it once from a normal macOS Terminal in the logged-in Aqua session:

```bash
launchctl bootout gui/$(id -u)/com.hermes.hello-club.dispatcher 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hermes.hello-club.dispatcher.plist
launchctl print gui/$(id -u)/com.hermes.hello-club.dispatcher
```

### One-time RTC helper installation

From the **runtime root** (`~/hello-club-playwright`) or the git checkout, run the following reviewed installation once in a normal macOS Terminal. `pmset` requires root authority; the installed helper accepts **no arguments**, reads only `state/wake/rtc-wake.txt` from its invocation working directory (the runtime root, set by `npm run schedule:job`), and can invoke only `/usr/bin/pmset schedule wake`. Reinstall the helper after updating this template or moving the runtime.

```bash
sudo install -d -o root -g wheel -m 755 /usr/local/libexec
sudo install -o root -g wheel -m 755 "$PWD/templates/hello-club-arm-rtc-wake" /usr/local/libexec/hello-club-arm-rtc-wake
sudo visudo -cf "$PWD/templates/hello-club-rtc-wake.sudoers"
sudo install -o root -g wheel -m 440 "$PWD/templates/hello-club-rtc-wake.sudoers" /etc/sudoers.d/hello-club-rtc-wake
sudo visudo -cf /etc/sudoers.d/hello-club-rtc-wake
```

After this one-time installation, future job creation calls the no-password, no-argument helper through `npm run arm:wake -- --job /absolute/path/to/job.json`. Before and after arming, the code reads `/usr/bin/pmset -g sched`: an already-matching event is reused without sudo, any other event owned by `com.hermes.hello-club` is a conflict, and the job is armed only when read-back shows exactly one matching wake event. The job is not created if any of those checks fail. No administrator password is stored.

The wake is a one-time event. It works after normal **Sleep**, not after shutdown; keep the Mac mini on AC power and remain logged in. Do not use `pmset schedule cancelall`, because it can remove unrelated macOS wake events.

For diagnostics, the runner can be invoked in read-only mode:

```bash
npm run run:launchd -- \
  --job /absolute/path/to/job.json \
  --mode inspect \
  --cdp-endpoint http://127.0.0.1:9223
```

`src/create-launchd-agent.mjs` generates a one-shot watch LaunchAgent for isolated diagnostics; it is not the normal scheduled-booking workflow.

## Peak boundaries

Hello Club books a single continuous interval inside one rate segment; it cannot span the normal/peak boundary. The configured boundaries are:

| Day type | Peak window |
| --- | --- |
| Monday–Friday | **17:00–21:30** |
| Saturday–Sunday | **13:00–21:00** |

A booking may end exactly at the peak start, or start exactly at the peak start/end boundary. A crossing interval is rejected when the job is built and again before submission, with a clear `peak boundary` error. The automation never splits a crossing interval or substitutes another one.

The weekday/weekend decision currently uses the Auckland weekday only; public-holiday schedules are not modelled separately.

## Weekly recurring bookings

Two independent LaunchAgents run the same protected `execute` flow:

| Task | Launch time | Target | Fixed interval |
| --- | --- | --- | --- |
| `com.hermes.hello-club.monday` | Monday **06:57** | next Monday | **15:30–17:00** |
| `com.hermes.hello-club.weekend` | Saturday/Sunday **06:57** | same weekday + 7 days | **08:00–10:00, flexible** (see below) |

### Flexible weekend booking

Weekend courts are sometimes partly taken by events, so the weekend job (`flexible: true`) books the best available time instead of one fixed court. After the opening it reads the grid once and picks, in order:

1. **One court for the whole 08:00–10:00**, in court priority order.
2. **Two courts that together cover 08:00–10:00** (e.g. Court 4 08:00–09:00 + Court 5 09:00–10:00). This is two separate Hello Club bookings; never more than two.
3. **The longest continuous time from 08:00** (at most two bookings), even if it is shorter than 1.5 hours.
4. **If no court is free at 08:00 at all:** the longest later time up to two hours (fewer bookings first, then the earliest start), always ending by the 13:00 weekend peak.

Both bookings are submitted back to back; remote-calendar verification of each runs afterwards, and each booking keeps its own confirmation fence until it is verified. The second booking re-reads the grid first and, if its court was taken, uses another court from the exact end of the first booking. A failure on the second booking never discards the first. Before any submission (including retries) the job refuses to book again when these participants already hold time on that date before 13:00, and an unresolved fence from an earlier attempt blocks new submissions until it is reconciled.

The Monday job stays a fixed interval on one court.

Each run targets the same weekday seven days later. Fixed-interval jobs (Monday) never substitute another interval: if the full interval is unavailable, the run fails and the failure record includes nearby availability from **06:00–19:30** for that date.

Reliability safeguards for the opening race:

- **Prewarm check.** 15 seconds before 07:00 the target tab is re-navigated. A tab that was discarded, crashed, or detached while the Mac slept (`Target page, context or browser has been closed`, the 2026-11-14 failure) is replaced by a fresh tab before the opening, and again at any point during polling.
- **Prior bookings read before the opening.** The duplicate-booking snapshot (four calendar months) is taken during prewarm instead of between the opening and the first slot click. A target date cannot be booked before its opening instant, so the snapshot is equivalent.
- **Court fallback.** If a court fails *before* **CONFIRM BOOKING** (for example the selection modal never opens because another member took the slot), the selection fence is cleared, the grid is reloaded, and the next permitted court is tried (at most two attempts per court) until `latestStart`. Any failure at or after **CONFIRM BOOKING** never falls back; it goes through authenticated reconciliation as before.
- **Retries until `latestStart`.** Transient Chrome/CDP failures are retried with 1–5 second delays until the job's late-start deadline instead of a fixed three attempts. Each attempt is logged as `attempt_failed`, and the failure report lists every attempt.
- **No sleep during the run.** The Monday and weekend LaunchAgents run under `caffeinate -dimsu` with `ProcessType` `Interactive`, so the Mac cannot idle-sleep (and Chrome is not backgrounded by display sleep) between the 06:56 wake and the opening.

Regenerate and reload the recurring agents after updating the runtime copy (normal macOS Terminal):

```bash
cd ~/hello-club-playwright
npm run create:recurring
for task in weekend monday; do
  label=com.hermes.hello-club.$task
  cp state/launchd/$task.plist ~/Library/LaunchAgents/$label.plist
  launchctl bootout gui/$(id -u)/$label 2>/dev/null || true
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/$label.plist
done
launchctl print gui/$(id -u)/com.hermes.hello-club.weekend | grep -A6 arguments
```

The Mac must wake for the 06:57 runs. Install the repeating wake once from a normal Terminal:

```bash
sudo pmset repeat wakeorpoweron MSU 06:56:00
```

`MSU` means Monday, Saturday, and Sunday. This replaces any existing repeating wake/sleep pair; check `pmset -g sched` first if another repeating schedule is in use. A repeating wake works after sleep, not after shutdown.

The first Monday run is the next Monday after installation and books the Monday **one week later** (for example, the Monday 2026-11-16 run books 2026-11-23 15:30–17:00). The weekend task works the same way.

## Local control panel

Start the read-only local panel manually:

```bash
npm run panel
```

On this machine it is also installed as a persistent `KeepAlive` LaunchAgent at `~/Library/LaunchAgents/com.hermes.hello-club.panel.plist`, running from `~/hello-club-playwright`, so it survives terminal and session exits.

Open `http://127.0.0.1:8787`. The page leads with the next weekend opening (countdown and target window) and a readiness checklist for that morning: dedicated Chrome reachable, the repeating `pmset` wake time, the run time of the *loaded* LaunchAgent (so an un-reloaded plist is flagged), and whether `caffeinate` is active. Below it, the last weekend result is drawn as six court lanes: booked segments, the free runs scanned after a failure, and the target window, plus every retry attempt. Upcoming and past bookings come only from the authenticated Hello Club calendar. The page refreshes every minute (local state only); the remote booking cache is refreshed at most every 12 hours or right after a verified booking. It is read-only and has a manual refresh button.

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
