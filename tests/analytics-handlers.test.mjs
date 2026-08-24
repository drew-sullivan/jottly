import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { onRequestPost } from "../functions/api/analytics/v1/events.js";
import { onRequestGet } from "../functions/api/analytics/v1/report.js";

const payload = {
  schemaVersion: 1,
  entries: [{
    entry_id: "40b731c3-393d-4ba2-9d61-18e40338f8fc",
    day: new Date().toISOString().slice(0, 10),
    category: "product",
    event: "mode_selected",
    app_version: "2.9.1",
    release_channel: "appstore",
    mode: "lightning",
    game_source: "solo",
    count: 2,
  }],
};

test("validate-only checks the deployed contract without touching D1", async () => {
  const db = new FakeDB();
  const response = await onRequestPost(context(payload, db, { "x-jottly-validate-only": "1" }));
  assert.equal(response.status, 200);
  assert.equal(db.batches.length, 0);
});

test("valid aggregates write only the approved columns", async () => {
  const db = new FakeDB();
  const response = await onRequestPost(context(payload, db));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: 1, inserted: 1 });
  assert.equal(db.schemaExecutions, 1);
  assert.equal(db.batches.length, 1);
  assert.equal(db.batches[0].length, 1);
  assert.equal(db.batches[0][0].values.length, 16);
  assert.equal(db.batches[0][0].values[0], payload.entries[0].entry_id);
  assert.equal(db.batches[0][0].sql.includes("player"), false);
  assert.equal(db.batches[0][0].sql.includes("word"), false);
  assert.equal(db.batches[0][0].sql.includes("timestamp"), false);
});

test("replaying an idempotency key succeeds without inserting a second row", async () => {
  const db = new FakeDB();
  const first = await onRequestPost(context(payload, db));
  const replay = await onRequestPost(context(payload, db));

  assert.deepEqual(await first.json(), { accepted: 1, inserted: 1 });
  assert.deepEqual(await replay.json(), { accepted: 1, inserted: 0 });
  assert.equal(db.persistedEntryIDs.size, 1);
  assert.equal(db.schemaExecutions, 1);
});

test("malformed or identifying payloads fail closed", async () => {
  const db = new FakeDB();
  const identifying = structuredClone(payload);
  identifying.entries[0].device_id = "nope";
  const response = await onRequestPost(context(identifying, db));
  assert.equal(response.status, 400);
  assert.equal(db.batches.length, 0);
});

test("oversized and non-JSON requests are rejected before parsing", async () => {
  const db = new FakeDB();
  const tooLarge = context(payload, db, { "content-length": String(65 * 1024) });
  assert.equal((await onRequestPost(tooLarge)).status, 413);
  const request = new Request("https://icedmatchalabs.com/api/analytics/v1/events", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "hello",
  });
  assert.equal((await onRequestPost({ request, env: { ANALYTICS_DB: db } })).status, 415);
});

test("reports are invisible without the server-side secret", async () => {
  const db = new FakeDB([{ event: "game_started", count: 4 }]);
  const missing = await onRequestGet({
    request: new Request("https://icedmatchalabs.com/api/analytics/v1/report"),
    env: { ANALYTICS_DB: db, ANALYTICS_REPORT_TOKEN: "secret" },
  });
  assert.equal(missing.status, 404);
  assert.equal(db.schemaExecutions, 0);

  const allowed = await onRequestGet({
    request: new Request("https://icedmatchalabs.com/api/analytics/v1/report?days=7", {
      headers: { authorization: "Bearer secret" },
    }),
    env: { ANALYTICS_DB: db, ANALYTICS_REPORT_TOKEN: "secret" },
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { days: 7, rows: [{ event: "game_started", count: 4 }] });
  assert.equal(db.schemaExecutions, 1);
});

test("report ranges are deterministic for malformed, fractional, and excessive input", async () => {
  const db = new FakeDB();
  const report = async (days) => onRequestGet({
    request: new Request(`https://icedmatchalabs.com/api/analytics/v1/report?days=${days}`, {
      headers: { authorization: "Bearer secret" },
    }),
    env: { ANALYTICS_DB: db, ANALYTICS_REPORT_TOKEN: "secret" },
  });

  assert.equal((await (await report("nonsense")).json()).days, 30);
  assert.equal((await (await report("7.9")).json()).days, 7);
  assert.equal((await (await report("999")).json()).days, 90);
  assert.equal((await (await report("-4")).json()).days, 1);
});

test("the migration makes retry ids the primary idempotency key", async () => {
  const sql = await readFile(new URL("../migrations/0001_anonymous_analytics.sql", import.meta.url), "utf8");
  assert.match(sql, /entry_id TEXT PRIMARY KEY/);
  assert.doesNotMatch(sql, /player|device|game_id|opponent|word|timestamp/i);
});

function context(body, db, extraHeaders = {}) {
  return {
    request: new Request("https://icedmatchalabs.com/api/analytics/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
    }),
    env: { ANALYTICS_DB: db },
  };
}

class FakeDB {
  constructor(results = []) {
    this.results = results;
    this.batches = [];
    this.persistedEntryIDs = new Set();
    this.schemaExecutions = 0;
  }

  async exec() {
    this.schemaExecutions += 1;
    return { count: 2, duration: 0 };
  }

  prepare(sql) {
    return {
      bind: (...values) => ({
        sql,
        values,
        all: async () => ({ results: this.results }),
      }),
    };
  }

  async batch(statements) {
    this.batches.push(statements);
    return statements.map((statement) => {
      const entryID = statement.values[0];
      const inserted = this.persistedEntryIDs.has(entryID) ? 0 : 1;
      this.persistedEntryIDs.add(entryID);
      return { success: true, meta: { changes: inserted } };
    });
  }
}
