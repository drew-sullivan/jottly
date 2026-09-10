import assert from "node:assert/strict";
import test from "node:test";
import {
  onRequestGet,
  onRequestPost,
} from "../functions/api/community/v1/admin.js";

const token = "community-admin-token-that-is-long-enough";
const now = Date.parse("2026-09-10T00:30:00Z");
const operationID = "51000000-0000-4000-8000-000000000099";

test("manual sweep is private, publishes reviewed games, and retries idempotently", async () => {
  const db = new CommunityDB();
  const env = { COMMUNITY_ADMIN_TOKEN: token, COMMUNITY_DB: db };
  const request = () => authorizedRequest("POST", { operationID, scheduledTime: now });

  const first = await onRequestPost({ request: request(), env, nowMilliseconds: now });
  assert.equal(first.status, 200);
  const firstResult = await first.json();
  assert.ok(Number.isSafeInteger(firstResult.durationMilliseconds));
  assert.ok(firstResult.durationMilliseconds >= 0);
  delete firstResult.durationMilliseconds;
  assert.deepEqual(firstResult, {
    operationID,
    runStatus: "succeeded",
    scheduledAtUnixMilliseconds: now,
    startedAtUnixMilliseconds: now,
    finishedAtUnixMilliseconds: firstResult.finishedAtUnixMilliseconds,
    replayed: false,
    status: "published",
    cloudKitPageCount: 0,
    recordsInspected: 0,
    qualifyingCompletions: 0,
    malformedRecordCount: 0,
    unallowlistedRecordCount: 0,
    rejectionCounts: {},
    conflictingPackageCount: 0,
    weeklyCandidateCount: 0,
    recentCandidateCount: 0,
    featuredFillCount: 5,
    publishedEntryCount: 5,
    generatedSnapshotAgeMilliseconds: 0,
    organicSourceStatus: "unconfigured",
  });
  assert.ok(Number.isSafeInteger(firstResult.finishedAtUnixMilliseconds));

  const retry = await onRequestPost({ request: request(), env, nowMilliseconds: now });
  assert.equal(retry.status, 200);
  const replay = await retry.json();
  assert.equal(replay.status, "published");
  assert.equal(replay.replayed, true);
  assert.equal(db.catalogRow.generated_at_ms, now);

  const operationStatus = await onRequestGet({
    request: authorizedRequest("GET", undefined, `?operationID=${operationID}`),
    env,
  });
  assert.equal(operationStatus.status, 200);
  assert.equal((await operationStatus.json()).operationID, operationID);

  const status = await onRequestGet({
    request: authorizedRequest("GET"),
    env,
    nowMilliseconds: now + 500,
  });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    status: "published",
    generatedAtUnixMilliseconds: now,
    ageMilliseconds: 500,
    hash: db.catalogRow.payload_sha256,
    catalogKind: "mixed",
    entryCount: 5,
    recentRuns: [{ ...replay, replayed: false }],
  });

  const scheduledOperationID = `scheduled:${now}`;
  db.runs.set(scheduledOperationID, {
    ...db.runs.get(operationID),
    operation_id: scheduledOperationID,
  });
  const scheduledStatus = await onRequestGet({
    request: authorizedRequest("GET", undefined, `?operationID=${scheduledOperationID}`),
    env,
  });
  assert.equal(scheduledStatus.status, 200);
  assert.equal((await scheduledStatus.json()).operationID, scheduledOperationID);
});

test("manual sweep hides from unauthorized callers and rejects malformed operations", async () => {
  const env = { COMMUNITY_ADMIN_TOKEN: token, COMMUNITY_DB: new CommunityDB() };
  const missing = await onRequestGet({
    request: new Request("https://icedmatchalabs.com/api/community/v1/admin/sweep"),
    env,
  });
  const wrong = await onRequestPost({
    request: new Request("https://icedmatchalabs.com/api/community/v1/admin/sweep", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: JSON.stringify({ operationID, scheduledTime: now }),
    }),
    env,
    nowMilliseconds: now,
  });
  const malformed = await onRequestPost({
    request: authorizedRequest("POST", { operationID: "not-a-uuid", scheduledTime: now }),
    env,
    nowMilliseconds: now,
  });
  const stale = await onRequestPost({
    request: authorizedRequest("POST", { operationID, scheduledTime: now - 11 * 60 * 1_000 }),
    env,
    nowMilliseconds: now,
  });
  const unexpected = await onRequestPost({
    request: authorizedRequest("POST", { operationID, scheduledTime: now, force: true }),
    env,
    nowMilliseconds: now,
  });
  const oversized = await onRequestPost({
    request: new Request("https://icedmatchalabs.com/api/community/v1/admin/sweep", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: " ".repeat(1_025),
    }),
    env,
    nowMilliseconds: now,
  });

  assert.equal(missing.status, 404);
  assert.equal(wrong.status, 404);
  assert.equal(malformed.status, 400);
  assert.equal(stale.status, 400);
  assert.equal(unexpected.status, 400);
  assert.equal(oversized.status, 400);
  assert.equal(env.COMMUNITY_DB.catalogRow, null);
  assert.equal(env.COMMUNITY_DB.runs.size, 0);
});

function authorizedRequest(method, body, query = "") {
  return new Request(`https://icedmatchalabs.com/api/community/v1/admin/sweep${query}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

class CommunityDB {
  constructor() {
    this.catalogRow = null;
    this.runs = new Map();
  }

  prepare(sql) {
    const execute = async (values) => {
      if (sql.includes("INSERT INTO community_catalog_current")) {
        const [generatedAt, hash, payload] = values;
        if (this.catalogRow !== null && generatedAt <= this.catalogRow.generated_at_ms) {
          return { meta: { changes: 0 } };
        }
        this.catalogRow = {
          generated_at_ms: generatedAt,
          payload_sha256: hash,
          payload_json: payload,
        };
        return { meta: { changes: 1 } };
      }
      if (sql.includes("INSERT OR IGNORE INTO community_catalog_runs")) {
        const [id, scheduledAt, startedAt] = values;
        if (this.runs.has(id)) return { meta: { changes: 0 } };
        this.runs.set(id, {
          operation_id: id,
          scheduled_at_ms: scheduledAt,
          started_at_ms: startedAt,
          finished_at_ms: null,
          status: "in_progress",
          summary_json: null,
          error_code: null,
        });
        return { meta: { changes: 1 } };
      }
      if (sql.includes("status = 'succeeded'")) {
        const [finishedAt, summary, id] = values;
        Object.assign(this.runs.get(id), {
          finished_at_ms: finishedAt,
          status: "succeeded",
          summary_json: summary,
          error_code: null,
        });
        return { meta: { changes: 1 } };
      }
      if (sql.includes("status = 'failed'")) {
        const [finishedAt, errorCode, id] = values;
        Object.assign(this.runs.get(id), {
          finished_at_ms: finishedAt,
          status: "failed",
          error_code: errorCode,
        });
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    };
    const readFirst = async (values) => {
      if (sql.includes("FROM community_catalog_runs")) return this.runs.get(values[0]) ?? null;
      return this.catalogRow;
    };
    return {
      bind: (...values) => ({
        run: () => execute(values),
        first: () => readFirst(values),
        all: async () => ({ results: [...this.runs.values()].sort((a, b) => b.started_at_ms - a.started_at_ms) }),
      }),
      run: async () => ({ meta: { changes: 0 } }),
      first: () => readFirst([]),
    };
  }
}
