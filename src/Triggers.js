/**
 * Triggers.js — reconciling trigger management.
 *
 * Apps Script triggers can't be edited in place, only created and deleted, so
 * the naive approach is "delete all, recreate all" on every run. That's not
 * fragile exactly, but it does churn working triggers and momentarily leaves
 * the project with none. Instead, setupTriggers() reconciles: it computes the
 * desired trigger set from config, keeps the existing ones that already match,
 * deletes only the stale ones, and creates only the missing ones. Re-running
 * it when nothing changed is a no-op.
 *
 * The "hybrid" desired set:
 *   - one hourly time-driven (CLOCK) trigger → syncAll  (safety-net sweep)
 *   - one onEventUpdated (CALENDAR) trigger per distinct source calendar → syncAll
 *
 * It only ever touches triggers whose handler is `syncAll`, so any unrelated
 * trigger in the project is left alone.
 *
 * One limitation worth knowing: the Trigger API exposes a trigger's source and
 * handler but NOT a CLOCK trigger's interval. So reconcile can confirm "an
 * hourly syncAll clock trigger exists" but can't detect that you changed
 * everyHours(1) → everyHours(2). When you change the *cadence*, run
 * rebuildTriggers() (force) once. For changing which calendars are sources,
 * plain setupTriggers() is enough.
 */

const TRIGGER_HANDLER = 'syncAll';

/** Reconcile triggers to match config. Safe to run repeatedly. */
function setupTriggers() {
  const desired = desiredTriggerSigs_(); // Set of signatures we want
  const existing = ScriptApp.getProjectTriggers();

  const present = new Set();
  let deleted = 0;
  for (const t of existing) {
    if (t.getHandlerFunction() !== TRIGGER_HANDLER) continue; // not ours — leave it
    const sig = triggerSig_(t);
    if (desired.has(sig) && !present.has(sig)) {
      present.add(sig); // first matching instance — keep it
    } else {
      ScriptApp.deleteTrigger(t); // stale, or a duplicate of one we already kept
      deleted++;
      Logger.log(`deleted trigger ${sig}`);
    }
  }

  let created = 0;
  for (const sig of desired) {
    if (present.has(sig)) continue;
    if (createTriggerForSig_(sig)) created++;
  }

  Logger.log(`setupTriggers: kept=${present.size} created=${created} deleted=${deleted}`);
}

/** Force a full teardown + rebuild. Use after changing the clock cadence,
 *  which reconcile can't detect. */
function rebuildTriggers() {
  let n = 0;
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() !== TRIGGER_HANDLER) continue;
    ScriptApp.deleteTrigger(t);
    n++;
  }
  Logger.log(`rebuildTriggers: cleared ${n} syncAll triggers`);
  setupTriggers();
}

/* ----------------------------- internals ---------------------------- */

/** Signatures of the triggers we want. */
function desiredTriggerSigs_() {
  const sigs = new Set(['clock']);
  for (const calId of distinctSourceCalendarIds_()) sigs.add('cal:' + calId);
  return sigs;
}

/** Signature of an existing trigger (handler already known to be ours). */
function triggerSig_(t) {
  if (t.getTriggerSource() === ScriptApp.TriggerSource.CLOCK) return 'clock';
  if (t.getTriggerSource() === ScriptApp.TriggerSource.CALENDAR) return 'cal:' + t.getTriggerSourceId();
  return 'other:' + t.getUniqueId(); // never in desired → gets deleted
}

function createTriggerForSig_(sig) {
  try {
    if (sig === 'clock') {
      ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased().everyHours(1).create();
      Logger.log('created hourly clock trigger');
      return true;
    }
    const calId = sig.slice('cal:'.length);
    ScriptApp.newTrigger(TRIGGER_HANDLER).forUserCalendar(calId).onEventUpdated().create();
    Logger.log(`created onEventUpdated trigger for ${calId}`);
    return true;
  } catch (e) {
    // forUserCalendar can reject a calendar not owned by the running account
    // (e.g. an import calendar). The hourly sweep still covers it.
    Logger.log(`could not create trigger ${sig} (${e}); relying on hourly sweep`);
    return false;
  }
}

/** Distinct source calendar IDs (resolved from rule source names). */
function distinctSourceCalendarIds_() {
  const set = new Set();
  for (const raw of getSyncRules()) {
    if (raw.enabled === false) continue;
    const refs = raw.sources || (raw.source ? [raw.source] : []);
    for (const ref of refs) {
      const cal = resolveCalendar_(ref);
      if (cal) set.add(cal.getId());
    }
  }
  return Array.from(set);
}
