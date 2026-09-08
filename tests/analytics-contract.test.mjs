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

test("accepts every player-facing mode including Shapeshifter", () => {
  for (const mode of ["lightning", "cowpoke", "classic", "shapeshifter", "mystery", "custom"]) {
    const result = validatePayload({ schemaVersion: 1, entries: [{ ...entry, mode }] }, now);
    assert.equal(result.ok, true, mode);
  }
});

test("accepts only bounded anonymous game-design dimensions", () => {
  const ruleEvent = {
    ...entry,
    event: "game_rule_used",
    mode: "custom",
    game_kind: "remixed",
    word_length: "12",
    rule_id: "excluded_letters",
  };
  delete ruleEvent.turn_bucket;
  delete ruleEvent.duration_bucket;
  delete ruleEvent.outcome;
  assert.equal(validatePayload({ schemaVersion: 1, entries: [ruleEvent] }, now).ok, true);
  assert.equal(validatePayload({ schemaVersion: 1, entries: [{ ...ruleEvent, rule_id: "secret-custom-rule" }] }, now).ok, false);
  assert.equal(validatePayload({ schemaVersion: 1, entries: [{ ...ruleEvent, word_length: "999" }] }, now).ok, false);
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

test("accepts bounded journey context and reason dimensions", () => {
  const journeyBase = {
    entry_id: entry.entry_id,
    day: entry.day,
    category: "product",
    app_version: entry.app_version,
    release_channel: entry.release_channel,
    count: 1,
  };
  const journeyEntries = [
    { ...journeyBase, event: "game_start_failed", mode: "lightning", game_source: "solo", performance_bucket: "1_3s", reason: "cloudkit" },
    { ...journeyBase, event: "suggestions_shown", mode: "lightning", game_source: "solo", context: "opening_suggestion" },
    { ...journeyBase, event: "invite_failed", context: "game_routing", reason: "unsupported_contract" },
    { ...journeyBase, event: "notification_route_failed", category: "reliability", context: "game_routing", reason: "routing" },
    { ...journeyBase, event: "sync_operation_queued", category: "reliability", game_source: "friend", reliability_reason: "outbox", context: "move", reason: "network" },
  ].map((value, index) => ({
    ...value,
    entry_id: `40b731c3-393d-4ba2-9d61-18e40338f${String(900 + index).slice(-3)}`,
  }));
  assert.equal(validatePayload({ schemaVersion: 1, entries: journeyEntries }, now).ok, true);
});

test("accepts conflict as a bounded game-start failure reason", () => {
  const conflictedStart = {
    entry_id: entry.entry_id,
    day: entry.day,
    category: "product",
    event: "game_start_failed",
    app_version: entry.app_version,
    release_channel: entry.release_channel,
    mode: "lightning",
    game_source: "friend",
    performance_bucket: "250ms_1s",
    reason: "conflict",
    count: 1,
  };

  assert.equal(validatePayload({ schemaVersion: 1, entries: [conflictedStart] }, now).ok, true);
});

test("community analytics reveal only a bounded tier and no content identity", () => {
  const base = {
    entry_id: entry.entry_id,
    day: entry.day,
    category: "product",
    app_version: "3.4.0",
    release_channel: "testflight",
    count: 1,
  };
  const events = [
    { ...base, event: "community_section_opened", context: "community_catalog" },
    {
      ...base, entry_id: "40b731c3-393d-4ba2-9d61-18e40338f901",
      event: "community_game_selected", mode: "custom", game_source: "solo",
      game_kind: "remixed", word_length: "7", context: "community_catalog",
      community_selection_source: "weekly_popular",
    },
    {
      ...base, entry_id: "40b731c3-393d-4ba2-9d61-18e40338f902",
      event: "community_catalog_refresh_failed", category: "reliability", context: "community_catalog",
    },
  ];
  assert.equal(validatePayload({ schemaVersion: 1, entries: events }, now).ok, true);
  assert.equal(validatePayload({
    schemaVersion: 1,
    entries: [{ ...events[1], entry_id: crypto.randomUUID(), community_selection_source: "rank-1" }],
  }, now).ok, false);
  assert.equal(validatePayload({
    schemaVersion: 1,
    entries: [{ ...events[1], entry_id: crypto.randomUUID(), package_id: "authored.private" }],
  }, now).ok, false);
});

test("journey dimensions remain bounded and event-specific", () => {
  const suggestions = {
    entry_id: entry.entry_id,
    day: entry.day,
    category: "product",
    event: "suggestions_shown",
    app_version: entry.app_version,
    release_channel: entry.release_channel,
    mode: "lightning",
    game_source: "solo",
    context: "opening_suggestion",
    count: 1,
  };
  assert.equal(validatePayload({ schemaVersion: 1, entries: [{ ...suggestions, context: "secret-screen-name" }] }, now).ok, false);
  assert.equal(validatePayload({ schemaVersion: 1, entries: [{ ...suggestions, reason: "unknown" }] }, now).ok, false);
});

test("active-install and onboarding cohorts are coarse, bounded, and event-specific", () => {
  const cohortEntry = {
    entry_id: entry.entry_id,
    day: entry.day,
    category: "product",
    event: "active_install_day",
    app_version: entry.app_version,
    release_channel: entry.release_channel,
    install_cohort: "2026-W34",
    count: 1,
  };
  assert.equal(validatePayload({ schemaVersion: 1, entries: [cohortEntry] }, now).ok, true);
  assert.equal(validatePayload({ schemaVersion: 1, entries: [{ ...cohortEntry, install_cohort: "2026-W99" }] }, now).ok, false);
  assert.equal(validatePayload({ schemaVersion: 1, entries: [{ ...cohortEntry, install_cohort: "private-install" }] }, now).ok, false);
  assert.equal(validatePayload({ schemaVersion: 1, entries: [{ ...entry, install_cohort: "2026-W34" }] }, now).ok, false);
});

test("move and invitation performance events accept only bounded operational dimensions", () => {
  const base = {
    entry_id: entry.entry_id,
    day: entry.day,
    app_version: entry.app_version,
    release_channel: entry.release_channel,
    mode: "custom",
    game_source: "friend",
    game_kind: "remixed",
    word_length: "8",
    context: "move",
    count: 1,
  };
  const moveCompleted = {
    ...base,
    category: "product",
    event: "move_submission_completed",
    performance_bucket: "250ms_1s",
  };
  const moveFailed = {
    ...base,
    category: "reliability",
    event: "move_submission_failed",
    performance_bucket: "1_3s",
    reason: "cloudkit",
  };
  const inviteJoined = {
    ...base,
    category: "product",
    event: "invite_joined",
    game_source: "invitation",
    context: "invitation",
    performance_bucket: "1_3s",
  };
  const entries = [moveCompleted, moveFailed, inviteJoined].map((value, index) => ({
    ...value,
    entry_id: `40b731c3-393d-4ba2-9d61-18e40338f${String(930 + index).slice(-3)}`,
  }));
  assert.equal(validatePayload({ schemaVersion: 1, entries }, now).ok, true);
  assert.equal(validatePayload({ schemaVersion: 1, entries: [{ ...moveCompleted, performance_bucket: "1873ms" }] }, now).ok, false);
});
