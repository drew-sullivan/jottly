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
    "custom",
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

test("the dashboard exposes custom creation, game kind, word length, and rule usage", () => {
  const model = buildDashboardModel([
    row("game_created", 2, { mode: "custom", game_kind: "remixed", word_length: "7" }),
    row("game_rule_created", 2, {
      mode: "custom", game_kind: "remixed", word_length: "7", rule_id: "excluded_letters",
    }),
    row("game_started", 3, { mode: "custom", game_source: "friend", game_kind: "remixed", word_length: "7" }),
    row("game_rule_used", 3, {
      mode: "custom", game_source: "friend", game_kind: "remixed", word_length: "7", rule_id: "excluded_letters",
    }),
  ]);

  assert.equal(model.creations.total, 2);
  assert.deepEqual(model.creations.modes, [{ key: "custom", count: 2 }]);
  assert.deepEqual(model.creations.wordLengths, [{ key: "7", count: 2 }]);
  assert.deepEqual(model.creations.rules, [{ key: "excluded_letters", count: 2 }]);
  assert.deepEqual(model.gameKinds, [{ key: "remixed", count: 3 }]);
  assert.deepEqual(model.wordLengths, [{ key: "7", count: 3 }]);
  assert.deepEqual(model.playedRules, [{ key: "excluded_letters", count: 3 }]);
});

test("support reports do not masquerade as player sharing", () => {
  const model = buildDashboardModel(rows);
  assert.equal(model.sharing.opened, 5);
  assert.equal(model.sharing.completed, 3);
  assert.equal(model.sharing.problemReports, 9);
  assert.deepEqual(model.sharing.channels, [{ key: "messages", count: 3 }]);
});

