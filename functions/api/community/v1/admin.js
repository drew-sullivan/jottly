import { readCurrentCommunityCatalog } from "./schema.js";
import { runCommunitySweep } from "./sweep.js";

const operationIDPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maximumClockSkewMilliseconds = 10 * 60 * 1_000;
const maximumBodyBytes = 1_024;

export async function onRequestPost({ request, env, nowMilliseconds = Date.now() }) {
  if (!(await isAuthorized(request, env.COMMUNITY_ADMIN_TOKEN))) return notFound();
  if (!env.COMMUNITY_DB) return json({ error: "Community catalog unavailable" }, 503);

  const declaredLength = request.headers.get("content-length");
  const contentLength = declaredLength === null ? null : Number(declaredLength);
  if (contentLength !== null
      && (!Number.isFinite(contentLength) || contentLength > maximumBodyBytes)) {
    return json({ error: "Invalid request" }, 400);
  }
  let body;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > maximumBodyBytes) {
      return json({ error: "Invalid request" }, 400);
    }
    body = JSON.parse(text);
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  if (!isPlainObject(body)
      || Object.keys(body).sort().join(",") !== "operationID,scheduledTime") {
    return json({ error: "Invalid request" }, 400);
  }
  const operationID = body?.operationID;
  const scheduledTime = body?.scheduledTime;
  if (!operationIDPattern.test(operationID ?? "")
      || !Number.isSafeInteger(scheduledTime)
      || Math.abs(scheduledTime - nowMilliseconds) > maximumClockSkewMilliseconds) {
    return json({ error: "Invalid request" }, 400);
  }

  try {
    const summary = await runCommunitySweep({ env, asOfMilliseconds: scheduledTime });
    return json({ operationID, ...summary }, 200);
  } catch {
    return json({ operationID, status: "failed" }, 503);
  }
}

export async function onRequestGet({ request, env, nowMilliseconds = Date.now() }) {
  if (!(await isAuthorized(request, env.COMMUNITY_ADMIN_TOKEN))) return notFound();
  if (!env.COMMUNITY_DB) return json({ status: "unavailable" }, 503);
  try {
    const row = await readCurrentCommunityCatalog(env.COMMUNITY_DB);
    if (!row) return json({ status: "missing" }, 503);
    const payload = JSON.parse(row.payload_json);
    return json({
      status: "published",
      generatedAtUnixMilliseconds: row.generated_at_ms,
      ageMilliseconds: Math.max(0, nowMilliseconds - row.generated_at_ms),
      hash: row.payload_sha256,
      catalogKind: payload.catalogKind,
      entryCount: Array.isArray(payload.games) ? payload.games.length : 0,
    }, 200);
  } catch {
    return json({ status: "unavailable" }, 503);
  }
}

async function isAuthorized(request, expectedToken) {
  if (typeof expectedToken !== "string" || expectedToken.length < 32) return false;
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return false;
  const suppliedToken = authorization.slice("Bearer ".length);
  const [suppliedDigest, expectedDigest] = await Promise.all([
    digest(suppliedToken),
    digest(expectedToken),
  ]);
  let difference = 0;
  for (let index = 0; index < suppliedDigest.length; index += 1) {
    difference |= suppliedDigest[index] ^ expectedDigest[index];
  }
  return difference === 0;
}

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function notFound() {
  return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
}

function json(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
