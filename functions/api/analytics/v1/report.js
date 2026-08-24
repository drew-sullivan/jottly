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
           share_source, share_channel, turn_bucket, duration_bucket, outcome,
           performance_bucket, reliability_reason, SUM(aggregate_count) AS count
    FROM anonymous_analytics_events
    WHERE day >= date('now', ?)
    GROUP BY day, category, event, app_version, release_channel, mode, game_source,
             share_source, share_channel, turn_bucket, duration_bucket, outcome,
             performance_bucket, reliability_reason
    ORDER BY day DESC, event ASC
  `).bind(`-${days - 1} days`).all();
  return json({ days, rows: result.results ?? [] }, 200);
}

function json(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
