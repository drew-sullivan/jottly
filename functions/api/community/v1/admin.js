import {
  listRecentCommunityCatalogRuns,
  readCommunityCatalogRun,
  readCurrentCommunityCatalog,
} from "./schema.js";
import {
  projectCommunityCatalogRun,
  runTrackedCommunitySweep,
} from "./operations.js";

const operationIDPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const scheduledOperationIDPattern = /^scheduled:[0-9]{10,16}$/;
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
      || !Number.isSafeInteger(scheduledTime)) {
    return json({ error: "Invalid request" }, 400);
  }

  try {
    const existing = await readCommunityCatalogRun(env.COMMUNITY_DB, operationID);
    if (existing) return runResponse(existing, true);
    if (Math.abs(scheduledTime - nowMilliseconds) > maximumClockSkewMilliseconds) {
      return json({ error: "Invalid request" }, 400);
    }
    const result = await runTrackedCommunitySweep({
      env,
      operationID,
      scheduledAtMilliseconds: scheduledTime,
      startedAtMilliseconds: nowMilliseconds,
      source: "manual",
    });
    return runResponse(result.row, result.replayed);
  } catch {
    return json({ operationID, status: "failed" }, 503);
  }
}

export async function onRequestGet({ request, env, nowMilliseconds = Date.now() }) {
  if (!(await isAuthorized(request, env.COMMUNITY_ADMIN_TOKEN))) return notFound();
  if (!env.COMMUNITY_DB) return json({ status: "unavailable" }, 503);
  try {
    const requestedOperationID = new URL(request.url).searchParams.get("operationID");
    if (requestedOperationID !== null) {
      if (!isOperationID(requestedOperationID)) return json({ error: "Invalid request" }, 400);
      const run = await readCommunityCatalogRun(env.COMMUNITY_DB, requestedOperationID);
      return run ? runResponse(run, true) : json({ status: "missing" }, 404);
    }
    const row = await readCurrentCommunityCatalog(env.COMMUNITY_DB);
    if (!row) return json({ status: "missing" }, 503);
    const payload = JSON.parse(row.payload_json);
    const recentRuns = await listRecentCommunityCatalogRuns(env.COMMUNITY_DB);
    return json({
      status: "published",
      generatedAtUnixMilliseconds: row.generated_at_ms,
      ageMilliseconds: Math.max(0, nowMilliseconds - row.generated_at_ms),
      hash: row.payload_sha256,
      catalogKind: payload.catalogKind,
      entryCount: Array.isArray(payload.games) ? payload.games.length : 0,
      recentRuns: recentRuns.map((run) => projectCommunityCatalogRun(run)),
    }, 200);
  } catch {
    return json({ status: "unavailable" }, 503);
  }
}

function runResponse(row, replayed) {
  const projected = projectCommunityCatalogRun(row, { replayed });
  if (!projected) return json({ status: "missing" }, 404);
  if (projected.runStatus === "in_progress") return json(projected, 202);
  if (projected.runStatus === "failed") return json(projected, 503);
  return json(projected, 200);
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

function isOperationID(value) {
  return operationIDPattern.test(value) || scheduledOperationIDPattern.test(value);
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
