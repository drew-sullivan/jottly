import assert from "node:assert/strict";
import test from "node:test";
import { validatePayload } from "../functions/api/analytics/v1/contract.js";

const now = new Date("2026-08-24T12:00:00Z");
const entry = {
  entry_id: "40b731c3-393d-4ba2-9d61-18e40338f8fc",
  day: "2026-08-24",
  category: "product",
  event: "game_completed",
  app_version: "2.9.1",
  release_channel: "appstore",
  mode: "mystery",
  game_source: "solo",
  turn_bucket: "4_6",
  duration_bucket: "5_15m",
  outcome: "won",
  count: 3,
};

test("accepts the anonymous aggregate contract", () => {
  assert.equal(validatePayload({ schemaVersion: 1, entries: [entry] }, now).ok, true);
});

test("rejects identifiers, words, exact timestamps, and arbitrary dimensions", () => {
  for (const key of ["player_id", "device_id", "game_id", "opponent_id", "word", "timestamp", "name"]) {
    const result = validatePayload({ schemaVersion: 1, entries: [{ ...entry, [key]: "private" }] }, now);
    assert.equal(result.ok, false, key);
  }
});

test("rejects unknown enum values and excessive counts", () => {
  assert.equal(validatePayload({ schemaVersion: 1, entries: [{ ...entry, mode: "secret-mode" }] }, now).ok, false);
  assert.equal(validatePayload({ schemaVersion: 1, entries: [{ ...entry, count: 1001 }] }, now).ok, false);
});

test("event categories and dimensions cannot drift", () => {
  assert.equal(validatePayload({ schemaVersion: 1, entries: [{ ...entry, category: "reliability" }] }, now).ok, false);
  assert.equal(validatePayload({ schemaVersion: 1, entries: [{ ...entry, share_channel: "messages" }] }, now).ok, false);
  const reliability = {
    ...entry,
    category: "reliability",
    event: "home_cache_painted",
    performance_bucket: "100_250ms",
  };
  delete reliability.mode;
  delete reliability.game_source;
  delete reliability.turn_bucket;
  delete reliability.duration_bucket;
  delete reliability.outcome;
  assert.equal(validatePayload({ schemaVersion: 1, entries: [reliability] }, now).ok, true);
  const missingOutcome = { ...entry };
  delete missingOutcome.outcome;
  assert.equal(validatePayload({ schemaVersion: 1, entries: [missingOutcome] }, now).ok, false);
});

test("rejects duplicate idempotency keys in one request", () => {
  assert.equal(validatePayload({ schemaVersion: 1, entries: [entry, entry] }, now).ok, false);
});

test("rejects stale and implausibly future aggregate days", () => {
  assert.equal(validatePayload({ schemaVersion: 1, entries: [{ ...entry, day: "2026-01-01" }] }, now).ok, false);
  assert.equal(validatePayload({ schemaVersion: 1, entries: [{ ...entry, day: "2026-09-01" }] }, now).ok, false);
});
