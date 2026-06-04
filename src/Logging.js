/**
 * Logging.js — structured, queryable audit trail.
 *
 * Logger.log only retains the most recent execution. console.log writes to
 * Cloud Logging (Stackdriver), which persists across runs and is filterable
 * by severity and the structured fields below. Every line is one JSON object
 * so you can query e.g. jsonPayload.rule="personal_to_work" AND
 * jsonPayload.kind="CHANGE" in the Cloud Logging console.
 *
 * kinds: INFO (lifecycle), CHANGE (a create/update/delete actually happened),
 * WARN (recoverable, e.g. missing calendar), ERROR (an op threw).
 */

function log_(rule, kind, message) {
  const payload = { rule: rule, kind: kind, message: message };
  if (kind === 'ERROR') console.error(JSON.stringify(payload));
  else if (kind === 'WARN') console.warn(JSON.stringify(payload));
  else console.log(JSON.stringify(payload));
}

function logRunSummary_(results, startedAt, dryRun) {
  const totals = results.reduce((acc, r) => {
    const s = r.stats || {};
    for (const k of ['created', 'updated', 'unchanged', 'skipped', 'deleted', 'errors']) {
      acc[k] = (acc[k] || 0) + (s[k] || 0);
    }
    return acc;
  }, {});
  const elapsedMs = new Date().getTime() - startedAt.getTime();
  console.log(JSON.stringify({
    rule: '*', kind: 'SUMMARY', dryRun: !!dryRun, elapsedMs: elapsedMs,
    rules: results.length, totals: totals,
    perRule: results.map((r) => ({ name: r.name, error: r.error || null, stats: r.stats })),
  }));
}
