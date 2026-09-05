export const MODE_ORDER = Object.freeze(["lightning", "cowpoke", "classic", "shapeshifter", "mystery", "custom"]);
export const MODE_LABELS = Object.freeze({
  lightning: "Lightning",
  cowpoke: "Cowpoke",
  classic: "Classic",
  shapeshifter: "Shapeshifter",
  mystery: "Mystery",
  custom: "Custom",
});

export function preferredReleaseChannel(channels) {
  if (channels.includes("appstore")) return "appstore";
  if (channels.includes("testflight")) return "testflight";
  return "all";
}

const TURN_ORDER = Object.freeze(["zero", "1_3", "4_6", "7_9", "10_plus"]);
const WORD_LENGTH_ORDER = Object.freeze(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "other"]);
const DURATION_ORDER = Object.freeze(["under_5m", "5_15m", "15_60m", "1_24h", "1_7d", "7d_plus"]);
const PERFORMANCE_ORDER = Object.freeze(["under_100ms", "100_250ms", "250ms_1s", "1_3s", "3s_plus"]);
const SOURCE_ORDER = Object.freeze(["solo", "friend", "invitation", "rematch", "daily"]);
const KIND_ORDER = Object.freeze(["catalog", "remixed", "unlisted"]);
const PRODUCT_SHARE_SOURCES = new Set([
  "friend_invitation", "game_result", "daily_result", "streak", "monthly_best", "tell_a_friend", "other",
]);

