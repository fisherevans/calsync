/**
 * Modes.js — turns a source event into the desired target shape.
 *
 * A "desired" object is what the engine converges the target event to:
 *   { title, start, end, location, description, color, visibility, removeReminders }
 *
 * Nothing here writes to Calendar; it is pure shaping so it is trivial to
 * reason about and would be easy to unit-test if Apps Script had a test
 * harness.
 */

/** @returns {Desired} */
function buildDesired_(rule, event) {
  return rule.mode === 'mask'
    ? buildMaskDesired_(rule, event)
    : buildMirrorDesired_(rule, event);
}

/** mask: opaque busy-block, padded by the buffer, no leaked details. */
function buildMaskDesired_(rule, event) {
  const bufMs = rule.bufferMinutes * 60000;
  return {
    title: rule.maskTitle,
    start: new Date(event.getStartTime().getTime() - bufMs),
    end: new Date(event.getEndTime().getTime() + bufMs),
    location: '',
    description: '', // truly masked — no personal title/notes on the work calendar
    color: rule.color,
    visibility: rule.visibility, // PRIVATE by default
    removeReminders: rule.removeReminders,
  };
}

/** mirror: copy the title (with pending prefix), optional room + matched URL. */
function buildMirrorDesired_(rule, event) {
  return {
    title: mirrorTitle_(rule, event),
    start: event.getStartTime(),
    end: event.getEndTime(),
    location: rule.copyLocation ? stripUrls_(event.getLocation()) : '',
    description: rule.extractUrlRegex ? (extractMatchingUrl_(event, rule.extractUrlRegex) || '') : '',
    color: rule.color,
    visibility: rule.visibility,
    removeReminders: false,
  };
}

function mirrorTitle_(rule, event) {
  const title = event.getTitle() || '(no title)';
  const status = safeStatus_(event);
  if (status === CalendarApp.GuestStatus.INVITED) return rule.pendingPrefixes.invited + title;
  if (status === CalendarApp.GuestStatus.MAYBE) return rule.pendingPrefixes.maybe + title;
  return title;
}

const URL_PATTERN = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;

/** Room name with URLs and trailing punctuation stripped. */
function stripUrls_(location) {
  return (location || '').replace(URL_PATTERN, '').trim().replace(/[,;]+$/, '').trim();
}

/** First URL matching the rule's regex, searched in location then description. */
function extractMatchingUrl_(event, urlRegex) {
  const re = new RegExp(urlRegex);
  for (const src of [event.getLocation(), event.getDescription()]) {
    if (!src) continue;
    const urls = src.match(URL_PATTERN);
    if (!urls) continue;
    for (const u of urls) if (re.test(u)) return u;
  }
  return null;
}
