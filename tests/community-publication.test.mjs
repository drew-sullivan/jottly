import assert from "node:assert/strict";
import test from "node:test";
import { onRequestGet } from "../functions/api/community/v1/catalog.js";
import { onRequestGet as onRequestHealth } from "../functions/api/community/v1/health.js";
import { communitySchemaSQL, ensureCommunitySchema, publishCommunityCatalog } from "../functions/api/community/v1/schema.js";
import { featuredPool } from "./community-fixtures.mjs";

const asOf = Date.parse("2026-09-08T12:00:00Z");

test("validated snapshots publish atomically and older runs cannot overwrite newer ones", async () => {
  const db = new CatalogDB();
  const current = snapshot(asOf);
  assert.equal((await publishCommunityCatalog(db, current)).published, true);
  const stored = structuredClone(db.row);
  assert.equal((await publishCommunityCatalog(db, snapshot(asOf - 1))).published, false);
  assert.deepEqual(db.row, stored);
  assert.equal((await publishCommunityCatalog(db, snapshot(asOf + 1))).published, true);
  assert.equal(db.row.generated_at_ms, asOf + 1);
});

test("invalid or empty snapshots are rejected before D1 mutation", async () => {
  const db = new CatalogDB();
  const invalid = snapshot(asOf);
  invalid.games = [];
  await assert.rejects(publishCommunityCatalog(db, invalid), /Invalid community catalog/);
  assert.equal(db.writeCount, 0);
  assert.equal(db.row, null);
});

test("GET serves exact bytes with ETag caching and 304 support", async () => {
  const db = new CatalogDB();
  const publication = await publishCommunityCatalog(db, snapshot(asOf));
  const response = await onRequestGet({ request: request(), env: { COMMUNITY_DB: db } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), publication.payload);
  assert.equal(response.headers.get("etag"), `"${publication.hash}"`);
  assert.equal(response.headers.get("cache-control"), "public, max-age=3600, stale-while-revalidate=86400");
  assert.equal(response.headers.get("x-jottly-catalog-generated-at"), String(asOf));
  assert.equal(response.headers.get("vary"), "X-Jottly-Catalog-Bucket");
  const unchanged = await onRequestGet({ request: request(`"${publication.hash}"`), env: { COMMUNITY_DB: db } });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), "");
});

test("runtime kill switch and deterministic rollout never touch D1", async () => {
  const db = new CatalogDB();
  await publishCommunityCatalog(db, snapshot(asOf));
  const before = db.writeCount;
  const disabled = await onRequestGet({
    request: request(null, 0),
    env: { COMMUNITY_DB: db, COMMUNITY_CATALOG_ENABLED: "false" },
  });
  assert.equal(disabled.status, 410);
  const excluded = await onRequestGet({
    request: request(null, 75),
    env: { COMMUNITY_DB: db, COMMUNITY_CATALOG_ROLLOUT_PERCENTAGE: "50" },
  });
  assert.equal(excluded.status, 204);
  const included = await onRequestGet({
    request: request(null, 49),
    env: { COMMUNITY_DB: db, COMMUNITY_CATALOG_ROLLOUT_PERCENTAGE: "50" },
  });
  assert.equal(included.status, 200);
  assert.equal(db.writeCount, before);
});

test("invalid rollout configuration and buckets fail closed", async () => {
  const db = new CatalogDB();
  await publishCommunityCatalog(db, snapshot(asOf));
  assert.equal((await onRequestGet({
    request: request(), env: { COMMUNITY_DB: db, COMMUNITY_CATALOG_ROLLOUT_PERCENTAGE: "101" },
  })).status, 503);
  assert.equal((await onRequestGet({
    request: request(null, "wat"), env: { COMMUNITY_DB: db },
  })).status, 400);
});

