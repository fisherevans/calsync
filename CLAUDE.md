# calsync - working notes for Claude

One Google Apps Script that reconciles a source calendar into a target, two ways:
`mask` (opaque busy-blocks, no detail leak) and `mirror` (copy titles + optional
join link). Both directions are the same operation, so they share one engine and
differ only by per-rule config. Deployed to Apps Script via `clasp`.

User-facing setup, deploy, and operations docs live in `README.md`. This file is
for working on the code.

## Architecture

The engine is mode-agnostic. The split that matters:

- `src/Engine.js` - reconciliation + all Calendar mutation. Gathers source events,
  indexes existing managed targets by tag, then create/update/deletes to converge.
  Idempotent: a no-op run reports everything `unchanged`. Entry points: `syncAll`,
  `dryRunAll`, `setupTriggers`/`rebuildTriggers` (in Triggers.js), `upgradeManagedEvents`.
- `src/Modes.js` - pure shaping. Turns a source event into a "desired" target shape
  (`buildMaskDesired_` / `buildMirrorDesired_`). Writes nothing to Calendar.
- `src/Triggers.js` - reconciling trigger management (hourly CLOCK sweep + one
  `onEventUpdated` CALENDAR trigger per distinct source calendar).
- `src/Logging.js` - structured JSON to Cloud Logging via `console.log`.
- `src/appsscript.json` - manifest (OAuth scopes, timezone).
- `Config.example.js` - template. The real `src/Config.js` is gitignored.

## Invariants - do not break these

- **Tag-based identity.** Every event the engine creates is stamped on the *target*
  with `calsync:<rule.name>` (value = stable source identity) plus `calsync:schema`.
  That tag, not title/time, is how the engine finds its own events. Renames and
  reschedules become in-place updates, not duplicate churn. Never key reconciliation
  off rendered fields.
- **Loop guard.** The engine skips any source event already carrying a `calsync:`
  tag (`isManagedBySelf_`), so rules can't feed each other. Keep this when adding
  source-scanning logic.
- **Source key shape.** `sourceKey_` = `srcId|eventId|startISO`. The start
  disambiguates recurring instances (CalendarApp gives one id per series). Trade-off:
  moving a single instance is delete+create, not in-place update.
- **Dry-run honesty.** Every mutation helper (`createManaged_`, `applyDesired_`,
  `deleteEvent_`) must no-op when `dryRun` is true. `dryRunAll` writes nothing.
- **Schema versioning.** Managed events carry `calsync:schema = SCHEMA_VERSION`. When
  the managed-event shape changes, bump `SCHEMA_VERSION` and add a per-version
  transform in `upgradeManagedEvents` rather than forcing a purge-and-rebuild.

## Conventions

- This is Apps Script (V8 runtime), not Node. No imports/modules: every top-level
  `function`/`const` across files shares one global scope. `Config.js` defines the
  globals `CALENDARS`, `getSyncRules()`, `RULE_DEFAULTS`, `WRITE_THROTTLE_MS` that
  the engine reads. That is why `Config.example.js` lives *outside* `src/` - if clasp
  uploaded it, it would redefine those globals and the project would fail to load.
- Trailing-underscore names (`syncRule_`, `buildDesired_`) are the internal/private
  convention; no-underscore names (`syncAll`, `setupTriggers`) are the functions you
  run from the Apps Script editor.
- 2-space indent, single quotes, same-line braces. Match the existing files.
- Calendar API calls can throw transiently - wrap mutations in `withRetry_` and read
  helpers in the `safe*_` try/catch wrappers already present.
- Comments: sparse and section-organizing. Package-level intent goes in the
  file-top block comment, which is where the real docs live.

## Type checking

`npm run typecheck` runs `tsc --noEmit` against `src/**/*.js` with
`@types/google-apps-script` (checkJs is on). There is no runtime test harness -
Apps Script can't be unit-tested locally, which is why Modes.js is kept pure. Verify
behavior with `dryRunAll` in the editor before running `syncAll` for real.

## Privacy boundary

`src/Config.js` is the only file with personal data (calendar ids) and is gitignored,
as are `.clasp.json` (your scriptId) and `og/` (pre-unification scripts with real
ids). Keep new personal data confined to `Config.js`. Never commit calendar ids,
emails, or scriptIds in tracked files.
