import { sha256Hex, validateCommunityCatalogSnapshot } from "./contract.js";

export const communityCatalogSchemaSQL = `CREATE TABLE IF NOT EXISTS community_catalog_current (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  generated_at_ms INTEGER NOT NULL,
  payload_sha256 TEXT NOT NULL,
  payload_json TEXT NOT NULL
);`;

export const communityRunSchemaSQL = `CREATE TABLE IF NOT EXISTS community_catalog_runs (
  operation_id TEXT PRIMARY KEY,
  scheduled_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'succeeded', 'failed')),
  summary_json TEXT,
  error_code TEXT
);`;

export const communitySchemaSQL = `${communityCatalogSchemaSQL}\n${communityRunSchemaSQL}`;

const schemaPromises = new WeakMap();

export async function ensureCommunitySchema(db) {
  let promise = schemaPromises.get(db);
  if (!promise) {
    promise = Promise.all([
      db.prepare(communityCatalogSchemaSQL).run(),
      db.prepare(communityRunSchemaSQL).run(),
    ]);
    schemaPromises.set(db, promise);
    promise.catch(() => {
      if (schemaPromises.get(db) === promise) schemaPromises.delete(db);
    });
  }
  await promise;
}

export async function beginCommunityCatalogRun(db, {
  operationID,
  scheduledAtMilliseconds,
  startedAtMilliseconds,
}) {
  await ensureCommunitySchema(db);
  const result = await db.prepare(`
    INSERT OR IGNORE INTO community_catalog_runs (
      operation_id, scheduled_at_ms, started_at_ms, status
    ) VALUES (?, ?, ?, 'in_progress')
  `).bind(operationID, scheduledAtMilliseconds, startedAtMilliseconds).run();
  return Number(result?.meta?.changes ?? 0) === 1;
}

export async function completeCommunityCatalogRun(db, {
  operationID,
  finishedAtMilliseconds,
  summary,
}) {
  await ensureCommunitySchema(db);
  await db.prepare(`
    UPDATE community_catalog_runs
    SET finished_at_ms = ?, status = 'succeeded', summary_json = ?, error_code = NULL
    WHERE operation_id = ? AND status = 'in_progress'
  `).bind(finishedAtMilliseconds, JSON.stringify(summary), operationID).run();
}

export async function failCommunityCatalogRun(db, {
  operationID,
  finishedAtMilliseconds,
  errorCode,
}) {
  await ensureCommunitySchema(db);
  await db.prepare(`
    UPDATE community_catalog_runs
    SET finished_at_ms = ?, status = 'failed', error_code = ?
    WHERE operation_id = ? AND status = 'in_progress'
  `).bind(finishedAtMilliseconds, errorCode, operationID).run();
}

export async function readCommunityCatalogRun(db, operationID) {
  await ensureCommunitySchema(db);
  return db.prepare(`
    SELECT operation_id, scheduled_at_ms, started_at_ms, finished_at_ms,
           status, summary_json, error_code
    FROM community_catalog_runs
    WHERE operation_id = ?
  `).bind(operationID).first();
}

export async function listRecentCommunityCatalogRuns(db, limit = 20) {
  await ensureCommunitySchema(db);
  const safeLimit = Number.isInteger(limit) ? Math.min(50, Math.max(1, limit)) : 20;
  const result = await db.prepare(`
    SELECT operation_id, scheduled_at_ms, started_at_ms, finished_at_ms,
           status, summary_json, error_code
    FROM community_catalog_runs
    ORDER BY started_at_ms DESC, operation_id DESC
    LIMIT ?
  `).bind(safeLimit).all();
  return Array.isArray(result?.results) ? result.results : [];
}

export async function publishCommunityCatalog(db, snapshot) {
  const validation = validateCommunityCatalogSnapshot(snapshot);
  if (!validation.ok) throw new Error(`Invalid community catalog: ${validation.error}`);
  const payload = validation.payload;
  const hash = await sha256Hex(payload);
  await ensureCommunitySchema(db);
  const result = await db.prepare(`
    INSERT INTO community_catalog_current (
      singleton_id, generated_at_ms, payload_sha256, payload_json
    ) VALUES (1, ?, ?, ?)
    ON CONFLICT(singleton_id) DO UPDATE SET
      generated_at_ms = excluded.generated_at_ms,
      payload_sha256 = excluded.payload_sha256,
      payload_json = excluded.payload_json
    WHERE excluded.generated_at_ms > community_catalog_current.generated_at_ms
  `).bind(snapshot.generatedAtUnixMilliseconds, hash, payload).run();
  return { published: Number(result?.meta?.changes ?? 0) === 1, hash, payload };
}

export async function readCurrentCommunityCatalog(db) {
  await ensureCommunitySchema(db);
  return db.prepare(`
    SELECT generated_at_ms, payload_sha256, payload_json
    FROM community_catalog_current
    WHERE singleton_id = 1
  `).first();
}
