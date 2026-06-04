/**
 * Engine.js — mode-agnostic reconciliation.
 *
 * The engine never decides what an event should look like; that lives in
 * Modes.js (buildDesired_) and the filter logic (evaluate_). The engine only
 * does the bookkeeping: gather sources, index existing managed targets by
 * tag, then create / update / delete to converge.
 *
 * Tag scheme: every event the engine creates is stamped on the *target*
 * calendar with key `calsync:<rule.name>` and a value that is a stable
 * identity of the source event. Because the tag lives on the target copy we
 * own, getTag/setTag is reliable here (it does not need to survive
 * cross-calendar sync). Buffer/title/time changes no longer orphan anything —
 * identity is the source event id, not its rendered times.
 */

const TAG_PREFIX = 'calsync:';

/** Format version of a managed event. Stamped as `calsync:schema` on every
 *  event the engine creates. Bump this when the managed-event shape changes;
 *  because managed events are self-identifying (they carry the tag), a future
 *  engine can find old-version events and upgrade them in place. See
 *  upgradeManagedEvents_ for the affordance. This is what makes the system
 *  "upgradeable by design" rather than requiring a manual purge each change. */
const SCHEMA_VERSION = '1';
const SCHEMA_TAG = TAG_PREFIX + 'schema';

/** Entry point: run every enabled rule for real. */
function syncAll() {
  return runAll_(false);
}

/** Entry point: log what would change without writing anything. */
function dryRunAll() {
  return runAll_(true);
}

function runAll_(dryRun) {
  const startedAt = new Date();
  const results = [];
  for (const raw of getSyncRules()) {
    const rule = normalizeRule_(raw);
    if (!rule.enabled) {
      log_(rule.name, 'INFO', 'rule disabled, skipping');
      continue;
    }
    try {
      results.push(syncRule_(rule, dryRun));
    } catch (err) {
      log_(rule.name, 'ERROR', `rule aborted: ${(err && err.stack) || err}`);
      results.push({ name: rule.name, error: String(err), stats: emptyStats_() });
    }
  }
  logRunSummary_(results, startedAt, dryRun);
  return results;
}

function syncRule_(rule, dryRun) {
  const tagKey = TAG_PREFIX + rule.name;
  const { start: windowStart, end: windowEnd } = window_(rule.windowDays);
  log_(rule.name, 'INFO',
    `${dryRun ? '[DRY RUN] ' : ''}mode=${rule.mode} window=${rule.windowDays}d ` +
    `sources=${rule.sources.length} target=${rule.target}`);

  // 1. gather source events across all source calendars
  const sourceItems = [];
  for (const srcId of rule.sources) {
    const cal = resolveCalendar_(srcId);
    if (!cal) { log_(rule.name, 'WARN', `source calendar not found / no access: ${srcId}`); continue; }
    for (const ev of cal.getEvents(windowStart, windowEnd)) {
      sourceItems.push({ srcId, event: ev });
    }
  }

  // 2. index existing managed events on the target by their tag value
  const target = resolveCalendar_(rule.target);
  if (!target) throw new Error(`target calendar not found / no write access: ${rule.target}`);
  const managed = new Map(); // tagValue -> target CalendarEvent
  for (const ev of target.getEvents(windowStart, windowEnd)) {
    const v = safeGetTag_(ev, tagKey);
    if (v) managed.set(v, ev);
  }
  log_(rule.name, 'INFO', `found ${sourceItems.length} source events, ${managed.size} existing managed`);

  // 3. reconcile
  const seen = new Set();
  const stats = emptyStats_();

  for (const item of sourceItems) {
    try {
      // loop guard: never re-sync an event this system created elsewhere
      if (isManagedBySelf_(item.event)) { stats.skipped++; continue; }

      const key = sourceKey_(item);
      const existing = managed.get(key);
      const skip = evaluate_(rule, item.event); // null = keep, string = reason

      if (skip) {
        if (existing) {
          deleteEvent_(existing, dryRun);
          managed.delete(key);
          stats.deleted++;
          log_(rule.name, 'CHANGE', `delete (now ${skip}): ${item.event.getTitle()}`);
        } else {
          stats.skipped++;
        }
        continue;
      }

      seen.add(key);
      const desired = buildDesired_(rule, item.event);

      if (existing) {
        const diff = diffEvent_(existing, desired);
        if (diff.length) {
          applyDesired_(existing, desired, dryRun);
          stats.updated++;
          log_(rule.name, 'CHANGE', `update [${diff.join(',')}]: ${desired.title}`);
        } else {
          stats.unchanged++;
        }
      } else {
        const created = createManaged_(target, tagKey, key, desired, dryRun);
        if (created) managed.set(key, created); // dedupe identical source keys in one run
        stats.created++;
        log_(rule.name, 'CHANGE', `create: ${desired.title} @ ${desired.start.toISOString()}`);
      }
    } catch (e) {
      stats.errors++;
      log_(rule.name, 'ERROR', `event "${tryTitle_(item.event)}" failed: ${(e && e.stack) || e}`);
    }
  }

  // 4. delete managed targets whose source disappeared
  managed.forEach((ev, key) => {
    if (seen.has(key)) return;
    try {
      deleteEvent_(ev, dryRun);
      stats.deleted++;
      log_(rule.name, 'CHANGE', `delete orphan: ${ev.getTitle()}`);
    } catch (e) {
      stats.errors++;
      log_(rule.name, 'ERROR', `orphan delete failed: ${(e && e.stack) || e}`);
    }
  });

  log_(rule.name, 'INFO',
    `done: created=${stats.created} updated=${stats.updated} ` +
    `unchanged=${stats.unchanged} skipped=${stats.skipped} ` +
    `deleted=${stats.deleted} errors=${stats.errors}`);
  return { name: rule.name, stats };
}