export function buildDashboardModel(inputRows, filters = {}) {
  const allRows = normalizeRows(inputRows);
  const available = {
    channels: sortedUnique(allRows.map((row) => row.release_channel)),
    versions: sortedUnique(allRows.map((row) => row.app_version), compareVersionsDescending),
  };
  const rows = allRows.filter((row) => matchesFilters(row, filters));
  const eventCount = (event, predicate = () => true) => sum(rows, (row) => row.event === event && predicate(row));
  const started = eventCount("game_started");
  const completed = eventCount("game_completed");
  const left = eventCount("game_left");

  const modes = MODE_ORDER.map((mode) => {
    const modeStarted = eventCount("game_started", (row) => row.mode === mode);
    const modeCompleted = eventCount("game_completed", (row) => row.mode === mode);
    const modeLeft = eventCount("game_left", (row) => row.mode === mode);
    return {
      key: mode,
      label: MODE_LABELS[mode],
      selected: eventCount("mode_selected", (row) => row.mode === mode),
      started: modeStarted,
      completed: modeCompleted,
      left: modeLeft,
      observedFinishRatio: ratio(modeCompleted, modeStarted),
      outcomes: groupedCounts(rows, "outcome", (row) => row.event === "game_completed" && row.mode === mode),
    };
  });

  const productShareRows = rows.filter((row) => PRODUCT_SHARE_SOURCES.has(row.share_source));
  const shareOpened = sum(productShareRows, (row) => row.event === "share_sheet_opened");
  const shareCompleted = sum(productShareRows, (row) => row.event === "share_completed");
  const shareCancelled = sum(productShareRows, (row) => row.event === "share_cancelled");
  const cachePerformance = groupedCounts(rows, "performance_bucket", (row) => row.event === "home_cache_painted", PERFORMANCE_ORDER);
  const reconcilePerformance = groupedCounts(rows, "performance_bucket", (row) => row.event === "home_reconciled", PERFORMANCE_ORDER);
  const cachePaints = totalGroups(cachePerformance);
  const reconciles = totalGroups(reconcilePerformance);
  const startRequested = eventCount("game_start_requested");
  const gameReady = eventCount("game_ready");
  const suggestionsShown = eventCount("suggestions_shown");
  const suggestedWordsUsed = eventCount("suggested_word_used");
  const notificationOpened = eventCount("notification_opened");
  const notificationRouteSucceeded = eventCount("notification_route_succeeded");
  const firstOpen = eventCount("first_open");
  const activeInstallDays = eventCount("active_install_day");
  const activeInstallWeeks = eventCount("active_install_week");
  const weeklyActiveInstalls = activeInstallSeries(rows, "active_install_week", weekStart);
  const inviteCreated = eventCount("invite_created");
  const inviteCompleted = eventCount("invite_game_completed");
  const remixOpened = eventCount("remix_opened");
  const remixKept = eventCount("remix_kept");
  const remixShared = eventCount("shared_game_reshared");
  const guessAttempts = eventCount("guess_submission_attempted");
  const invalidWords = eventCount("invalid_word_rejected");
  const rulesShown = eventCount("rules_shown");
  const rulesReopened = eventCount("rules_reopened");
  const activeCalendarDays = distinctCalendarDays(rows);

  const model = {
    rowCount: rows.length,
    available,
    dateRange: dateRange(rows),
    headline: {
      started,
      completed,
      left,
      observedFinishRatio: ratio(completed, started),
      sharesCompleted: shareCompleted,
      offlineFallbacks: eventCount("offline_fallback_entered"),
    },
    scorecard: [
      score("Activation", ratio(eventCount("first_game_completed"), firstOpen), `${eventCount("first_game_completed")} first games finished / ${firstOpen} first opens`),
      score("Engagement", ratio(completed, activeInstallWeeks), `${completed} finishes / ${activeInstallWeeks} weekly active installs`),
      score("Connection", ratio(inviteCompleted, inviteCreated), `${inviteCompleted} invited games finished / ${inviteCreated} created`),
      score("Creation", ratio(remixKept, remixOpened), `${remixKept} games kept / ${remixOpened} Remix opens`),
      score("Retention", ratio(eventCount("returned_next_week"), firstOpen), `${eventCount("returned_next_week")} returned after a week / ${firstOpen} first opens`),
    ],
    activeInstalls: {
      firstOpens: firstOpen,
      activeInstallDays,
      activeInstallWeeks,
      currentWeeklyActiveInstalls: weeklyActiveInstalls.at(-1)?.count ?? 0,
      weeklyActiveInstalls,
      averageDailyActiveInstalls: activeCalendarDays ? activeInstallDays / activeCalendarDays : null,
      returnedNextDay: eventCount("returned_next_day"),
      returnedNextWeek: eventCount("returned_next_week"),
    },
    onboardingCohorts: buildOnboardingCohorts(rows),
    modes,
    creations: {
      total: eventCount("game_created"),
      modes: groupedCounts(rows, "mode", (row) => row.event === "game_created"),
      kinds: groupedCounts(rows, "game_kind", (row) => row.event === "game_created"),
      wordLengths: groupedCounts(rows, "word_length", (row) => row.event === "game_created", WORD_LENGTH_ORDER),
      rules: groupedCounts(rows, "rule_id", (row) => row.event === "game_rule_created"),
    },
    gameKinds: groupedCounts(rows, "game_kind", (row) => row.event === "game_started"),
    wordLengths: groupedCounts(rows, "word_length", (row) => row.event === "game_started", WORD_LENGTH_ORDER),
    playedRules: groupedCounts(rows, "rule_id", (row) => row.event === "game_rule_used"),
    gameSources: groupedCounts(rows, "game_source", (row) => row.event === "game_started"),
    outcomes: groupedCounts(rows, "outcome", (row) => row.event === "game_completed"),
    durations: groupedCounts(rows, "duration_bucket", (row) => row.event === "game_completed", DURATION_ORDER),
    journeys: {
      gameStart: journey([
        ["Picker opened", "game_picker_opened"],
        ["Start requested", "game_start_requested"],
        ["Game ready", "game_ready"],
        ["Start failed", "game_start_failed"],
      ], eventCount),
      invitation: journey([
        ["Invite created", "invite_created"],
        ["Invite shared", "share_completed", (row) => row.share_source === "friend_invitation"],
        ["Invite opened", "invite_opened"],
        ["Invite visible", "invite_visible"],
        ["Invite accepted", "invite_accepted"],
        ["Game joined", "invite_joined"],
        ["First move", "invite_first_move_submitted"],
        ["Game finished", "invite_game_completed"],
        ["Invite failed", "invite_failed"],
      ], eventCount),
      remix: journey([
        ["Remix opened", "remix_opened"],
        ["Template selected", "remix_template_selected"],
        ["Rule edited", "remix_rule_edited"],
        ["Randomized", "remix_randomized"],
        ["Playtest started", "remix_playtest_started"],
        ["Playtest stopped", "remix_playtest_stopped"],
        ["Playtest completed", "remix_playtest_completed"],
        ["Game kept", "remix_kept"],
        ["Game shared", "shared_game_reshared"],
        ["Shared game imported", "shared_game_saved"],
        ["Shared game remixed", "shared_game_remixed"],
      ], eventCount),
      sharedGame: journey([
        ["Shared game opened", "shared_game_opened"],
        ["Saved", "shared_game_saved"],
        ["Started", "shared_game_started"],
        ["Remixed", "shared_game_remixed"],
        ["Reshared", "shared_game_reshared"],
      ], eventCount),
    },
    startExperience: {
      requested: startRequested,
      ready: gameReady,
      failed: eventCount("game_start_failed"),
      observedReadyRatio: ratio(gameReady, startRequested),
      performance: groupedCounts(rows, "performance_bucket", (row) => row.event === "game_ready", PERFORMANCE_ORDER),
      failures: groupedCounts(rows, "reason", (row) => row.event === "game_start_failed"),
    },
    inviteExperience: {
      joined: eventCount("invite_joined"),
      performance: groupedCounts(rows, "performance_bucket", (row) => row.event === "invite_joined", PERFORMANCE_ORDER),
      failures: groupedCounts(rows, "reason", (row) => row.event === "invite_failed"),
    },
    moveExperience: {
      attempted: guessAttempts,
      completed: eventCount("move_submission_completed"),
      failed: eventCount("move_submission_failed"),
      observedSuccessRatio: ratio(eventCount("move_submission_completed"), guessAttempts),
      performance: groupedCounts(rows, "performance_bucket", (row) => row.event === "move_submission_completed", PERFORMANCE_ORDER),
      failures: groupedCounts(rows, "reason", (row) => row.event === "move_submission_failed"),
    },
    ruleOutcomes: buildRuleOutcomes(rows),
    suggestions: {
      shown: suggestionsShown,
      unavailable: eventCount("suggestions_unavailable"),
      used: suggestedWordsUsed,
      submitted: eventCount("suggested_word_submitted"),
      rejected: eventCount("suggested_word_rejected"),
      observedUseRatio: ratio(suggestedWordsUsed, suggestionsShown),
      observedSubmitRatio: ratio(eventCount("suggested_word_submitted"), suggestionsShown),
      shownByContext: groupedCounts(rows, "context", (row) => row.event === "suggestions_shown"),
    },
    rulesHelp: {
      shown: rulesShown,
      dismissed: eventCount("rules_dismissed"),
      reopened: rulesReopened,
      observedReopenRatio: ratio(rulesReopened, rulesShown),
      symbolsOpened: eventCount("rule_symbol_opened"),
      helpByContext: groupedCounts(
        rows,
        "context",
        (row) => row.event === "rules_reopened" || row.event === "rule_symbol_opened",
      ),
    },
    notifications: {
      permissionPrompted: eventCount("notification_permission_prompt_shown"),
      permissionAccepted: eventCount("notification_permission_accepted"),
      permissionDeclined: eventCount("notification_permission_declined"),
      permissionFailed: eventCount("notification_permission_failed"),
      registrationSucceeded: eventCount("notification_registration_succeeded"),
      registrationFailed: eventCount("notification_registration_failed"),
      opened: notificationOpened,
      routeSucceeded: notificationRouteSucceeded,
      routeFailed: eventCount("notification_route_failed"),
      observedRouteRatio: ratio(notificationRouteSucceeded, notificationOpened),
    },
    terminations: groupedCounts(rows, "reason", (row) => row.event === "game_terminated"),
    onboarding: [
      milestone("First game started", "first_game_started", eventCount),
      milestone("First valid guess", "first_valid_guess_submitted", eventCount),
      milestone("First game finished", "first_game_completed", eventCount),
      milestone("Second game started", "second_game_started", eventCount),
      milestone("First friend invited", "first_friend_invited", eventCount),
      milestone("First friend game finished", "first_friend_game_completed", eventCount),
      milestone("First rematch started", "first_rematch_started", eventCount),
      milestone("Returned next day", "returned_next_day", eventCount),
      milestone("Returned next week", "returned_next_week", eventCount),
    ],
    sharing: {
      opened: shareOpened,
      completed: shareCompleted,
      cancelled: shareCancelled,
      observedCompletionRatio: ratio(shareCompleted, shareOpened),
      sources: groupedCounts(productShareRows, "share_source", (row) => row.event === "share_completed"),
      channels: groupedCounts(productShareRows, "share_channel", (row) => row.event === "share_completed"),
      problemReports: sum(rows, (row) => row.event === "share_completed" && row.share_source === "problem_report"),
    },
    friction: {
      invalidWords,
      guessAttempts,
      invalidWordRatio: ratio(invalidWords, guessAttempts),
      rulesReopened,
      suggestedWordsUsed: eventCount("suggested_word_used"),
      warningsShown: eventCount("secret_word_warning_shown"),
      warningsProceeded: eventCount("secret_word_warning_proceeded"),
      notificationAccepted: eventCount("notification_permission_accepted"),
      notificationDeclined: eventCount("notification_permission_declined"),
      gamesLeft: left,
      leftByTurn: groupedCounts(rows, "turn_bucket", (row) => row.event === "game_left", TURN_ORDER),
    },
    reliability: {
      cachePerformance,
      reconcilePerformance,
      cachePaints,
      reconciles,
      cacheUnder100msRatio: ratio(groupValue(cachePerformance, "under_100ms"), cachePaints),
      reconcileUnder3sRatio: ratio(sumGroups(reconcilePerformance, ["under_100ms", "100_250ms", "250ms_1s", "1_3s"]), reconciles),
      offlineReasons: groupedCounts(rows, "reliability_reason", (row) => row.event === "offline_fallback_entered"),
      syncFailureReasons: groupedCounts(rows, "reliability_reason", (row) => row.event === "sync_ultimately_failed"),
      syncQueued: eventCount("sync_operation_queued"),
      syncRecovered: eventCount("sync_recovered"),
      outboxDrained: eventCount("outbox_drained"),
      queueReasons: groupedCounts(rows, "reason", (row) => row.event === "sync_operation_queued"),
      drainPerformance: groupedCounts(rows, "performance_bucket", (row) => row.event === "outbox_drained", PERFORMANCE_ORDER),
      localEventsDropped: eventCount("local_events_dropped"),
    },
    durationBreakdowns: {
      byMode: buildDurationBreakdown(rows, "mode", MODE_ORDER),
      bySource: buildDurationBreakdown(rows, "game_source", SOURCE_ORDER),
    },
    conversions: {
      bySource: buildConversion(rows, "game_source", SOURCE_ORDER),
      byGameKind: buildConversion(rows, "game_kind", KIND_ORDER),
    },
    dataHealth: buildDataHealth(rows),
    dailyActivity: dailyActivity(rows),
  };
  model.insights = buildInsights(model);
  return model;
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const count = Number(row.count);
    if (!Number.isFinite(count) || count <= 0) return [];
    return [{ ...row, count }];
  });
}

