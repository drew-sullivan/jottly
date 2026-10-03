import { readBoundedJSON, admitIntake } from "../../intake.js";
import { validatePayload } from "./contract.js";
import { ensureAnalyticsSchema } from "./schema.js";

const maximumBodyBytes = 64 * 1024;

export async function onRequestPost(context) {
  const body = await readBoundedJSON(context.request, maximumBodyBytes);
  if (body instanceof Response) return body;

  const validation = validatePayload(body);
  if (!validation.ok) return json({ error: validation.error }, 400);
  if (context.request.headers.get("x-jottly-validate-only") === "1") return json({ accepted: validation.entries.length }, 200);
  if (!context.env.ANALYTICS_DB) return json({ error: "Analytics unavailable" }, 503);
  try {
    await ensureAnalyticsSchema(context.env.ANALYTICS_DB);

    const admission = await admitIntake({ request: context.request, env: context.env,
      db: context.env.ANALYTICS_DB, route: "analytics", units: validation.entries.length,
      receipt: validation.entries.map(entry => entry.entry_id).sort().join("|"), now: context.nowMilliseconds ?? Date.now() });
    if (admission) {
      if (admission.status !== 429) return admission;
      const known = await context.env.ANALYTICS_DB.prepare(`SELECT COUNT(*) AS count FROM anonymous_analytics_events_v6
        WHERE entry_id IN (${validation.entries.map(() => "?").join(",")})`)
        .bind(...validation.entries.map(entry => entry.entry_id)).first();
      if (Number(known?.count) !== validation.entries.length) return admission;
    }

    const statement = context.env.ANALYTICS_DB.prepare(`
      INSERT OR IGNORE INTO anonymous_analytics_events_v6 (
        entry_id, day, category, event, app_version, release_channel, mode,
        game_source, game_kind, game_slug, word_length, rule_id, share_source, share_channel, turn_bucket, duration_bucket,
        outcome, performance_bucket, reliability_reason, community_selection_source,
        context, reason, install_cohort, aggregate_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const results = await context.env.ANALYTICS_DB.batch(validation.entries.map((entry) => statement.bind(
      entry.entry_id, entry.day, entry.category, entry.event, entry.app_version,
      entry.release_channel, entry.mode ?? null, entry.game_source ?? null,
      entry.game_kind ?? null, entry.game_slug ?? null, entry.word_length ?? null, entry.rule_id ?? null,
      entry.share_source ?? null, entry.share_channel ?? null, entry.turn_bucket ?? null,
      entry.duration_bucket ?? null, entry.outcome ?? null, entry.performance_bucket ?? null,
      entry.reliability_reason ?? null, entry.community_selection_source ?? null,
      entry.context ?? null, entry.reason ?? null,
      entry.install_cohort ?? null, entry.count
    )));
    if (!Array.isArray(results) || results.length !== validation.entries.length
        || results.some(result => result?.success === false || !Number.isSafeInteger(result?.meta?.changes)
          || result.meta.changes < 0)) throw new Error("Invalid aggregate persistence acknowledgement");
    const inserted = results.reduce((total, result) => total + result.meta.changes, 0);
    return json({ accepted: validation.entries.length, inserted }, 200);
  } catch {
    console.warn(JSON.stringify({ event: "intake.persistence_unavailable", route: "events" }));
    return json({ error: "Analytics unavailable" }, 503);
  }
}

function json(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
