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
  // A tag value identifies exactly one source instance, so more than one
  // target event carrying it is a duplicate. Bucket first rather than
  // assigning into a Map: a Map keyed by tag value keeps only the last event
  // and silently drops the rest, which removes them from both the update path
  // and the orphan sweep below. That is what let duplicates persist forever
  // instead of converging.
  const byKey = new Map(); // tagValue -> target CalendarEvent[]
  for (const ev of target.getEvents(windowStart, windowEnd)) {
    const v = safeGetTag_(ev, tagKey);
    if (!v) continue;
    if (!byKey.has(v)) byKey.set(v, []);
    byKey.get(v).push(ev);
  }

  const stats = emptyStats_();
  const managed = new Map(); // tagValue -> the one target CalendarEvent we keep
  byKey.forEach((events, v) => {
    managed.set(v, events[0]);
    for (let i = 1; i < events.length; i++) {
      try {
        deleteEvent_(events[i], dryRun);
        stats.deleted++;
        log_(rule.name, 'CHANGE', `delete duplicate (same key ${v})`);
      } catch (e) {
        stats.errors++;
        log_(rule.name, 'ERROR', `duplicate delete failed: ${(e && e.stack) || e}`);
      }
    }
  });
  log_(rule.name, 'INFO',
    `found ${sourceItems.length} source events, ${managed.size} existing managed, ` +
    `${stats.deleted} same-key duplicates removed`);

  // 3. reconcile
  const seen = new Set();

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

/**
 * Create one managed event on the target.
 *
 * createEvent is not idempotent, so it must never share a withRetry_ block
 * with the setters that follow it. Retrying the whole sequence after a
 * transient failure in a later setter re-runs createEvent and leaves the
 * first, half-configured event behind. That stray has no calsync tag, so
 * reconcile cannot index it (step 2), cannot orphan-delete it (step 4), and
 * cannot recognise it as ours, which makes the duplicate permanent.
 *
 * Each call therefore gets its own retry, and the tag is written first: an
 * event that is tagged but otherwise unshaped is repaired by diffEvent_ on
 * the next run, while an untagged one is lost.
 */
