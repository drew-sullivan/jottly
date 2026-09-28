import { readCurrentCommunityCatalog } from "./schema.js";

export async function onRequestGet({ request, env }) {
  const availability = catalogAvailability(request, env);
  if (availability) return availability;
  if (!env.COMMUNITY_DB) return unavailable();
  let row;
  try {
    row = await readCurrentCommunityCatalog(env.COMMUNITY_DB);
  } catch {
    return unavailable();
  }
  if (!row) return unavailable();
  const etag = `"${row.payload_sha256}"`;
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
    "x-jottly-catalog-generated-at": String(row.generated_at_ms),
    vary: "X-Jottly-Catalog-Bucket",
    etag,
  };
  if (matchesCurrentRepresentation(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  return new Response(row.payload_json, { status: 200, headers });
}

function catalogAvailability(request, env) {
  if (["0", "false"].includes(String(env.COMMUNITY_CATALOG_ENABLED ?? "true").toLowerCase())) {
    return new Response(null, { status: 410, headers: rolloutHeaders() });
  }
  const rollout = configuredPercentage(env.COMMUNITY_CATALOG_ROLLOUT_PERCENTAGE ?? "100");
  if (rollout === null) return unavailable();
  const rawBucket = request.headers.get("x-jottly-catalog-bucket");
  const bucket = rawBucket === null ? 0 : configuredPercentage(rawBucket, 99);
  if (bucket === null) {
    return new Response(JSON.stringify({ error: "Invalid rollout bucket" }), {
      status: 400,
      headers: { ...rolloutHeaders(), "content-type": "application/json; charset=utf-8" },
    });
  }
  return bucket >= rollout ? new Response(null, { status: 204, headers: rolloutHeaders() }) : null;
}

function configuredPercentage(value, maximum = 100) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : null;
}

function rolloutHeaders() {
  return { "cache-control": "no-store", vary: "X-Jottly-Catalog-Bucket" };
}

function unavailable() {
  return new Response(JSON.stringify({ error: "Community catalog unavailable" }), {
    status: 503,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}


function matchesCurrentRepresentation(value, etag) {
  if (value === null) return false;
  const condition = value.trim();
  if (condition === "*") return true;
  // GET uses weak comparison (RFC 9110 §13.1.2); CDNs weaken tags after compression.
  // Parse complete quoted tags, so a comma inside an opaque tag is not a separator.
  const tag = '(?:W/)?"[\\x21\\x23-\\x7e\\x80-\\xff]*"';
  if (!new RegExp(`^${tag}(?:[ \\t]*,[ \\t]*${tag})*$`).test(condition)) return false;
  return [...condition.matchAll(new RegExp(tag, "g"))].some(([candidate]) => candidate.replace(/^W\//, "") === etag);
}