test("legacy onboarding remains available alongside the cohort funnel", () => {
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

test("journeys expose honest stage counts without pretending to identify users", () => {
  const model = buildDashboardModel([
    row("game_picker_opened", 10, { game_source: "solo", context: "game_picker" }),
    row("game_start_requested", 8, { mode: "lightning", game_source: "solo" }),
    row("game_ready", 7, { mode: "lightning", game_source: "solo", performance_bucket: "250ms_1s" }),
    row("game_start_failed", 1, { mode: "lightning", game_source: "solo", performance_bucket: "1_3s", reason: "cloudkit" }),
    row("invite_created", 5, { mode: "classic", game_source: "friend", context: "invitation" }),
    row("share_completed", 4, { share_source: "friend_invitation", share_channel: "messages" }),
    row("invite_joined", 3, { mode: "classic", game_source: "invitation", context: "invitation" }),
    row("invite_first_move_submitted", 2, { mode: "classic", game_source: "friend", context: "invitation" }),
    row("invite_game_completed", 1, { mode: "classic", game_source: "invitation", context: "invitation" }),
    row("remix_opened", 6, { context: "remix_editor" }),
    row("remix_kept", 3, { mode: "custom", game_kind: "remixed", word_length: "6", context: "remix_editor" }),
    row("shared_game_reshared", 2, { mode: "custom", game_kind: "remixed", word_length: "6", context: "shared_game" }),
    row("shared_game_saved", 1, { mode: "custom", game_kind: "remixed", word_length: "6", context: "shared_game" }),
  ]);
  assert.deepEqual(model.journeys.gameStart.map(({ count }) => count), [10, 8, 7, 1]);
  assert.equal(model.startExperience.observedReadyRatio, 7 / 8);
  assert.deepEqual(model.startExperience.failures, [{ key: "cloudkit", count: 1 }]);
  assert.equal(model.journeys.invitation.find(({ key }) => key === "invite_created").count, 5);
  assert.equal(model.journeys.invitation.find(({ label }) => label === "Invite shared").count, 4);
  assert.equal(model.journeys.invitation.find(({ key }) => key === "invite_first_move_submitted").count, 2);
  assert.equal(model.journeys.invitation.find(({ key }) => key === "invite_game_completed").count, 1);
  assert.equal(model.journeys.remix.find(({ label }) => label === "Game shared").count, 2);
  assert.equal(model.journeys.remix.find(({ label }) => label === "Shared game imported").count, 1);
});

test("the dashboard connects suggestions, rules, notifications, rule outcomes, and recovery", () => {
  const model = buildDashboardModel([
    row("guess_submission_attempted", 20, { mode: "custom", game_source: "solo", context: "move" }),
    row("invalid_word_rejected", 2, { mode: "custom", game_source: "solo", context: "move", reason: "validation" }),
    row("suggestions_shown", 12, { mode: "custom", game_source: "solo", context: "nudge_suggestion" }),
    row("suggested_word_used", 4, { mode: "custom", game_source: "solo", context: "nudge_suggestion" }),
    row("suggested_word_submitted", 3, { mode: "custom", game_source: "solo", context: "nudge_suggestion" }),
    row("suggested_word_rejected", 1, { mode: "custom", game_source: "solo", context: "nudge_suggestion", reason: "validation" }),
    row("rules_shown", 10, { mode: "custom", game_source: "solo", context: "initial_rules" }),
    row("rules_reopened", 3, { mode: "custom", game_source: "solo", context: "rules_button" }),
    row("rule_symbol_opened", 2, { mode: "custom", game_source: "solo", context: "score_symbol" }),
    row("notification_opened", 5, { context: "game_routing" }),
    row("notification_route_succeeded", 4, { context: "game_routing" }),
    row("notification_route_failed", 1, { category: "reliability", context: "game_routing", reason: "routing" }),
    row("game_rule_used", 10, { mode: "custom", game_source: "solo", rule_id: "delayed_feedback" }),
    row("game_rule_completed", 7, { mode: "custom", game_source: "solo", rule_id: "delayed_feedback" }),
    row("game_rule_left", 2, { mode: "custom", game_source: "solo", rule_id: "delayed_feedback" }),
    row("game_terminated", 2, { mode: "custom", game_source: "solo", turn_bucket: "1_3", reason: "user_left" }),
    row("sync_operation_queued", 3, { category: "reliability", game_source: "friend", reliability_reason: "outbox", context: "move", reason: "network" }),
    row("sync_recovered", 2, { category: "reliability", reliability_reason: "network", reason: "network" }),
    row("outbox_drained", 2, { category: "reliability", reliability_reason: "outbox", context: "move", performance_bucket: "100_250ms" }),
  ]);
  assert.equal(model.suggestions.observedUseRatio, 1 / 3);
  assert.equal(model.suggestions.observedSubmitRatio, 1 / 4);
  assert.equal(model.rulesHelp.observedReopenRatio, 0.3);
  assert.equal(model.friction.invalidWordRatio, 0.1);
  assert.deepEqual(model.rulesHelp.helpByContext, [
    { key: "rules_button", count: 3 },
    { key: "score_symbol", count: 2 },
  ]);
  assert.equal(model.notifications.observedRouteRatio, 0.8);
  assert.deepEqual(model.ruleOutcomes[0], {
    key: "delayed_feedback", started: 10, completed: 7, left: 2, observedFinishRatio: 0.7,
  });
  assert.deepEqual(model.terminations, [{ key: "user_left", count: 2 }]);
  assert.equal(model.reliability.syncQueued, 3);
  assert.equal(model.reliability.outboxDrained, 2);
});

test("privacy-preserving cohorts produce the product scorecard and a real activation funnel", () => {
  const cohort = "2026-W35";
  const model = buildDashboardModel([
    row("first_open", 10, { install_cohort: cohort }),
    row("active_install_day", 8, { day: "2026-08-26", install_cohort: cohort }),
    row("active_install_day", 6, { day: "2026-08-27", install_cohort: cohort }),
    row("active_install_week", 9, { install_cohort: cohort }),
    row("first_picker_opened", 9, { game_source: "solo", context: "game_picker", install_cohort: cohort }),
    row("first_game_started", 8, { install_cohort: cohort }),
    row("first_valid_guess_submitted", 7, { mode: "lightning", game_source: "solo", install_cohort: cohort }),
    row("first_game_completed", 6, { install_cohort: cohort }),
    row("second_game_started", 5, { install_cohort: cohort }),
    row("returned_next_day", 4, { install_cohort: cohort }),
    row("returned_next_week", 3, { install_cohort: cohort }),
    row("game_completed", 18, { mode: "lightning", game_source: "solo", game_kind: "catalog", duration_bucket: "under_5m", outcome: "won" }),
    row("invite_created", 4, { mode: "classic", game_source: "friend", context: "invitation" }),
    row("invite_game_completed", 2, { mode: "classic", game_source: "invitation", context: "invitation" }),
    row("remix_opened", 5, { context: "remix_editor" }),
    row("remix_kept", 2, { mode: "custom", game_kind: "remixed", word_length: "7", context: "remix_editor" }),
  ]);

  assert.deepEqual(model.onboardingCohorts, [{
    key: cohort,
    firstOpen: 10,
    pickerOpened: 9,
    gameStarted: 8,
    firstGuess: 7,
    gameCompleted: 6,
    secondGame: 5,
    activationRatio: 0.6,
  }]);
  assert.equal(model.activeInstalls.averageDailyActiveInstalls, 7);
  assert.equal(model.activeInstalls.activeInstallWeeks, 9);
  assert.equal(model.activeInstalls.currentWeeklyActiveInstalls, 9);
  assert.deepEqual(model.scorecard.map(({ value }) => value), [0.6, 2, 0.5, 0.4, 0.3]);
});

test("current WAU uses the latest active week instead of summing the report window", () => {
  const model = buildDashboardModel([
    row("active_install_week", 10, { day: "2026-08-17", install_cohort: "2026-W34" }),
    row("active_install_week", 7, { day: "2026-08-24", install_cohort: "2026-W34" }),
    row("active_install_week", 2, { day: "2026-08-26", install_cohort: "2026-W35" }),
  ]);
  assert.equal(model.activeInstalls.activeInstallWeeks, 19);
  assert.equal(model.activeInstalls.currentWeeklyActiveInstalls, 9);
  assert.deepEqual(model.activeInstalls.weeklyActiveInstalls, [
    { key: "2026-08-17", count: 10 },
    { key: "2026-08-24", count: 9 },
  ]);
});

test("latency, conversion, duration, and data-health views retain their denominators", () => {
  const model = buildDashboardModel([
    row("game_started", 4, { mode: "cowpoke", game_source: "friend", game_kind: "remixed" }),
    row("game_completed", 3, { mode: "cowpoke", game_source: "friend", game_kind: "remixed", duration_bucket: "5_15m", outcome: "won" }),
    row("game_left", 1, { mode: "cowpoke", game_source: "friend", game_kind: "remixed", turn_bucket: "1_3" }),
    row("guess_submission_attempted", 10, { mode: "cowpoke", game_source: "friend", context: "move" }),
    row("move_submission_completed", 9, { mode: "cowpoke", game_source: "friend", context: "move", performance_bucket: "100_250ms" }),
    row("move_submission_failed", 1, { category: "reliability", mode: "cowpoke", game_source: "friend", context: "move", performance_bucket: "1_3s", reason: "cloudkit" }),
    row("invite_joined", 2, { mode: "cowpoke", game_source: "invitation", context: "invitation", performance_bucket: "250ms_1s" }),
    row("local_events_dropped", 2, { category: "reliability", app_version: "3.4.0" }),
    row("game_rule_used", 1, { mode: "custom", game_source: "solo", rule_id: "other" }),
  ]);

  assert.equal(model.moveExperience.observedSuccessRatio, 0.9);
  assert.deepEqual(model.moveExperience.failures, [{ key: "cloudkit", count: 1 }]);
  assert.deepEqual(model.inviteExperience.performance, [{ key: "250ms_1s", count: 2 }]);
  assert.equal(model.conversions.bySource[0].observedFinishRatio, 0.75);
  assert.equal(model.conversions.byGameKind[0].observedFinishRatio, 0.75);
  assert.equal(model.durationBreakdowns.byMode[0].buckets.find(({ key }) => key === "5_15m").count, 3);
  assert.equal(model.dataHealth.localEventsDropped, 2);
  assert.deepEqual(model.dataHealth.unknownDimensions, [{ key: "rule_id", count: 1 }]);
  const ruleQuality = model.dataHealth.dimensionQuality.find(({ key }) => key === "rule_id");
  assert.equal(ruleQuality.populated, 1);
  assert.equal(ruleQuality.unknownRatio, 1);
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
    { day: "2026-08-26", activeInstalls: 0, started: 0, completed: 1, left: 0, shares: 1 },
    { day: "2026-08-27", activeInstalls: 0, started: 2, completed: 0, left: 0, shares: 0 },
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
    "Are people finding something worth returning to?",
    "What kinds of games and rules are people using?",
    "Where do important flows succeed or stop?",
    "What helps people play, and where do they struggle?",
    "Are new players finding the game?",
    "What do people share, and how?",
    "Where do players need help?",
    "Does the app feel fast and dependable?",
    "What changed day by day?",
    "Can these numbers be trusted?",
  ]) assert.match(html, new RegExp(question.replace(/[?]/g, "\\?")));
  for (const id of [
    "scorecard-grid", "active-install-grid", "source-conversion-body", "kind-conversion-body",
    "mode-duration-body", "source-duration-body", "invite-experience-summary",
    "move-experience-summary", "cohort-body", "data-health-summary", "dimension-health-body",
  ]) assert.match(html, new RegExp(`id="${id}"`));
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
    game_kind: null,
    word_length: null,
    rule_id: null,
    share_source: null,
    share_channel: null,
    turn_bucket: null,
    duration_bucket: null,
    outcome: null,
    performance_bucket: null,
    reliability_reason: null,
    context: null,
    reason: null,
    install_cohort: null,
    count,
    ...overrides,
  };
}