test("health endpoint reports healthy, stale, missing, and invalid snapshots", async () => {
  const healthy = new CatalogDB();
  await publishCommunityCatalog(healthy, snapshot(asOf));
  let response = await onRequestHealth({ env: { COMMUNITY_DB: healthy }, nowMilliseconds: asOf + 35 * 3_600_000 });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "healthy", generatedAtUnixMilliseconds: asOf,
    ageMilliseconds: 35 * 3_600_000, entryCount: 5,
  });
  response = await onRequestHealth({ env: { COMMUNITY_DB: healthy }, nowMilliseconds: asOf + 37 * 3_600_000 });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, "stale");
  assert.equal((await onRequestHealth({ env: { COMMUNITY_DB: new CatalogDB() }, nowMilliseconds: asOf })).status, 503);
  healthy.row.payload_json = "not-json";
  response = await onRequestHealth({ env: { COMMUNITY_DB: healthy }, nowMilliseconds: asOf });
  assert.equal((await response.json()).status, "invalid");
});

test("missing binding or first snapshot returns an uncached 503", async () => {
  for (const env of [{}, { COMMUNITY_DB: new CatalogDB() }]) {
    const response = await onRequestGet({ request: request(), env });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("D1 read failures degrade to the same uncached service response", async () => {
  const response = await onRequestGet({
    request: request(),
    env: { COMMUNITY_DB: new FaultingCatalogDB() },
  });

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("community executable schema matches its migration", async () => {
  const { readFile } = await import("node:fs/promises");
  const migrations = await Promise.all([
    "../migrations/0002_community_catalog.sql",
    "../migrations/0004_community_catalog_runs.sql",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  assert.equal(normalizeSQL(communitySchemaSQL), normalizeSQL(migrations.join("\n")));
});

test("concurrent schema checks coalesce and failed initialization retries", async () => {
  const db = new DeferredSchemaDB();
  const first = ensureCommunitySchema(db);
  const second = ensureCommunitySchema(db);
  assert.equal(db.calls, 2);
  db.resolve();
  await Promise.all([first, second]);

  const retry = new DeferredSchemaDB();
  const failed = ensureCommunitySchema(retry);
  retry.reject(new Error("D1 down"));
  await assert.rejects(failed, /D1 down/);
  const recovered = ensureCommunitySchema(retry);
  assert.equal(retry.calls, 4);
  retry.resolve();
  await recovered;
});

function snapshot(generatedAt) {
  return {
    schemaVersion: 1,
    generatedAtUnixMilliseconds: generatedAt,
    weeklyWindowStartsAtUnixMilliseconds: generatedAt - 7 * 86_400_000,
    fallbackWindowStartsAtUnixMilliseconds: generatedAt - 28 * 86_400_000,
    catalogKind: "mixed",
    games: featuredPool().map((sourcePackage, index) => ({ rank: index + 1, selectionSource: "featured", sourcePackage })),
  };
}

function request(etag, bucket) {
  const headers = {};
  if (etag) headers["if-none-match"] = etag;
  if (bucket !== undefined && bucket !== null) headers["x-jottly-catalog-bucket"] = String(bucket);
  return new Request("https://icedmatchalabs.com/api/community/v1/games", {
    headers,
  });
}

function normalizeSQL(sql) { return sql.replace(/\s+/g, " ").trim().replace(/;$/, ""); }

class CatalogDB {
  constructor() { this.row = null; this.writeCount = 0; this.schemaInitialized = false; }
  prepare(sql) {
    return {
      sql,
      run: async () => { this.schemaInitialized = true; return { meta: { changes: 0 } }; },
      bind: (...values) => ({
        run: async () => {
          this.writeCount += 1;
          const [generated, hash, payload] = values;
          if (this.row && generated <= this.row.generated_at_ms) return { meta: { changes: 0 } };
          this.row = { generated_at_ms: generated, payload_sha256: hash, payload_json: payload };
          return { meta: { changes: 1 } };
        },
      }),
      first: async () => this.row,
    };
  }
}

class DeferredSchemaDB {
  constructor() { this.calls = 0; this.pending = []; }
  prepare() {
    return { run: () => {
      this.calls += 1;
      return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
    } };
  }
  resolve() {
    const pending = this.pending.splice(0);
    pending.forEach(({ resolve }) => resolve({ meta: { changes: 0 } }));
  }
  reject(error) {
    const pending = this.pending.splice(0);
    pending.forEach(({ reject }) => reject(error));
  }
}

class FaultingCatalogDB {
  prepare() {
    return {
      run: async () => { throw new Error("D1 unavailable"); },
      first: async () => { throw new Error("D1 unavailable"); },
    };
  }
}
