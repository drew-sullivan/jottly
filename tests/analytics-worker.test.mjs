import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import worker from "../worker.js";
import { analyticsSchemaSQL, ensureAnalyticsSchema } from "../functions/api/analytics/v1/schema.js";

test("the Worker routes analytics writes and leaves static pages on the asset binding", async () => {
  const db = new FakeDB();
  const assets = new FakeAssets();
  const payload = validPayload();

  const apiResponse = await worker.fetch(request("/api/analytics/v1/events", "POST", payload), {
    ANALYTICS_DB: db,
    ASSETS: assets,
  });
  assert.equal(apiResponse.status, 200);
  assert.deepEqual(await apiResponse.json(), { accepted: 1, inserted: 1 });
  assert.equal(assets.requests.length, 0);

  const pageResponse = await worker.fetch(request("/daily", "GET"), {
    ANALYTICS_DB: db,
    ASSETS: assets,
  });
  assert.equal(pageResponse.status, 200);
  assert.equal(await pageResponse.text(), "asset:/daily");
  assert.equal(assets.requests.length, 1);
});

test("unknown API routes and wrong methods fail closed instead of serving assets", async () => {
  const assets = new FakeAssets();
  const env = { ANALYTICS_DB: new FakeDB(), ASSETS: assets };

  const unknown = await worker.fetch(request("/api/not-real", "GET"), env);
  assert.equal(unknown.status, 404);
  const wrongMethod = await worker.fetch(request("/api/analytics/v1/events", "GET"), env);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
  assert.equal(assets.requests.length, 0);
});

test("concurrent schema checks share one operation and a failed bootstrap can retry", async () => {
  const db = new DeferredSchemaDB();
  const first = ensureAnalyticsSchema(db);
  const second = ensureAnalyticsSchema(db);
  assert.equal(db.calls, 1);
  db.resolve();
  await Promise.all([first, second]);

  const retryDB = new DeferredSchemaDB();
  const failure = ensureAnalyticsSchema(retryDB);
  retryDB.reject(new Error("temporary D1 failure"));
  await assert.rejects(failure, /temporary D1 failure/);
  const retry = ensureAnalyticsSchema(retryDB);
  assert.equal(retryDB.calls, 2);
  retryDB.resolve();
  await retry;
});

test("the executable schema and migration cannot drift", async () => {
  const migration = await readFile(new URL("../migrations/0001_anonymous_analytics.sql", import.meta.url), "utf8");
  assert.equal(normalizeSQL(analyticsSchemaSQL), normalizeSQL(migration));
});

test("Wrangler keeps static assets fast and provisions the anonymous D1 binding", async () => {
  const raw = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const config = JSON.parse(raw);
  assert.equal(config.name, "jottly");
  assert.equal(config.main, "worker.js");
  assert.equal(config.keep_vars, true);
  assert.deepEqual(config.assets.run_worker_first, ["/api/*"]);
  assert.equal(config.assets.binding, "ASSETS");
  assert.deepEqual(config.d1_databases, [{ binding: "ANALYTICS_DB" }]);
});

function validPayload() {
  return {
    schemaVersion: 1,
    entries: [{
      entry_id: crypto.randomUUID(),
      day: new Date().toISOString().slice(0, 10),
      category: "product",
      event: "mode_selected",
      app_version: "2.9.1",
      release_channel: "appstore",
      mode: "classic",
      game_source: "solo",
      count: 1,
    }],
  };
}

function request(path, method, body) {
  return new Request(`https://icedmatchalabs.com${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function normalizeSQL(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

class FakeAssets {
  constructor() { this.requests = []; }
  async fetch(request) {
    this.requests.push(request);
    return new Response(`asset:${new URL(request.url).pathname}`);
  }
}

class FakeDB {
  constructor() {
    this.ids = new Set();
  }
  prepare(sql) {
    return { sql, values: [], bind: (...values) => ({ sql, values }) };
  }
  async batch(statements) {
    if (statements.every((statement) => (statement.values?.length ?? 0) === 0)) {
      return statements.map(() => ({ success: true, meta: { changes: 0 } }));
    }
    return statements.map(({ values }) => {
      const inserted = this.ids.has(values[0]) ? 0 : 1;
      this.ids.add(values[0]);
      return { success: true, meta: { changes: inserted } };
    });
  }
}

class DeferredSchemaDB {
  constructor() {
    this.calls = 0;
    this.pending = [];
  }
  prepare(sql) { return { sql }; }
  batch() {
    this.calls += 1;
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  resolve() { this.pending.shift()?.resolve({ count: 2, duration: 0 }); }
  reject(error) { this.pending.shift()?.reject(error); }
}
