import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildDashboardModel, preferredReleaseChannel } from "../assets/analytics-dashboard-model.js";

const rows = [
  row("game_started", 8, { mode: "lightning", game_source: "solo" }),
  row("game_started", 3, { mode: "mystery", game_source: "daily" }),
  row("game_completed", 5, { mode: "lightning", game_source: "solo", outcome: "won", duration_bucket: "under_5m" }),
  row("game_completed", 1, { mode: "mystery", game_source: "daily", outcome: "stumped", duration_bucket: "5_15m" }),
  row("game_left", 2, { mode: "lightning", game_source: "solo", turn_bucket: "1_3" }),
  row("first_game_started", 4),
  row("first_valid_guess_submitted", 3, { mode: "lightning", game_source: "solo" }),
  row("first_game_completed", 2),
  row("second_game_started", 1),
  row("share_sheet_opened", 5, { share_source: "game_result" }),
  row("share_completed", 3, { share_source: "game_result", share_channel: "messages" }),
  row("share_completed", 9, { share_source: "problem_report", share_channel: "other" }),
  row("invalid_word_rejected", 4, { mode: "lightning", game_source: "solo" }),
  row("rules_reopened", 2, { mode: "mystery", game_source: "daily" }),
  row("home_cache_painted", 8, { category: "reliability", performance_bucket: "under_100ms" }),
  row("home_cache_painted", 2, { category: "reliability", performance_bucket: "100_250ms" }),
  row("home_reconciled", 7, { category: "reliability", performance_bucket: "1_3s" }),
  row("home_reconciled", 1, { category: "reliability", performance_bucket: "3s_plus" }),
  row("offline_fallback_entered", 2, { category: "reliability", reliability_reason: "cloudkit" }),
];

test("the dashboard answers mode, completion, source, and outcome questions", () => {
  const model = buildDashboardModel(rows);
  assert.equal(model.headline.started, 11);
  assert.equal(model.headline.completed, 6);
  assert.equal(model.headline.observedFinishRatio, 6 / 11);
  assert.deepEqual(model.gameSources, [{ key: "solo", count: 8 }, { key: "daily", count: 3 }]);
  assert.deepEqual(model.outcomes, [{ key: "won", count: 5 }, { key: "stumped", count: 1 }]);

  const lightning = model.modes.find((mode) => mode.key === "lightning");
  assert.deepEqual(
    { started: lightning.started, completed: lightning.completed, left: lightning.left, ratio: lightning.observedFinishRatio },
    { started: 8, completed: 5, left: 2, ratio: 5 / 8 },
  );
});

test("Shapeshifter has its own ordered dashboard row", () => {
  const model = buildDashboardModel([
    row("game_started", 3, { mode: "shapeshifter", game_source: "solo" }),
    row("game_completed", 2, { mode: "shapeshifter", game_source: "solo", outcome: "won" }),
  ]);

  assert.deepEqual(model.modes.map(({ key }) => key), [
    "lightning", "cowpoke", "classic", "shapeshifter", "mystery",
  ]);
  assert.deepEqual(
    model.modes.find(({ key }) => key === "shapeshifter"),
    {
      key: "shapeshifter",
      label: "Shapeshifter",
      selected: 0,
      started: 3,
      completed: 2,
      left: 0,
      observedFinishRatio: 2 / 3,
      outcomes: [{ key: "won", count: 2 }],
    },
  );
});

test("support reports do not masquerade as player sharing", () => {
  const model = buildDashboardModel(rows);
  assert.equal(model.sharing.opened, 5);
  assert.equal(model.sharing.completed, 3);
  assert.equal(model.sharing.problemReports, 9);
  assert.deepEqual(model.sharing.channels, [{ key: "messages", count: 3 }]);
});

test("onboarding remains milestone telemetry rather than a fake cohort funnel", () => {
  const model = buildDashboardModel(rows);
  assert.deepEqual(model.onboarding.slice(0, 4).map(({ key, count }) => ({ key, count })), [
    { key: "first_game_started", count: 4 },
    { key: "first_valid_guess_submitted", count: 3 },
    { key: "first_game_completed", count: 2 },
    { key: "second_game_started", count: 1 },
  ]);
});

test("reliability summarizes deterministic performance buckets", () => {
  const model = buildDashboardModel(rows);
  assert.equal(model.reliability.cachePaints, 10);
  assert.equal(model.reliability.cacheUnder100msRatio, 0.8);
  assert.equal(model.reliability.reconciles, 8);
  assert.equal(model.reliability.reconcileUnder3sRatio, 7 / 8);
  assert.deepEqual(model.reliability.offlineReasons, [{ key: "cloudkit", count: 2 }]);
});