function createManaged_(target, tagKey, tagValue, d, dryRun) {
  if (dryRun) return null;
  const ev = withRetry_(() => target.createEvent(d.title, d.start, d.end));
  withRetry_(() => ev.setTag(tagKey, tagValue));
  withRetry_(() => ev.setTag(SCHEMA_TAG, SCHEMA_VERSION)); // for future upgrades
  if (d.location) withRetry_(() => ev.setLocation(d.location));
  if (d.description) withRetry_(() => ev.setDescription(d.description));
  if (d.color) withRetry_(() => ev.setColor(d.color));
  if (d.visibility) withRetry_(() => ev.setVisibility(d.visibility));
  if (d.removeReminders) withRetry_(() => ev.removeAllReminders());
  return ev;
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

/* --------------------------- stray cleanup -------------------------- */

/**
 * Remove untagged duplicates left behind by the pre-fix createManaged_.
 *
 * A stray is an event on a target calendar that exactly matches a properly
 * tagged managed event (same title, same start, same end) but carries no
 * calsync tag of its own. Reconcile cannot see these, so they persist through
 * every run; this is the only thing that removes them.
 *
 * The match is deliberately exact and requires a tagged sibling. A group with
 * no tagged event is left alone, because without one there is no evidence the
 * duplicate came from here rather than from you.
 *
 * Run dryRunCleanupStrays() first and read the report. The editor's Run button
 * passes no arguments, which is why these are two functions rather than one
 * with a flag.
 */
function dryRunCleanupStrays() { return cleanupStrays_(true); }

/** Delete the strays that dryRunCleanupStrays() reports. */
function cleanupStrays() { return cleanupStrays_(false); }

function cleanupStrays_(dryRun) {
  const startedAt = new Date();
  const findings = [];
  let deleted = 0;
  let errors = 0;

  for (const raw of getSyncRules()) {
    const rule = normalizeRule_(raw);
    const tagKey = TAG_PREFIX + rule.name;
    const target = resolveCalendar_(rule.target);
    if (!target) {
      log_(rule.name, 'WARN', `target calendar not found: ${rule.target}`);
      continue;
    }

    // Duplicates can sit before the sync window, which is forward-only from
    // now, so reconcile will never revisit them however it is fixed. Look
    // back as well as ahead.
    const start = new Date();
    start.setDate(start.getDate() - 90);
    const end = new Date();
    end.setDate(end.getDate() + rule.windowDays + 30);

    const byKey = new Map();   // tag value -> events carrying it
    const byShape = new Map(); // title|start|end -> { tagged, untagged }
    for (const ev of target.getEvents(start, end)) {
      const shape = [tryTitle_(ev), ev.getStartTime().toISOString(), ev.getEndTime().toISOString()].join('|');
      if (!byShape.has(shape)) byShape.set(shape, { tagged: [], untagged: [] });
      const tagValue = safeGetTag_(ev, tagKey);
      if (tagValue) {
        if (!byKey.has(tagValue)) byKey.set(tagValue, []);
        byKey.get(tagValue).push(ev);
        byShape.get(shape).tagged.push(ev);
      } else if (!isManagedBySelf_(ev)) {
        byShape.get(shape).untagged.push(ev);
      }
    }

    const remove = (ev, kind, label) => {
      try {
        deleteEvent_(ev, dryRun);
        deleted++;
      } catch (e) {
        errors++;
        log_(rule.name, 'ERROR', `${kind} delete failed on ${label}: ${(e && e.stack) || e}`);
      }
    };

    // 1. Same tag value means the same source instance, so every copy beyond
    //    the first is a duplicate by definition. This is the exact case.
    byKey.forEach((events, tagValue) => {
      if (events.length < 2) return;
      const finding = {
        kind: 'same-key', rule: rule.name, target: rule.target,
        title: tryTitle_(events[0]), start: events[0].getStartTime().toISOString(),
        removing: events.length - 1, keeping: 1,
      };
      findings.push(finding);
      log_(rule.name, dryRun ? 'INFO' : 'CHANGE', `${dryRun ? '[DRY RUN] ' : ''}GROUP ${JSON.stringify(finding)}`);
      for (let i = 1; i < events.length; i++) remove(events[i], 'duplicate', tagValue);
    });

    // 2. Untagged copies of a shape that also has a tagged event. Inexact, so
    //    it requires a tagged sibling as evidence the copy came from here.
    byShape.forEach((group, shape) => {
      if (!group.tagged.length || !group.untagged.length) return;
      const finding = {
        kind: 'untagged', rule: rule.name, target: rule.target,
        title: tryTitle_(group.untagged[0]), start: group.untagged[0].getStartTime().toISOString(),
        removing: group.untagged.length, keeping: group.tagged.length,
      };
      findings.push(finding);
      log_(rule.name, dryRun ? 'INFO' : 'CHANGE', `${dryRun ? '[DRY RUN] ' : ''}GROUP ${JSON.stringify(finding)}`);
      for (const ev of group.untagged) remove(ev, 'stray', shape);
    });
  }

  const summary = {
    rule: '*', kind: 'SUMMARY', dryRun: !!dryRun,
    elapsedMs: new Date().getTime() - startedAt.getTime(),
    wouldDelete: deleted, errors: errors, groups: findings.length,
  };
  console.log(JSON.stringify(summary));
  return { summary: summary, findings: findings };
}

/* ------------------------- duplicate diagnosis ---------------------- */

/**
 * Read-only diagnosis of duplicate managed events. Writes nothing.
 *
 * cleanupStrays_ reports how many duplicates exist. This reports *why*: for
 * the worst shape-groups it prints every member's tag value, so a group whose
 * members carry different values proves sourceKey_ drifted between runs, and
 * shows which of its three components (source name, event id, start time)
 * changed. It also prints the source keys the engine computes right now for
 * events near that shape, to compare against what is stored.
 */
function diagnoseDuplicates() {
  const MAX_GROUPS = 4;      // worst N groups per rule
  const MAX_MEMBERS = 12;    // members logged per group

  for (const raw of getSyncRules()) {
    const rule = normalizeRule_(raw);
    const tagKey = TAG_PREFIX + rule.name;
    const target = resolveCalendar_(rule.target);
    if (!target) { log_(rule.name, 'WARN', `target not found: ${rule.target}`); continue; }

    const scanStart = new Date();
    scanStart.setDate(scanStart.getDate() - 90);
    const scanEnd = new Date();
    scanEnd.setDate(scanEnd.getDate() + rule.windowDays + 30);

    const groups = new Map();
    for (const ev of target.getEvents(scanStart, scanEnd)) {
      const tagValue = safeGetTag_(ev, tagKey);
      if (!tagValue && !isManagedBySelf_(ev)) continue; // not ours at all
      const shape = [tryTitle_(ev), ev.getStartTime().toISOString(), ev.getEndTime().toISOString()].join('|');
      if (!groups.has(shape)) groups.set(shape, []);
      groups.get(shape).push({ tagValue: tagValue, event: ev });
    }

    const worst = Array.from(groups.entries())
      .filter((entry) => entry[1].length > 1)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, MAX_GROUPS);

    log_(rule.name, 'INFO',
      `DIAGNOSE target=${rule.target} shapes=${groups.size} duplicated=${worst.length}`);

    for (const [shape, members] of worst) {
      const distinct = new Set(members.map((m) => m.tagValue || '<untagged>'));
      log_(rule.name, 'INFO', `SHAPE ${JSON.stringify({
        shape: shape,
        members: members.length,
        distinctTagValues: distinct.size,
        untagged: members.filter((m) => !m.tagValue).length,
      })}`);
      members.slice(0, MAX_MEMBERS).forEach((m, i) => {
        log_(rule.name, 'INFO', `  MEMBER ${i} tag=${m.tagValue || '<untagged>'}`);
      });

      // What would the engine key this shape as today?
      const shapeStart = new Date(shape.split('|')[1]);
      const nearFrom = new Date(shapeStart.getTime() - 26 * 60 * 60 * 1000);
      const nearTo = new Date(shapeStart.getTime() + 26 * 60 * 60 * 1000);
      for (const srcId of rule.sources) {
        const cal = resolveCalendar_(srcId);
        if (!cal) continue;
        for (const ev of cal.getEvents(nearFrom, nearTo)) {
          log_(rule.name, 'INFO',
            `  LIVEKEY ${sourceKey_({ srcId: srcId, event: ev })} title="${tryTitle_(ev)}"`);
        }
      }
    }
  }
  return 'see execution log';
}