/* ----------------------------- filters ------------------------------ */

/** Returns a skip reason string, or null to keep the event. */
function evaluate_(rule, event) {
  const status = safeStatus_(event);
  if (status === CalendarApp.GuestStatus.NO && !rule.includeDeclined) return 'declined';

  const pending = status === CalendarApp.GuestStatus.INVITED || status === CalendarApp.GuestStatus.MAYBE;
  if (pending && !rule.includePending) return 'pending';

  if (rule.onlyDefaultEventType && safeType_(event) !== CalendarApp.EventType.DEFAULT) {
    return `event-type ${safeType_(event)}`;
  }

  const allDay = event.isAllDayEvent();
  if (allDay && !rule.includeAllDay) return 'all-day';

  const durMs = event.getEndTime().getTime() - event.getStartTime().getTime();
  if (!allDay && durMs < rule.minDurationMinutes * 60000) return 'too-short';
  if (!rule.includeMultiDay && durMs > 24 * 60 * 60 * 1000) return 'multi-day';

  if (!rule.includeWeekends) {
    const d = event.getStartTime().getDay();
    if (d === 0 || d === 6) return 'weekend';
  }

  const title = event.getTitle() || '';
  if (rule.excludeTitles.some((kw) => title.indexOf(kw) >= 0)) return 'excluded-title';

  return null;
}

/* ---------------------------- mutations ----------------------------- */

function createManaged_(target, tagKey, tagValue, d, dryRun) {
  if (dryRun) return null;
  return withRetry_(() => {
    const ev = target.createEvent(d.title, d.start, d.end);
    ev.setTag(tagKey, tagValue);
    ev.setTag(SCHEMA_TAG, SCHEMA_VERSION); // self-identifying for future upgrades
    if (d.location) ev.setLocation(d.location);
    if (d.description) ev.setDescription(d.description);
    if (d.color) ev.setColor(d.color);
    if (d.visibility) ev.setVisibility(d.visibility);
    if (d.removeReminders) ev.removeAllReminders();
    return ev;
  });
}

function applyDesired_(ev, d, dryRun) {
  if (dryRun) return;
  withRetry_(() => {
    if (ev.getTitle() !== d.title) ev.setTitle(d.title);
    if (ev.getStartTime().getTime() !== d.start.getTime() ||
        ev.getEndTime().getTime() !== d.end.getTime()) {
      ev.setTime(d.start, d.end);
    }
    ev.setLocation(d.location || '');
    ev.setDescription(d.description || '');
    if (d.color) ev.setColor(d.color);
    if (d.visibility) ev.setVisibility(d.visibility);
    if (d.removeReminders) ev.removeAllReminders();
  });
}

function deleteEvent_(ev, dryRun) {
  if (dryRun) return;
  withRetry_(() => ev.deleteEvent());
}

/** Fields that differ between an existing target event and the desired shape. */
function diffEvent_(ev, d) {
  const out = [];
  if (ev.getTitle() !== d.title) out.push('title');
  if (ev.getStartTime().getTime() !== d.start.getTime() ||
      ev.getEndTime().getTime() !== d.end.getTime()) out.push('time');
  if ((ev.getLocation() || '') !== (d.location || '')) out.push('location');
  if ((ev.getDescription() || '') !== (d.description || '')) out.push('description');
  return out;
}

/* ----------------------------- helpers ------------------------------ */

/** Stable identity of a source event: which source calendar + event id +
 *  start. The start disambiguates recurring instances (CalendarApp returns
 *  one id for the whole series); the trade-off is that moving a single
 *  instance is a delete+create rather than an in-place update. */
