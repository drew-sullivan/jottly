import { ensureDevReportSchema } from "./schema.js";

const maximumBodyBytes = 128 * 1024;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses = new Set(["new", "in_progress", "needs_info", "fixed"]);

export async function onRequestPost({ request, env, nowMilliseconds = Date.now() }) {
  const body = await readJSON(request);
  if (body instanceof Response) return body;
  if (!validReport(body)) return json({ error: "Invalid report" }, 400);
  if (!env.COMMUNITY_DB) return json({ error: "Report inbox unavailable" }, 503);

  try {
    await ensureDevReportSchema(env.COMMUNITY_DB);
    const db = env.COMMUNITY_DB;
    const inserted = await db.prepare(`
      INSERT OR IGNORE INTO dev_reports (
        id, kind, description, diagnostics, app_version, build_number,
        created_at_ms, updated_at_ms, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')
    `).bind(
      body.id, body.kind, body.description.trim(), body.diagnostics,
      body.appVersion, body.buildNumber, nowMilliseconds, nowMilliseconds,
    ).run();
    const row = await readReport(db, body.id);
    if (Number(inserted?.meta?.changes ?? 0) === 0 && !sameSubmission(row, body)) {
      return json({ error: "Report ID already belongs to a different submission" }, 409);
    }
    return json(project(row), Number(inserted?.meta?.changes ?? 0) === 1 ? 201 : 200);
  } catch {
    return json({ error: "Report inbox unavailable" }, 503);
  }
}

export async function onRequestGet({ request, env }) {
  if (!env.COMMUNITY_DB) return json({ error: "Report inbox unavailable" }, 503);
  const status = new URL(request.url).searchParams.get("status") ?? "new";
  if (status !== "all" && !statuses.has(status)) return json({ error: "Invalid status" }, 400);
  try {
    await ensureDevReportSchema(env.COMMUNITY_DB);
    const statement = status === "all"
      ? env.COMMUNITY_DB.prepare("SELECT * FROM dev_reports ORDER BY created_at_ms DESC, id DESC LIMIT 50")
      : env.COMMUNITY_DB.prepare("SELECT * FROM dev_reports WHERE status = ? ORDER BY created_at_ms, id LIMIT 50").bind(status);
    const result = await statement.all();
    return json({ reports: (result.results ?? []).map((row) => project(row, false)) }, 200);
  } catch {
    return json({ error: "Report inbox unavailable" }, 503);
  }
}

export async function onRequestGetOne({ env, id }) {
  if (!idPattern.test(id)) return json({ error: "Invalid report ID" }, 400);
  if (!env.COMMUNITY_DB) return json({ error: "Report inbox unavailable" }, 503);
  try {
    await ensureDevReportSchema(env.COMMUNITY_DB);
    const row = await readReport(env.COMMUNITY_DB, id);
    return row ? json(project(row), 200) : json({ error: "Report not found" }, 404);
  } catch {
    return json({ error: "Report inbox unavailable" }, 503);
  }
}

export async function onRequestPatch({ request, env, id, nowMilliseconds = Date.now() }) {
  if (!idPattern.test(id)) return json({ error: "Invalid report ID" }, 400);
  const body = await readJSON(request);
  if (body instanceof Response) return body;
  if (!plainObject(body)
      || !statuses.has(body.expectedStatus)
      || !statuses.has(body.status)
      || body.expectedStatus === body.status
      || typeof body.resolution !== "string"
      || body.resolution.length > 2000) return json({ error: "Invalid status update" }, 400);
  if (!env.COMMUNITY_DB) return json({ error: "Report inbox unavailable" }, 503);

  try {
    await ensureDevReportSchema(env.COMMUNITY_DB);
    const db = env.COMMUNITY_DB;
    const updated = await db.prepare(`
      UPDATE dev_reports SET status = ?, resolution = ?, updated_at_ms = ?
      WHERE id = ? AND status = ?
    `).bind(body.status, body.resolution.trim(), nowMilliseconds, id, body.expectedStatus).run();
    if (Number(updated?.meta?.changes ?? 0) !== 1) {
      const current = await readReport(db, id);
      return current ? json({ error: "Report status changed", current: project(current) }, 409)
        : json({ error: "Report not found" }, 404);
    }
    return json(project(await readReport(db, id)), 200);
  } catch {
    return json({ error: "Report inbox unavailable" }, 503);
  }
}

async function readReport(db, id) {
  return db.prepare("SELECT * FROM dev_reports WHERE id = ?").bind(id).first();
}

async function readJSON(request) {
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > maximumBodyBytes) return json({ error: "Report too large" }, 413);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json" }, 415);
  }
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > maximumBodyBytes) return json({ error: "Report too large" }, 413);
    return JSON.parse(text);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
}

function validReport(body) {
  return plainObject(body)
    && body.schemaVersion === 1
    && idPattern.test(body.id ?? "")
    && ["bug", "feature"].includes(body.kind)
    && typeof body.description === "string"
    && body.description.trim().length >= 3
    && body.description.length <= 1000
    && typeof body.diagnostics === "string"
    && body.diagnostics.length <= 100_000
    && typeof body.appVersion === "string"
    && body.appVersion.length <= 40
    && typeof body.buildNumber === "string"
    && body.buildNumber.length <= 40;
}

function sameSubmission(row, body) {
  return row?.kind === body.kind
    && row.description === body.description.trim()
    && row.diagnostics === body.diagnostics
    && row.app_version === body.appVersion
    && row.build_number === body.buildNumber;
}

function project(row, includeDiagnostics = true) {
  const report = {
    id: row.id,
    kind: row.kind,
    description: row.description,
    appVersion: row.app_version,
    buildNumber: row.build_number,
    createdAtMilliseconds: row.created_at_ms,
    updatedAtMilliseconds: row.updated_at_ms,
    status: row.status,
    resolution: row.resolution,
  };
  if (includeDiagnostics) report.diagnostics = row.diagnostics;
  return report;
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function json(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
