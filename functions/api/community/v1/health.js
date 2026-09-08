import { readCurrentCommunityCatalog } from "./schema.js";

const hour = 3_600_000;

export async function onRequestGet({ env, nowMilliseconds = Date.now() }) {
  if (!env.COMMUNITY_DB) return healthResponse("unavailable", 503);
  let row;
  try {
    row = await readCurrentCommunityCatalog(env.COMMUNITY_DB);
  } catch {
    return healthResponse("unavailable", 503);
  }
  if (!row || !Number.isSafeInteger(row.generated_at_ms)) return healthResponse("missing", 503);
  const staleAfterHours = configuredHours(env.COMMUNITY_CATALOG_STALE_AFTER_HOURS, 36);
  if (staleAfterHours === null) return healthResponse("misconfigured", 503);
  const ageMilliseconds = Math.max(0, nowMilliseconds - row.generated_at_ms);
  let entryCount = null;
  try {
    const payload = JSON.parse(row.payload_json);
    entryCount = Array.isArray(payload.games) ? payload.games.length : null;
  } catch {
    return healthResponse("invalid", 503, { generatedAtUnixMilliseconds: row.generated_at_ms, ageMilliseconds });
  }
  const status = ageMilliseconds > staleAfterHours * hour ? "stale" : "healthy";
  return healthResponse(status, status === "healthy" ? 200 : 503, {
    generatedAtUnixMilliseconds: row.generated_at_ms,
    ageMilliseconds,
    entryCount,
  });
}

function configuredHours(value, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 168 ? parsed : null;
}

function healthResponse(status, httpStatus, details = {}) {
  return new Response(JSON.stringify({ status, ...details }), {
    status: httpStatus,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
