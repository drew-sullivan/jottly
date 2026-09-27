import { validateAutomaticReport, receiveAutomatic, expireAutomaticDiagnostics } from "./reliability.js";
import { ensureDevReportSchema } from "./schema.js";

const maximumBodyBytes = 128 * 1024;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses = new Set(["new", "in_progress", "needs_info", "fixed"]);
const transitions = {
  new: new Set(["in_progress"]),
  in_progress: new Set(["needs_info", "fixed"]),
  needs_info: new Set(["in_progress"]),
  fixed: new Set(),
};

export async function onRequestPost({ request, env, nowMilliseconds = Date.now() }) {
  const body = await readJSON(request);
  if (body instanceof Response) return body;
  if (!(body?.automatic !== undefined ? await validateAutomaticReport(body) : validReport(body))) return json({ error: "Invalid report" }, 400);
  if (!env.COMMUNITY_DB) return json({ error: "Report inbox unavailable" }, 503);

  try {
    await ensureDevReportSchema(env.COMMUNITY_DB);
    const db = env.COMMUNITY_DB;
    await expireAutomaticDiagnostics(db, nowMilliseconds);
    if (body.automatic !== undefined) return await receiveAutomatic(body, db, nowMilliseconds);
    const fingerprint = await submissionFingerprint(body);
    const inserted = await db.prepare(`
      INSERT OR IGNORE INTO dev_reports (
        id, kind, title, description, diagnostics, app_version, build_number,
        created_at_ms, updated_at_ms, submission_fingerprint, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
    `).bind(
      body.id, body.kind, reportTitle(body), body.description.trim(), body.diagnostics,
      body.appVersion, body.buildNumber, nowMilliseconds, nowMilliseconds, fingerprint,
    ).run();
    const row = await readReport(db, body.id);
    if (Number(inserted?.meta?.changes ?? 0) === 0 && !sameSubmission(row, body, fingerprint)) {
      return json({ error: "Report ID already belongs to a different submission" }, 409);
    }
    return json(project(row, false), Number(inserted?.meta?.changes ?? 0) === 1 ? 201 : 200);
  } catch {
    return json({ error: "Report inbox unavailable" }, 503);
  }
}

export async function onRequestGet({ request, env }) {
  if (!authorized(request, env)) return notFound();
  if (!env.COMMUNITY_DB) return json({ error: "Report inbox unavailable" }, 503);
  const status = new URL(request.url).searchParams.get("status") ?? "new";
  if (status !== "all" && !statuses.has(status)) return json({ error: "Invalid status" }, 400);
  try {
    await ensureDevReportSchema(env.COMMUNITY_DB);
    await expireAutomaticDiagnostics(env.COMMUNITY_DB);
    const statement = status === "all"
      ? env.COMMUNITY_DB.prepare("SELECT * FROM (SELECT rowid AS ticket_number, *, ROW_NUMBER() OVER (PARTITION BY (automatic_summary IS NOT NULL) ORDER BY created_at_ms DESC, rowid DESC) AS source_rank FROM dev_reports) ORDER BY (source_rank > 25), (automatic_summary IS NOT NULL), created_at_ms DESC, ticket_number DESC LIMIT 50")
      : env.COMMUNITY_DB.prepare("SELECT * FROM (SELECT rowid AS ticket_number, *, ROW_NUMBER() OVER (PARTITION BY (automatic_summary IS NOT NULL) ORDER BY created_at_ms DESC, rowid DESC) AS source_rank FROM dev_reports WHERE status = ?) ORDER BY (source_rank > 25), (automatic_summary IS NOT NULL), created_at_ms DESC, ticket_number DESC LIMIT 50").bind(status);
    const result = await statement.all();
    return json({ reports: (result.results ?? []).map((row) => project(row, false)) }, 200);
  } catch {
    return json({ error: "Report inbox unavailable" }, 503);
  }
}

export async function onRequestHealth({ env }) {
  if (!env.COMMUNITY_DB) return json({ error: "Report inbox unavailable" }, 503);
  try {
    await ensureDevReportSchema(env.COMMUNITY_DB);
    await env.COMMUNITY_DB.prepare("SELECT submission_fingerprint FROM dev_reports LIMIT 1").first();
    return json({ status: "ok", schemaVersion: 2, queueAccess: "private", submissionIdentityVersion: 1, automaticReliabilityVersion: 1 }, 200);
  } catch {
    return json({ error: "Report inbox unavailable" }, 503);
  }
}

export async function onRequestGetOne({ request, env, id }) {
  if (!authorized(request, env)) return notFound();
  if (!idPattern.test(id)) return json({ error: "Invalid report ID" }, 400);
  if (!env.COMMUNITY_DB) return json({ error: "Report inbox unavailable" }, 503);
  try {
    await ensureDevReportSchema(env.COMMUNITY_DB);
    await expireAutomaticDiagnostics(env.COMMUNITY_DB);
    const row = await readReport(env.COMMUNITY_DB, id);
    return row ? json(project(row), 200) : json({ error: "Report not found" }, 404);
  } catch {
    return json({ error: "Report inbox unavailable" }, 503);
  }
}