test("channel and version filters are applied without hiding available choices", () => {
  const mixed = [
    ...rows,
    row("game_started", 20, { mode: "classic", game_source: "friend", release_channel: "debug", app_version: "2.10.0" }),
  ];
  const model = buildDashboardModel(mixed, { channel: "testflight", version: "2.9.7" });
  assert.equal(model.headline.started, 11);
  assert.deepEqual(model.available.channels, ["debug", "testflight"]);
  assert.deepEqual(model.available.versions, ["2.10.0", "2.9.7"]);
});

test("product decisions prefer App Store data, then TestFlight, over debug traffic", () => {
  assert.equal(preferredReleaseChannel(["debug", "testflight", "appstore"]), "appstore");
  assert.equal(preferredReleaseChannel(["debug", "testflight"]), "testflight");
  assert.equal(preferredReleaseChannel(["debug"]), "all");
  assert.equal(preferredReleaseChannel([]), "all");
});

test("window boundary effects remain visible instead of being silently clamped", () => {
  const model = buildDashboardModel([
    row("game_started", 1, { mode: "classic", game_source: "friend" }),
    row("game_completed", 2, { mode: "classic", game_source: "friend", outcome: "won" }),
  ]);
  assert.equal(model.headline.observedFinishRatio, 2);
  assert.equal(model.modes.find((mode) => mode.key === "classic").observedFinishRatio, 2);
});

test("malformed rows fail soft and empty reports have stable zero states", () => {
  const model = buildDashboardModel([null, {}, { event: "game_started", count: 0 }, { event: "game_started", count: "nope" }]);
  assert.equal(model.rowCount, 0);
  assert.deepEqual(model.dateRange, { first: null, last: null });
  assert.equal(model.headline.started, 0);
  assert.equal(model.headline.observedFinishRatio, null);
  assert.deepEqual(model.insights, []);
});

test("daily activity is chronological and includes only player-facing shares", () => {
  const model = buildDashboardModel([
    row("game_started", 2, { day: "2026-08-27", mode: "classic", game_source: "friend" }),
    row("game_completed", 1, { day: "2026-08-26", mode: "classic", game_source: "friend", outcome: "won" }),
    row("share_completed", 4, { day: "2026-08-26", share_source: "problem_report", share_channel: "other" }),
    row("share_completed", 1, { day: "2026-08-26", share_source: "game_result", share_channel: "messages" }),
  ]);
  assert.deepEqual(model.dailyActivity, [
    { day: "2026-08-26", started: 0, completed: 1, left: 0, shares: 1 },
    { day: "2026-08-27", started: 2, completed: 0, left: 0, shares: 0 },
  ]);
});

test("the private dashboard contract never persists its token beyond the tab", async () => {
  const html = await readFile(new URL("../analytics.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../assets/analytics-dashboard.js", import.meta.url), "utf8");
  const headers = await readFile(new URL("../_headers", import.meta.url), "utf8");
  assert.match(html, /name="robots" content="noindex, nofollow"/);
  assert.match(script, /sessionStorage/);
  assert.doesNotMatch(script, /localStorage/);
  assert.doesNotMatch(script, /innerHTML/);
  assert.match(script, /\/api\/analytics\/v1\/report\?days=/);
  assert.match(headers, /\/analytics\*/);
  assert.match(headers, /Cache-Control: no-store/);
  assert.match(headers, /connect-src 'self'/);
  assert.match(headers, /X-Robots-Tag: noindex, nofollow/);
});

test("the dashboard visibly answers each product question without third-party dependencies", async () => {
  const html = await readFile(new URL("../analytics.html", import.meta.url), "utf8");
  for (const question of [
    "What are people choosing and finishing?",
    "Are new players finding the game?",
    "What do people share, and how?",
    "Where do players need help?",
    "Does the app feel fast and dependable?",
    "What changed day by day?",
  ]) assert.match(html, new RegExp(question.replace(/[?]/g, "\\?")));
  assert.doesNotMatch(html, /https:\/\/(?!icedmatchalabs\.com)/);
});

function row(event, count, overrides = {}) {
  return {
    day: "2026-08-27",
    category: "product",
    event,
    app_version: "2.9.7",
    release_channel: "testflight",
    mode: null,
    game_source: null,
    share_source: null,
    share_channel: null,
    turn_bucket: null,
    duration_bucket: null,
    outcome: null,
    performance_bucket: null,
    reliability_reason: null,
    count,
    ...overrides,
  };
}
