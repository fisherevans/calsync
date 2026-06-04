# calsync - development and operations

Everything beyond the quick start in the [README](../README.md). How the engine
works internally, how the repo is laid out, and the operational details you'll want
once it's running.

## How it works

- **Rules.** Each entry in `getSyncRules()` is one source->target sync with a `mode`
  (`mask` or `mirror`), a look-ahead window, and filters. See `Config.example.js` for
  the full field set.
- **Tag-based tracking.** Every event the engine creates is tagged `calsync:<rule>`
  on the target. That tag - not the title or time - is how it finds its own events
  later, so renames, reschedules, and buffer changes are in-place updates instead of
  duplicate churn. It also skips any source event carrying a `calsync:` tag, so rules
  can't feed each other into a loop.
- **Triggers.** A single `setupTriggers()` installs the "hybrid" model: an hourly
  time-driven sweep plus an `onEventUpdated` trigger per source calendar (reactive,
  but it just re-runs the idempotent reconcile).
- **One account.** The script runs as a single Google account. That account needs
  **read** on every source calendar and **write** on every target (tags require write
  access). The usual setup: run as the account that owns the "busy" calendar, and
  share the other calendars into it with "Make changes to events".

## Repo layout

| Path | Committed? | Pushed to Apps Script? | What |
|------|-----------|------------------------|------|
| `src/Engine.js`, `Modes.js`, `Triggers.js`, `Logging.js` | yes | yes | the engine - rarely changes |
| `src/Types.js` | yes | yes | JSDoc typedefs (comment-only) for `npm run typecheck` |
| `src/appsscript.json` | yes | yes | manifest (scopes, timezone) |
| `src/Config.js` | **no** (gitignored) | yes | **your** rules + calendar ids |
| `Config.example.js` | yes | **no** (outside `src/`) | the template you copy from |
| `.clasp.json` | **no** (gitignored) | n/a | your project binding (`clasp create` writes it) |
| `package.json`, `jsconfig.json` | yes | no | tooling / type-checking |
| `CLAUDE.md` | yes | no | working notes for the Claude Code agent |

The split that matters: **`src/Config.js` is the only file with personal data, and it
is never committed.** You create it from `Config.example.js`. The template lives
outside `src/` so clasp never uploads it (if it did, it would redefine the same
globals as your real config and the project would fail to load).

## Updating your config

```bash
$EDITOR src/Config.js     # change a window, add/disable a rule, tweak filters
npx clasp push            # deploy
```

Then re-run **`dryRunAll`** (editor) to confirm the change does what you expect before
it acts. Notes:

- **Disabling a rule** (`enabled: false`) stops it syncing but does **not** delete
  what it already created - delete those by hand, or temporarily flip the rule's
  window/sources so its targets become orphans it cleans up.
- **Re-run `setupTriggers`** only when you change *which calendars are sources*
  (trigger topology). Ordinary field edits don't need it. If you change the hourly
  *cadence*, run `rebuildTriggers` (a force teardown+rebuild), since reconcile can't
  see a clock trigger's interval.
- The engine is idempotent: a no-op run reports everything `unchanged`.

## Migrating from an existing calendar-sync setup

If you're replacing older scripts that already created events, the new engine won't
recognize their copies (no `calsync:` tag) and you'll get duplicates. The clean
cutover:

1. Disable/delete the old scripts' triggers so they stop writing.
2. Delete the old copies (by their old title/tag), then run `syncAll` to rebuild
   fresh tagged copies.

This is a one-time, setup-specific chore, so it's intentionally **not** shipped in
`src/`. Write a throwaway `src/migrate.js` with a `migrateDryRun()` / `migrateCleanup()`
pair, push it, run the dry run, run the cleanup, then delete the file and `clasp push`.
Make it skip anything already carrying a `calsync:` tag so it can never delete a new
copy. (Deleted Google Calendar events sit in the calendar Trash ~30 days if you need
to undo.)

## Operations and gotchas

- **Logs.** The engine logs structured JSON via `console.log` to Cloud Logging
  (filter by `jsonPayload.rule` / `jsonPayload.kind`), plus a per-run `SUMMARY`.
  `npx clasp tail-logs` streams it; the editor's Executions tab also shows it.
- **Run from the editor, not `clasp run`.** The `npm run dry-run` / `setup-triggers`
  shortcuts call `clasp run`, which needs extra GCP-project wiring. The editor **Run**
  button is simpler and handles OAuth consent inline. The shortcuts are there if you
  set `clasp run` up later.
- **`clasp push` does not delete remote files.** If you remove a file locally (e.g. a
  one-off `migrate.js`), delete it in the editor too - push only uploads/overwrites.
- **Runtime limits.** Apps Script caps a single execution at 6 min (consumer) / 30 min
  (Workspace), and time-driven triggers at 90 min/day cumulative. There is no
  per-event sleep; writes retry with backoff instead. If a busy source calendar makes
  the reactive trigger run too often, narrow windows or scope the trigger handler to
  the changed calendar.
- **Type checking.** `npm run typecheck` runs `tsc -p jsconfig.json` against
  `src/**/*.js` with `@types/google-apps-script`. There is no runtime test harness -
  Apps Script can't be unit-tested locally, which is why `Modes.js` is kept pure.
- **uuid override.** `package.json` pins `uuid` via `overrides` to patch
  CVE-2026-41907, which clasp pulls in transitively. Harmless; keep it. If your org
  runs a supply-chain firewall on `npm`, this is what lets the install pass.

## Exporting / forking this repo

`.gitignore` already keeps your personal config (`src/Config.js`), project binding
(`.clasp.json`), auth, and `node_modules` out. Because git honors `.gitignore`, your
calendar ids won't be committed - verify with `git status` that `src/Config.js` is
untracked before you push anywhere. Don't ship a raw `zip` of the folder: a plain zip
ignores `.gitignore` and would include `src/Config.js` and `node_modules`. Use
`git archive` if you need a tarball.
