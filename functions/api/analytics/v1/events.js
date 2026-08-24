import { validatePayload } from "./contract.js";

const maximumBodyBytes = 64 * 1024;

export async function onRequestPost(context) {
  const length = Number(context.request.headers.get("content-length") || 0);
  if (length > maximumBodyBytes) return json({ error: "Payload too large" }, 413);
  if (!context.request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json" }, 415);
  }

  let body;
  try {
    const text = await context.request.text();
    if (new TextEncoder().encode(text).byteLength > maximumBodyBytes) return json({ error: "Payload too large" }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const validation = validatePayload(body);
  if (!validation.ok) return json({ error: validation.error }, 400);
  if (context.request.headers.get("x-jottly-validate-only") === "1") return json({ accepted: validation.entries.length }, 200);
  if (!context.env.ANALYTICS_DB) return json({ error: "Analytics unavailable" }, 503);

  const statement = context.env.ANALYTICS_DB.prepare(`
    INSERT OR IGNORE INTO anonymous_analytics_events (
      entry_id, day, category, event, app_version, release_channel, mode,
      game_source, share_source, share_channel, turn_bucket, duration_bucket,
      outcome, performance_bucket, reliability_reason, aggregate_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  await context.env.ANALYTICS_DB.batch(validation.entries.map((entry) => statement.bind(
    entry.entry_id, entry.day, entry.category, entry.event, entry.app_version,
    entry.release_channel, entry.mode ?? null, entry.game_source ?? null,
    entry.share_source ?? null, entry.share_channel ?? null, entry.turn_bucket ?? null,
    entry.duration_bucket ?? null, entry.outcome ?? null, entry.performance_bucket ?? null,
    entry.reliability_reason ?? null, entry.count
  )));
  return json({ accepted: validation.entries.length }, 200);
}

function json(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
