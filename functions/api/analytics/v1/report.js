import { ensureAnalyticsSchema } from "./schema.js";

export async function onRequestGet(context) {
  const token = context.env.ANALYTICS_REPORT_TOKEN;
  const supplied = context.request.headers.get("authorization");
  if (!token || supplied !== `Bearer ${token}`) return new Response("Not found", { status: 404 });
  if (!context.env.ANALYTICS_DB) return json({ error: "Analytics unavailable" }, 503);
  await ensureAnalyticsSchema(context.env.ANALYTICS_DB);

  const url = new URL(context.request.url);
  const requestedDays = Number(url.searchParams.get("days") || 30);
  const days = Number.isFinite(requestedDays)
    ? Math.min(90, Math.max(1, Math.trunc(requestedDays)))
    : 30;
  const result = await context.env.ANALYTICS_DB.prepare(`
    SELECT day, category, event, app_version, release_channel, mode, game_source,
           game_kind, game_slug, word_length, rule_id,
           share_source, share_channel, turn_bucket, duration_bucket, outcome,
           performance_bucket, reliability_reason, community_selection_source,
           context, reason, install_cohort,
           SUM(aggregate_count) AS count
    FROM anonymous_analytics_events_v6
    WHERE day >= date('now', ?)
    GROUP BY day, category, event, app_version, release_channel, mode, game_source,
             game_kind, game_slug, word_length, rule_id,
             share_source, share_channel, turn_bucket, duration_bucket, outcome,
             performance_bucket, reliability_reason, community_selection_source,
             context, reason, install_cohort
    ORDER BY day DESC, event ASC
  `).bind(`-${days - 1} days`).all();
  const candidates = await context.env.ANALYTICS_DB.prepare(`
    SELECT definition_digest, contract_json, COUNT(*) AS anonymous_install_count,
           MIN(received_at) AS first_received_at, MAX(received_at) AS last_received_at
    FROM loved_game_candidates
    GROUP BY definition_digest, contract_json
    ORDER BY anonymous_install_count DESC, last_received_at DESC, definition_digest ASC
    LIMIT 100
  `).all();
  return json({
    days,
    rows: result.results ?? [],
    lovedGameCandidates: (candidates.results ?? []).map((candidate) => {
      const storedPayload = JSON.parse(candidate.contract_json);
      const gamePackage = storedPayload?.presentation && storedPayload?.contract
        ? storedPayload
        : null;
      return {
        definitionDigest: candidate.definition_digest,
        anonymousSubmissionCount: Number(candidate.anonymous_install_count),
        firstReceivedAt: candidate.first_received_at,
        lastReceivedAt: candidate.last_received_at,
        package: gamePackage,
        contract: gamePackage?.contract ?? storedPayload,
      };
    }),
  }, 200);
}

function json(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