export async function onRequestPatch({ request, env, id, nowMilliseconds = Date.now() }) {
  if (!authorized(request, env)) return notFound();
  if (!idPattern.test(id)) return json({ error: "Invalid report ID" }, 400);
  const body = await readJSON(request);
  if (body instanceof Response) return body;
  if (!plainObject(body)
      || !statuses.has(body.expectedStatus)
      || !statuses.has(body.status)
      || !transitions[body.expectedStatus].has(body.status)
      || (body.title !== undefined && !validTitle(body.title))
      || typeof body.resolution !== "string"
      || body.resolution.length > 2000
      || (body.status === "fixed" && body.resolution.trim().length < 3)) {
    return json({ error: "Invalid status update" }, 400);
  }
  if (!env.COMMUNITY_DB) return json({ error: "Report inbox unavailable" }, 503);

  try {
    await ensureDevReportSchema(env.COMMUNITY_DB);
    const db = env.COMMUNITY_DB;
    const updated = await db.prepare(`
      UPDATE dev_reports SET status = ?, resolution = ?, title = COALESCE(?, title), updated_at_ms = ?,
        diagnostics = CASE WHEN ? = 'fixed' THEN '' ELSE diagnostics END
      WHERE id = ? AND status = ?
    `).bind(
      body.status,
      body.resolution.trim(),
      body.title === undefined ? null : body.title.trim(),
      nowMilliseconds,
      body.status,
      id,
      body.expectedStatus,
    ).run();
    if (Number(updated?.meta?.changes ?? 0) < 1) {
      const current = await readReport(db, id);
      return current ? json({ error: "Report status changed", current: project(current, false) }, 409)
        : json({ error: "Report not found" }, 404);
    }
    return json(project(await readReport(db, id), false), 200);
  } catch {
    return json({ error: "Report inbox unavailable" }, 503);
  }
}

export async function onRequestDelete({ request, env, id }) {
  if (!authorized(request, env)) return notFound();
  if (!idPattern.test(id)) return json({ error: "Invalid report ID" }, 400);
  if (!env.COMMUNITY_DB) return json({ error: "Report inbox unavailable" }, 503);
  try {
    await ensureDevReportSchema(env.COMMUNITY_DB);
    const deleted = await env.COMMUNITY_DB.prepare(
      "DELETE FROM dev_reports WHERE id = ?"
    ).bind(id).run();
    if (Number(deleted?.meta?.changes ?? 0) < 1) {
      return json({ error: "Report not found" }, 404);
    }
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch {
    return json({ error: "Report inbox unavailable" }, 503);
  }
}

async function readReport(db, id) {
  return db.prepare("SELECT rowid AS ticket_number, * FROM dev_reports WHERE id = ?").bind(id).first();
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
    && (body.title === undefined || validTitle(body.title))
    && typeof body.diagnostics === "string"
    && body.diagnostics.length <= 100_000
    && typeof body.appVersion === "string"
    && body.appVersion.length <= 40
    && typeof body.buildNumber === "string"
    && body.buildNumber.length <= 40;
}

async function submissionFingerprint(body) {
  // Stable normalized input, independent of JSON property ordering and later staff edits.
  // Retain only a digest so clearing diagnostics on closure still removes their raw text.
  const canonical = JSON.stringify([
    1, body.kind, reportTitle(body), body.description.trim(), body.diagnostics,
    body.appVersion, body.buildNumber,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return "v1:" + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameSubmission(row, body, fingerprint) {
  if (row?.submission_fingerprint != null) return row.submission_fingerprint === fingerprint;
  // Pre-migration rows have no original-title provenance, and closed rows have already
  // erased diagnostics. Compare every immutable field still available, without inventing
  // an original title from a staff-edited display title. Never rewrite the retained ticket
  // or bind its unknown historical identity to whichever retry arrives first.
  return row?.kind === body.kind
    && row.description === body.description.trim()
    && (row.status === "fixed" || row.diagnostics === body.diagnostics)
    && row.app_version === body.appVersion
    && row.build_number === body.buildNumber;
}

function project(row, includeDiagnostics = true) {
  const automatic = row.automatic_summary ? { automatic: JSON.parse(row.automatic_summary) } : {};
  if (row.status === "fixed") {
    return {
      id: row.id,
      ticketNumber: row.ticket_number,
      ...automatic,
      title: row.title,
      description: row.description,
      createdAtMilliseconds: row.created_at_ms,
      status: row.status,
      resolution: row.resolution,
    };
  }
  const report = {
    id: row.id,
    ticketNumber: row.ticket_number,
      ...automatic,
    kind: row.kind,
    title: row.title,
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

function validTitle(value) {
  return typeof value === "string" && value.trim().length >= 3 && value.trim().length <= 120;
}

function reportTitle(body) {
  if (validTitle(body.title)) return body.title.trim();
  const normalized = body.description.trim().replaceAll(/\s+/g, " ");
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 119)}…`;
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function authorized(request, env) {
  const token = env.ANALYTICS_REPORT_TOKEN;
  return typeof token === "string" && token.length > 0
    && request.headers.get("authorization") === `Bearer ${token}`;
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
