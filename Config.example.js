/**
 * Config.example.js — TEMPLATE. Copy this into src/ as Config.js and edit it:
 *
 *   cp Config.example.js src/Config.js
 *
 * src/Config.js is gitignored (it holds your real calendar ids) and is the
 * file clasp actually pushes. This template lives OUTSIDE src/ on purpose, so
 * clasp never uploads it — if it did, it would redefine the same globals as
 * your real Config.js and the Apps Script project would fail to load.
 *
 * Each entry in getSyncRules() describes one source→target reconciliation. The
 * engine (Engine.js) treats every rule identically: for each event in the
 * source calendar(s) inside the look-ahead window, it maintains exactly one
 * corresponding event in the target calendar, keyed by a stable tag. Add,
 * change, reschedule, or delete a source event and the target follows.
 *
 * Two modes:
 *   - 'mask'   : create an opaque busy-block on the target (e.g. personal →
 *                work). Title is fixed, details are dropped, time is padded by
 *                a buffer. Mark yourself busy without leaking anything.
 *   - 'mirror' : copy the source event's title (and optionally a matched URL +
 *                room) to the target (e.g. work → personal). See your meetings
 *                without logging into the other account.
 *
 * Full field reference is in RULE_DEFAULTS at the bottom and in Modes.js.
 *
 * Access model: the script runs as ONE Google account. That account must own
 * or have the right sharing on every calendar a rule touches — read on every
 * source, and write (needed for tags) on every target. The usual setup is to
 * run as the account that owns the "busy" calendar and share the others into
 * it with "Make changes to events".
 */

/**
 * Calendar registry: human name → calendar id. Rules reference the names, so
 * the long opaque ids live in exactly one place. Use 'primary' for the running
 * account's own default calendar. Find a calendar's id in Google Calendar →
 * Settings → that calendar → "Integrate calendar" → Calendar ID.
 */
const CALENDARS = {
  primary_account: 'primary', // the account this script runs as
  my_personal: 'you@example.com', // a calendar shared into the running account
  shared_family: 'xxxxxxxxxxxxxxxx@group.calendar.google.com',
  meetings_mirror: 'yyyyyyyyyyyyyyyy@group.calendar.google.com',
  oncall_feed: 'zzzzzzzzzzzzzzzz@import.calendar.google.com',
};

/** @returns {Rule[]} active sync rules. sources/target use names from CALENDARS. */
function getSyncRules() {
  return [
    // MASK: personal calendars → the running account's calendar, as opaque
    // "busy" blocks padded by a travel/context-switch buffer.
    {
      name: 'personal_to_primary',
      mode: 'mask',
      enabled: true,
      sources: ['my_personal', 'shared_family'],
      target: 'primary_account',
      windowDays: 42,

      // mask-mode shaping
      maskTitle: 'Busy', // what every block is titled
      bufferMinutes: 20, // pad start/end by this much
      color: CalendarApp.EventColor.YELLOW, // or null for default
      visibility: CalendarApp.Visibility.PRIVATE, // keep details hidden
      removeReminders: true,

      // filters
      includeAllDay: false,
      includeMultiDay: false,
      includeWeekends: false,
      excludeTitles: ['[free]', 'On Call'], // skip source events whose title contains any of these
    },

    // MIRROR: the running account's calendar → a calendar you read elsewhere,
    // copying titles (and an optional matched join-link) so you can see your
    // schedule without signing into this account.
    {
      name: 'primary_to_mirror',
      mode: 'mirror',
      enabled: true,
      sources: ['primary_account'],
      target: 'meetings_mirror',
      windowDays: 21,

      // mirror-mode shaping
      includePending: true, // copy invited/maybe events with an "invited:"/"maybe:" prefix
      copyLocation: true, // copy the room name (URLs stripped out)
      extractUrlRegex: 'example\\.zoom\\.us', // pull a join link matching this into the description; null to skip

      // filters
      includeAllDay: true,
      onlyDefaultEventType: true, // drop working-location / out-of-office / focus-time
      excludeTitles: ['Busy'], // don't re-mirror your own mask blocks (the tag loop-guard also covers this)
    },

    // MIRROR: an external feed (e.g. an on-call schedule import) → a personal
    // calendar. Disable or delete if you don't need it.
    {
      name: 'oncall_to_personal',
      mode: 'mirror',
      enabled: false,
      sources: ['oncall_feed'],
      target: 'my_personal',
      windowDays: 120,

      includePending: true,
      copyLocation: false,
      extractUrlRegex: null,

      includeAllDay: true,
      onlyDefaultEventType: true,
      excludeTitles: [],
    },
  ];
}

/**
 * Defaults merged under every rule. Anything set on a rule wins. Keeping the
 * defaults here means a rule only has to declare what's interesting about it.
 */
const RULE_DEFAULTS = {
  enabled: true,
  windowDays: 30,

  // shared filters
  includeDeclined: false, // include events you've declined
  includePending: false, // include invited/maybe events
  includeAllDay: false,
  includeMultiDay: true,
  includeWeekends: true,
  onlyDefaultEventType: false, // true = only normal events (skip OOO/focus-time/working-location)
  excludeTitles: [], // substrings; a source event whose title contains any is skipped
  minDurationMinutes: 0,

  // mask shaping
  maskTitle: 'Busy',
  bufferMinutes: 0,
  color: null, // a CalendarApp.EventColor, or null
  visibility: CalendarApp.Visibility.PRIVATE,
  removeReminders: true,

  // mirror shaping
  copyLocation: false,
  extractUrlRegex: null,
  pendingPrefixes: { invited: 'invited: ', maybe: 'maybe: ' },
};

/** Global write throttle. Apps Script caps total runtime at 6 min (consumer)
 *  / 30 min (Workspace); a fixed per-write sleep is what blows that budget, so
 *  it is OFF by default and writes instead retry with backoff (see Engine.js).
 *  Set >0 only if you actually observe rate-limit errors. */
const WRITE_THROTTLE_MS = 0;
