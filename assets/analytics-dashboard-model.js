export const MODE_ORDER = Object.freeze(["lightning", "cowpoke", "classic", "shapeshifter", "mystery"]);
export const MODE_LABELS = Object.freeze({
  lightning: "Lightning",
  cowpoke: "Cowpoke",
  classic: "Classic",
  shapeshifter: "Shapeshifter",
  mystery: "Mystery",
});

export function preferredReleaseChannel(channels) {
  if (channels.includes("appstore")) return "appstore";
  if (channels.includes("testflight")) return "testflight";
  return "all";
}

const TURN_ORDER = Object.freeze(["zero", "1_3", "4_6", "7_9", "10_plus"]);
const DURATION_ORDER = Object.freeze(["under_5m", "5_15m", "15_60m", "1_24h", "1_7d", "7d_plus"]);
const PERFORMANCE_ORDER = Object.freeze(["under_100ms", "100_250ms", "250ms_1s", "1_3s", "3s_plus"]);
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
    modes,
    gameSources: groupedCounts(rows, "game_source", (row) => row.event === "game_started"),
    outcomes: groupedCounts(rows, "outcome", (row) => row.event === "game_completed"),
    durations: groupedCounts(rows, "duration_bucket", (row) => row.event === "game_completed", DURATION_ORDER),
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
      invalidWords: eventCount("invalid_word_rejected"),
      rulesReopened: eventCount("rules_reopened"),
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
      localEventsDropped: eventCount("local_events_dropped"),
    },
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

function dateRange(rows) {
  const days = sortedUnique(rows.map((row) => row.day));
  return days.length ? { first: days[0], last: days.at(-1) } : { first: null, last: null };
}

function dailyActivity(rows) {
  const byDay = new Map();
  for (const row of rows) {
    if (!row.day) continue;
    const day = byDay.get(row.day) ?? { day: row.day, started: 0, completed: 0, left: 0, shares: 0 };
    if (row.event === "game_started") day.started += row.count;
    if (row.event === "game_completed") day.completed += row.count;
    if (row.event === "game_left") day.left += row.count;
    if (row.event === "share_completed" && PRODUCT_SHARE_SOURCES.has(row.share_source)) day.shares += row.count;
    byDay.set(row.day, day);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
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
