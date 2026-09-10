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

  const retry = await onRequestPost({ request: request(), env, nowMilliseconds: now });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).status, "superseded");
  assert.equal(db.row.generated_at_ms, now);

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
    hash: db.row.payload_sha256,
    catalogKind: "mixed",
    entryCount: 5,
  });
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
  assert.equal(env.COMMUNITY_DB.row, null);
});

function authorizedRequest(method, body) {
  return new Request("https://icedmatchalabs.com/api/community/v1/admin/sweep", {
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
    this.row = null;
  }

  prepare(sql) {
    return {
      bind: (...values) => ({
        run: async () => {
          if (!sql.includes("INSERT INTO community_catalog_current")) {
            return { meta: { changes: 0 } };
          }
          const [generatedAt, hash, payload] = values;
          if (this.row !== null && generatedAt <= this.row.generated_at_ms) {
            return { meta: { changes: 0 } };
          }
          this.row = {
            generated_at_ms: generatedAt,
            payload_sha256: hash,
            payload_json: payload,
          };
          return { meta: { changes: 1 } };
        },
      }),
      run: async () => ({ meta: { changes: 0 } }),
      first: async () => this.row,
    };
  }
}
