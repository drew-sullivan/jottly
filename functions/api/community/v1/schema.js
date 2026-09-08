import { sha256Hex, validateCommunityCatalogSnapshot } from "./contract.js";

export const communitySchemaSQL = `CREATE TABLE IF NOT EXISTS community_catalog_current (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  generated_at_ms INTEGER NOT NULL,
  payload_sha256 TEXT NOT NULL,
  payload_json TEXT NOT NULL
);`;

const schemaPromises = new WeakMap();

export async function ensureCommunitySchema(db) {
  let promise = schemaPromises.get(db);
  if (!promise) {
    promise = db.prepare(communitySchemaSQL).run();
    schemaPromises.set(db, promise);
    promise.catch(() => {
      if (schemaPromises.get(db) === promise) schemaPromises.delete(db);
    });
  }
  await promise;
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