function sourceKey_(item) {
  return `${item.srcId}|${item.event.getId()}|${item.event.getStartTime().toISOString()}`;
}

/** True if this event carries any calsync tag, i.e. we created it. Prevents
 *  feedback loops (e.g. on-call mirrored into a personal calendar that is
 *  itself a mask source). Requires edit access to read tags; failures are
 *  treated as "not ours". */
function isManagedBySelf_(event) {
  try {
    return event.getAllTagKeys().some((k) => k.indexOf(TAG_PREFIX) === 0);
  } catch (e) {
    return false;
  }
}

function window_(days) {
  const start = new Date();
  const end = new Date();
  end.setDate(start.getDate() + days);
  return { start, end };
}

/** Resolve a calendar reference (a name from CALENDARS, or a raw id/'primary')
 *  to a Calendar. Names are looked up first so rules can use 'work' etc. */
function resolveCalendar_(ref) {
  const id = (CALENDARS && CALENDARS[ref]) || ref;
  if (!id || id === 'primary' || id === 'default') return CalendarApp.getDefaultCalendar();
  return CalendarApp.getCalendarById(id);
}

function normalizeRule_(raw) {
  const r = Object.assign({}, RULE_DEFAULTS, raw);
  r.sources = raw.sources ? raw.sources.slice() : (raw.source ? [raw.source] : []);
  if (!r.name) throw new Error('rule is missing a name');
  if (r.mode !== 'mask' && r.mode !== 'mirror') throw new Error(`rule ${r.name}: bad mode ${r.mode}`);
  if (!r.sources.length) throw new Error(`rule ${r.name}: no sources`);
  return r;
}

/** Retry a mutating Calendar call with exponential backoff. Calendar
 *  occasionally throws transient "service invoked too many times" / backend
 *  errors; this absorbs them without a blanket per-event sleep. */
function withRetry_(fn) {
  const delays = [500, 1500, 4000];
  for (let attempt = 0; ; attempt++) {
    try {
      const out = fn();
      if (WRITE_THROTTLE_MS > 0) Utilities.sleep(WRITE_THROTTLE_MS);
      return out;
    } catch (e) {
      if (attempt >= delays.length) throw e;
      Utilities.sleep(delays[attempt]);
    }
  }
}

function safeGetTag_(ev, key) { try { return ev.getTag(key); } catch (e) { return null; } }
function safeStatus_(ev) { try { return ev.getMyStatus(); } catch (e) { return null; } }
function safeType_(ev) { try { return ev.getEventType(); } catch (e) { return CalendarApp.EventType.DEFAULT; } }
function tryTitle_(ev) { try { return ev.getTitle(); } catch (e) { return '<unknown>'; } }

function emptyStats_() {
  return { created: 0, updated: 0, unchanged: 0, skipped: 0, deleted: 0, errors: 0 };
}

/**
 * Upgrade managed events created by an older SCHEMA_VERSION, in place. This is
 * the upgradeability affordance: when you bump SCHEMA_VERSION and change the
 * managed-event shape, add a transform here keyed by the old version. Because
 * every managed event carries `calsync:schema`, the engine can find and
 * convert old events without a purge-and-rebuild.
 *
 * Run manually (`clasp run upgradeManagedEvents`) after deploying a version
 * bump. It is a no-op while SCHEMA_VERSION === '1' (nothing older exists).
 */
function upgradeManagedEvents() {
  const targets = new Set(getSyncRules().map((r) => r.target));
  let scanned = 0, upgraded = 0;
  for (const ref of targets) {
    const cal = resolveCalendar_(ref);
    if (!cal) continue;
    const { start, end } = window_(370); // wide window to catch everything managed
    for (const ev of cal.getEvents(start, end)) {
      const tagKeys = (() => { try { return ev.getAllTagKeys(); } catch (e) { return []; } })();
      const isManaged = tagKeys.some((k) => k.indexOf(TAG_PREFIX) === 0 && k !== SCHEMA_TAG);
      if (!isManaged) continue;
      scanned++;
      const from = safeGetTag_(ev, SCHEMA_TAG) || '0';
      if (from === SCHEMA_VERSION) continue;
      // Per-version transforms go here, e.g.:
      //   if (from === '1') { /* mutate ev to v2 shape */ }
      withRetry_(() => ev.setTag(SCHEMA_TAG, SCHEMA_VERSION));
      upgraded++;
      log_('*', 'CHANGE', `upgraded managed event ${from}→${SCHEMA_VERSION}: ${ev.getTitle()}`);
    }
  }
  log_('*', 'INFO', `upgrade scan complete: scanned=${scanned} upgraded=${upgraded}`);
}
