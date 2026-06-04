/**
 * Types.js — JSDoc typedefs shared across the engine. Comment-only: defines no
 * runtime values, so clasp pushing it to Apps Script is harmless. It exists so
 * `npm run typecheck` can resolve the {Rule} / {Desired} references the other
 * files use. The authoritative field list still lives in RULE_DEFAULTS
 * (Config.example.js) and the Modes.js shaping functions.
 */

/**
 * One source→target sync, as authored in getSyncRules(). Fields not set on a
 * rule fall back to RULE_DEFAULTS.
 *
 * @typedef {Object} Rule
 * @property {string} name              unique; also the tag suffix (calsync:<name>)
 * @property {'mask'|'mirror'} mode
 * @property {boolean} [enabled]
 * @property {string[]} [sources]       CALENDARS names (or raw ids / 'primary')
 * @property {string} [source]          legacy single-source form; normalized into sources
 * @property {string} target            CALENDARS name (or raw id / 'primary')
 * @property {number} [windowDays]      look-ahead window
 *
 * @property {boolean} [includeDeclined]
 * @property {boolean} [includePending]
 * @property {boolean} [includeAllDay]
 * @property {boolean} [includeMultiDay]
 * @property {boolean} [includeWeekends]
 * @property {boolean} [onlyDefaultEventType]
 * @property {string[]} [excludeTitles] substrings; matching source titles are skipped
 * @property {number} [minDurationMinutes]
 *
 * @property {string} [maskTitle]       mask: fixed title for every block
 * @property {number} [bufferMinutes]   mask: pad start/end by this much
 * @property {*} [color]                CalendarApp.EventColor, or null
 * @property {*} [visibility]           CalendarApp.Visibility
 * @property {boolean} [removeReminders]
 *
 * @property {boolean} [copyLocation]   mirror: copy room name (URLs stripped)
 * @property {?string} [extractUrlRegex] mirror: pull a matching join link into the description
 * @property {{invited: string, maybe: string}} [pendingPrefixes]
 */

/**
 * The shape the engine converges a target event to. Produced by Modes.js,
 * consumed by Engine.js (createManaged_ / applyDesired_ / diffEvent_).
 *
 * @typedef {Object} Desired
 * @property {string} title
 * @property {Date} start
 * @property {Date} end
 * @property {string} location
 * @property {string} description
 * @property {*} color                  CalendarApp.EventColor, or null
 * @property {*} visibility             CalendarApp.Visibility, or null
 * @property {boolean} removeReminders
 */