function matchesFilters(row, filters) {
  const channel = filters.channel ?? "all";
  const version = filters.version ?? "all";
  return (channel === "all" || row.release_channel === channel)
    && (version === "all" || row.app_version === version);
}

function sum(rows, predicate) {
  return rows.reduce((total, row) => total + (predicate(row) ? row.count : 0), 0);
}

function groupedCounts(rows, key, predicate, order = []) {
  const counts = new Map();
  for (const row of rows) {
    if (!predicate(row)) continue;
    const value = row[key] ?? "unknown";
    counts.set(value, (counts.get(value) ?? 0) + row.count);
  }
  const orderIndex = new Map(order.map((value, index) => [value, index]));
  return [...counts.entries()]
    .map(([keyValue, count]) => ({ key: keyValue, count }))
    .sort((a, b) => {
      const aIndex = orderIndex.get(a.key);
      const bIndex = orderIndex.get(b.key);
      if (aIndex !== undefined || bIndex !== undefined) return (aIndex ?? Number.MAX_SAFE_INTEGER) - (bIndex ?? Number.MAX_SAFE_INTEGER);
      return b.count - a.count || a.key.localeCompare(b.key);
    });
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function milestone(label, event, eventCount) {
  return { key: event, label, count: eventCount(event) };
}

function journey(definitions, eventCount) {
  return definitions.map(([label, event, predicate]) => ({
    key: event,
    event,
    label,
    count: eventCount(event, predicate),
  }));
}

function score(label, value, detail) {
  return { label, value, detail };
}

function buildOnboardingCohorts(rows) {
  const stages = [
    ["firstOpen", "first_open"],
    ["pickerOpened", "first_picker_opened"],
    ["gameStarted", "first_game_started"],
    ["firstGuess", "first_valid_guess_submitted"],
    ["gameCompleted", "first_game_completed"],
    ["secondGame", "second_game_started"],
  ];
  const cohorts = new Map();
  for (const row of rows) {
    if (!row.install_cohort) continue;
    const stage = stages.find(([, event]) => event === row.event)?.[0];
    if (!stage) continue;
    const cohort = cohorts.get(row.install_cohort) ?? { key: row.install_cohort };
    cohort[stage] = (cohort[stage] ?? 0) + row.count;
    cohorts.set(row.install_cohort, cohort);
  }
  return [...cohorts.values()]
    .map((cohort) => ({
      ...Object.fromEntries(stages.map(([stage]) => [stage, cohort[stage] ?? 0])),
      ...cohort,
      activationRatio: ratio(cohort.gameCompleted ?? 0, cohort.firstOpen ?? 0),
    }))
    .sort((a, b) => b.key.localeCompare(a.key));
}

function buildDurationBreakdown(rows, dimension, order) {
  const keys = new Set(rows
    .filter((row) => row.event === "game_completed" && row[dimension])
    .map((row) => row[dimension]));
  return sortKeys([...keys], order).map((key) => ({
    key,
    buckets: groupedCounts(
      rows,
      "duration_bucket",
      (row) => row.event === "game_completed" && row[dimension] === key,
      DURATION_ORDER,
    ),
  }));
}

function buildConversion(rows, dimension, order) {
  const keys = new Set(rows
    .filter((row) => ["game_started", "game_completed", "game_left"].includes(row.event) && row[dimension])
    .map((row) => row[dimension]));
  return sortKeys([...keys], order).map((key) => {
    const started = sum(rows, (row) => row.event === "game_started" && row[dimension] === key);
    const completed = sum(rows, (row) => row.event === "game_completed" && row[dimension] === key);
    const left = sum(rows, (row) => row.event === "game_left" && row[dimension] === key);
    return { key, started, completed, left, observedFinishRatio: ratio(completed, started) };
  });
}

function buildDataHealth(rows) {
  const dimensions = ["mode", "game_source", "game_kind", "word_length", "rule_id", "context", "reason"];
  const unknownDimensions = dimensions.map((dimension) => ({
    key: dimension,
    count: sum(rows, (row) => row[dimension] === "unknown" || row[dimension] === "other"),
  })).filter(({ count }) => count > 0);
  const totalEvents = rows.reduce((total, row) => total + row.count, 0);
  const dimensionQuality = dimensions.map((dimension) => {
    const populated = sum(rows, (row) => row[dimension] !== null && row[dimension] !== undefined);
    const unknown = sum(rows, (row) => row[dimension] === "unknown" || row[dimension] === "other");
    return {
      key: dimension,
      populated,
      unknown,
      coverageRatio: ratio(populated, totalEvents),
      unknownRatio: ratio(unknown, populated),
    };
  });
  const cohortMilestoneEvents = new Set([
    "first_open", "first_picker_opened", "first_game_started", "first_valid_guess_submitted",
    "first_game_completed", "second_game_started", "returned_next_day", "returned_next_week",
  ]);
  return {
    latestEventDay: dateRange(rows).last,
    aggregateRows: rows.length,
    eventCount: totalEvents,
    versions: groupedCounts(rows, "app_version", () => true),
    channels: groupedCounts(rows, "release_channel", () => true),
    unknownDimensions,
    dimensionQuality,
    cohortMilestonesMissingCohort: sum(
      rows,
      (row) => cohortMilestoneEvents.has(row.event) && !row.install_cohort,
    ),
    localEventsDropped: sum(rows, (row) => row.event === "local_events_dropped"),
  };
}

function buildRuleOutcomes(rows) {
  const started = groupedCounts(rows, "rule_id", (row) => row.event === "game_rule_used");
  const completed = groupedCounts(rows, "rule_id", (row) => row.event === "game_rule_completed");
  const left = groupedCounts(rows, "rule_id", (row) => row.event === "game_rule_left");
  const keys = new Set([...started, ...completed, ...left].map(({ key }) => key));
  return [...keys].map((key) => {
    const startedCount = groupValue(started, key);
    const completedCount = groupValue(completed, key);
    const leftCount = groupValue(left, key);
    return {
      key,
      started: startedCount,
      completed: completedCount,
      left: leftCount,
      observedFinishRatio: ratio(completedCount, startedCount),
    };
  }).sort((a, b) => b.started - a.started || a.key.localeCompare(b.key));
}

function dateRange(rows) {
  const days = sortedUnique(rows.map((row) => row.day));
  return days.length ? { first: days[0], last: days.at(-1) } : { first: null, last: null };
}

function dailyActivity(rows) {
  const byDay = new Map();
  for (const row of rows) {
    if (!row.day) continue;
    const day = byDay.get(row.day) ?? { day: row.day, activeInstalls: 0, started: 0, completed: 0, left: 0, shares: 0 };
    if (row.event === "active_install_day") day.activeInstalls += row.count;
    if (row.event === "game_started") day.started += row.count;
    if (row.event === "game_completed") day.completed += row.count;
    if (row.event === "game_left") day.left += row.count;
    if (row.event === "share_completed" && PRODUCT_SHARE_SOURCES.has(row.share_source)) day.shares += row.count;
    byDay.set(row.day, day);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function distinctCalendarDays(rows) {
  const range = dateRange(rows);
  if (!range.first || !range.last) return 0;
  return Math.floor((Date.parse(`${range.last}T00:00:00Z`) - Date.parse(`${range.first}T00:00:00Z`)) / 86_400_000) + 1;
}

function activeInstallSeries(rows, event, period) {
  const counts = new Map();
  for (const row of rows) {
    if (row.event !== event || !row.day) continue;
    const key = period(row.day);
    counts.set(key, (counts.get(key) ?? 0) + row.count);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function weekStart(day) {
  const date = new Date(`${day}T00:00:00Z`);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

function sortKeys(keys, order) {
  const index = new Map(order.map((key, position) => [key, position]));
  return keys.sort((a, b) => (index.get(a) ?? Number.MAX_SAFE_INTEGER) - (index.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b));
}

function buildInsights(model) {
  if (!model.rowCount) return [];
  const topMode = [...model.modes].sort((a, b) => b.started - a.started)[0];
  const topSource = model.gameSources[0];
  const mostFinished = [...model.modes].sort((a, b) => b.completed - a.completed)[0];
  const insights = [];
  if (topMode?.started) insights.push({ label: "Most started", value: topMode.label, detail: `${topMode.started} starts` });
  if (mostFinished?.completed) insights.push({ label: "Most finished", value: mostFinished.label, detail: `${mostFinished.completed} finishes` });
  if (topSource?.count) insights.push({ label: "Top game source", value: humanize(topSource.key), detail: `${topSource.count} starts` });
  if (model.reliability.cachePaints) {
    insights.push({
      label: "Fast cache paints",
      value: percent(model.reliability.cacheUnder100msRatio),
      detail: "under 100 ms",
    });
  }
  return insights;
}

function sortedUnique(values, comparator = (a, b) => a.localeCompare(b)) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length))].sort(comparator);
}

function compareVersionsDescending(a, b) {
  const parts = (value) => value.split(".").map((part) => Number(part));
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function totalGroups(groups) {
  return groups.reduce((total, group) => total + group.count, 0);
}

function groupValue(groups, key) {
  return groups.find((group) => group.key === key)?.count ?? 0;
}

function sumGroups(groups, keys) {
  const allowed = new Set(keys);
  return groups.reduce((total, group) => total + (allowed.has(group.key) ? group.count : 0), 0);
}

function humanize(value) {
  return String(value ?? "unknown").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function percent(value) {
  return value === null ? "-" : `${Math.round(value * 100)}%`;
}
