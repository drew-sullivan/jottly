import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { onRequestPost } from "../functions/api/analytics/v1/events.js";
import { onRequestGet } from "../functions/api/analytics/v1/report.js";

import { SQLiteD1 } from "./support/sqlite-d1.mjs";
import { ensureAnalyticsSchema } from "../functions/api/analytics/v1/schema.js";

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
  assert.equal(db.schemaExecutions, 0);
  assert.equal(db.writeBatches.length, 0);
});

test("valid aggregates write only the approved columns", async () => {
  const db = new FakeDB();
  const response = await onRequestPost(context(payload, db));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: 1, inserted: 1 });
  assert.equal(db.schemaExecutions, 1);
  assert.equal(db.writeBatches.length, 1);
  assert.equal(db.writeBatches[0].length, 1);
  assert.equal(db.writeBatches[0][0].values.length, 24);
  assert.equal(db.writeBatches[0][0].values[0], payload.entries[0].entry_id);
  assert.equal(db.writeBatches[0][0].sql.includes("player"), false);
  assert.equal(db.writeBatches[0][0].sql.includes("word_length"), true);
  assert.equal(db.writeBatches[0][0].sql.includes("timestamp"), false);
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
  assert.equal(db.writeBatches.length, 0);
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
  const candidateContract = {
    protocolVersion: 1,
    definition: { word: { length: 4 } },
    definitionDigest: "a".repeat(64),
  };
  const candidatePackage = {
    schemaVersion: 1,
    id: "authored.00000000-0000-4000-8000-000000000001",
    contract: candidateContract,
    presentation: {
      title: "A Local Favorite",
      subtitle: "Complete private metadata",
      creator: { displayName: "Player" },
    },
  };
  const db = new FakeDB(
    [{ event: "game_started", count: 4 }],
    [{
      definition_digest: "a".repeat(64),
      contract_json: JSON.stringify(candidatePackage),
      submission_count: 3,
      first_received_at: "2026-09-18 12:00:00",
      last_received_at: "2026-09-19 12:00:00",
    }],
  );
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
  assert.deepEqual(await allowed.json(), {
    days: 7,
    rows: [{ event: "game_started", count: 4 }],
    lovedGameCandidates: [{
      definitionDigest: "a".repeat(64),
      privateSubmissionCount: 3,
      firstReceivedAt: "2026-09-18 12:00:00",
      lastReceivedAt: "2026-09-19 12:00:00",
      package: candidatePackage,
      contract: candidateContract,
    }],
  });
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
  const baseline = await readFile(
    new URL("../migrations/0001_anonymous_analytics.sql", import.meta.url),
    "utf8",
  );
  const community = await readFile(
    new URL("../migrations/0003_community_analytics.sql", import.meta.url),
    "utf8",
  );
  const namedGames = await readFile(
    new URL("../migrations/0007_named_game_analytics.sql", import.meta.url),
    "utf8",
  );
  const lovedGames = await readFile(
    new URL("../migrations/0008_loved_game_candidates.sql", import.meta.url),
    "utf8",
  );
  const sql = `${baseline}\n${community}\n${namedGames}`;
  assert.match(sql, /entry_id TEXT PRIMARY KEY/);
  assert.match(
    sql,
    /INSERT OR IGNORE INTO anonymous_analytics_events_v2[\s\S]+FROM anonymous_analytics_events;/
  );
  assert.match(
    sql,
    /INSERT OR IGNORE INTO anonymous_analytics_events_v3[\s\S]+FROM anonymous_analytics_events_v2;/
  );
  assert.match(
    sql,
    /INSERT OR IGNORE INTO anonymous_analytics_events_v4[\s\S]+FROM anonymous_analytics_events_v3;/
  );
  assert.match(
    sql,
    /INSERT OR IGNORE INTO anonymous_analytics_events_v5[\s\S]+FROM anonymous_analytics_events_v4;/
  );
  assert.match(
    sql,
    /INSERT OR IGNORE INTO anonymous_analytics_events_v6[\s\S]+FROM anonymous_analytics_events_v5;/
  );
  assert.match(sql, /game_slug TEXT/);
  assert.match(sql, /install_cohort TEXT/);
  assert.match(sql, /community_selection_source TEXT/);
  assert.doesNotMatch(sql, /player|device|game_id|opponent|timestamp|name/i);
  assert.match(lovedGames, /definition_digest TEXT NOT NULL/);
  assert.match(lovedGames, /contract_json TEXT NOT NULL/);
  assert.doesNotMatch(lovedGames, /secret_word|guess_history|opponent/i);
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
  constructor(results = [], candidates = []) {
    this.results = results;
    this.candidates = candidates;
    this.writeBatches = [];
    this.persistedEntryIDs = new Set();
    this.schemaExecutions = 0;
  }

  prepare(sql) {
    const statement = {
      sql,
      values: [],
      all: async () => ({ results: sql.includes("loved_game_candidates") ? this.candidates : this.results }),
      bind: (...values) => ({
        sql,
        values,
        all: async () => ({ results: sql.includes("loved_game_candidates") ? this.candidates : this.results }),
      }),
    };
    return statement;
  }

  async batch(statements) {
    if (statements.every((statement) => (statement.values?.length ?? 0) === 0)) {
      this.schemaExecutions += 1;
      return statements.map(() => ({ success: true, meta: { changes: 0 } }));
    }
    this.writeBatches.push(statements);
    return statements.map((statement) => {
      const entryID = statement.values[0];
      const inserted = this.persistedEntryIDs.has(entryID) ? 0 : 1;
      this.persistedEntryIDs.add(entryID);
      return { success: true, meta: { changes: inserted } };
    });
  }
}


test("real report SQL ranks private submissions and returns anonymous aggregate data", async (t) => {
  const db = new SQLiteD1(); t.after(() => db.close());
  const get = (token = "secret") => onRequestGet({
    request: new Request("https://icedmatchalabs.com/api/analytics/v1/report?days=7", { headers: { authorization: `Bearer ${token}` } }),
    env: { ANALYTICS_DB: db, ANALYTICS_REPORT_TOKEN: "secret" },
  });
  assert.equal((await get("wrong")).status, 404);
  const empty = await get(); assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { days: 7, rows: [], lovedGameCandidates: [] });
  await ensureAnalyticsSchema(db);
  const insert = db.sqlite.prepare("INSERT INTO loved_game_candidates (submission_id, definition_digest, contract_json, received_at) VALUES (?, ?, ?, ?)");
  for (const [digest, count, date] of [["a", 3, "2026-09-01"], ["b", 1, "2026-09-04"], ["c", 1, "2026-09-03"], ["d", 1, "2026-09-03"]]) {
    for (let i = 0; i < count; i += 1) insert.run(`${digest}-${i}`, digest, JSON.stringify({ protocolVersion: 1, definitionDigest: digest }), date);
  }
  assert.equal((await onRequestPost(context(payload, db))).status, 200);
  assert.equal((await onRequestPost(context(payload, db))).status, 200);
  const reply = await get(); assert.equal(reply.status, 200);
  const report = await reply.json();
  assert.deepEqual(report.lovedGameCandidates.map(x => [x.definitionDigest, x.privateSubmissionCount]), [["a", 3], ["b", 1], ["c", 1], ["d", 1]]);
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].count, 2);
  assert.equal(report.rows[0].event, "mode_selected");
  for (const row of report.rows) for (const key of Object.keys(row)) assert.doesNotMatch(key, /player|device|game_id|opponent|timestamp|name/i);
  assert.equal((await get("wrong")).status, 404);
});
