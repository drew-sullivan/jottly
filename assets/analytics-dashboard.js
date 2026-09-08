import { buildDashboardModel, preferredReleaseChannel } from "./analytics-dashboard-model.js";

const STORAGE_KEY = "jottly.analytics.reportToken";
const numberFormatter = new Intl.NumberFormat();
const refs = Object.fromEntries([
  "auth-section", "token-form", "token-input", "auth-error", "dashboard", "days-select",
  "channel-select", "version-select", "refresh-button", "download-button", "signout-button",
  "date-label", "status-live", "summary-grid", "insight-grid", "mode-body", "source-list",
  "creation-summary", "creation-mode-list", "creation-length-list", "created-rule-list",
  "game-kind-list", "word-length-list", "played-rule-list",
  "outcome-list", "onboarding-list", "sharing-summary", "share-source-list", "share-channel-list",
  "friction-grid", "left-turn-list", "reliability-summary", "cache-list", "reconcile-list",
  "offline-list", "sync-queue-list", "drain-performance-list", "activity-body",
  "start-funnel", "invite-funnel", "remix-funnel", "shared-game-funnel",
  "start-experience-summary", "start-performance-list", "start-failure-list",
  "suggestion-summary", "suggestion-context-list", "rules-help-summary", "rules-help-context-list",
  "notification-summary", "rule-outcome-body", "termination-list",
  "scorecard-grid", "active-install-grid", "source-conversion-body", "kind-conversion-body",
  "mode-duration-body", "source-duration-body", "invite-experience-summary",
  "invite-performance-list", "invite-failure-list", "move-experience-summary",
  "move-performance-list", "move-failure-list", "cohort-body", "data-health-summary",
  "health-version-list", "health-channel-list", "dimension-health-body",
  "community-summary", "community-selection-source-list", "community-start-source-list",
].map((id) => [id, document.getElementById(id)]));

let reportToken = sessionStorage.getItem(STORAGE_KEY) ?? "";
let latestReport = null;
let loading = false;
let filtersInitialized = false;

refs["token-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  const candidate = refs["token-input"].value.trim();
  if (!candidate) return;
  reportToken = candidate;
  sessionStorage.setItem(STORAGE_KEY, candidate);
  refs["token-input"].value = "";
  await loadReport();
});

refs["days-select"].addEventListener("change", loadReport);
refs["channel-select"].addEventListener("change", renderReport);
refs["version-select"].addEventListener("change", renderReport);
refs["refresh-button"].addEventListener("click", loadReport);
refs["download-button"].addEventListener("click", downloadReport);
refs["signout-button"].addEventListener("click", lockDashboard);

if (reportToken) loadReport();

async function loadReport() {
  if (!reportToken || loading) return;
  setLoading(true);
  setStatus("Loading aggregate events...");
  try {
    const days = refs["days-select"].value;
    const response = await fetch(`/api/analytics/v1/report?days=${encodeURIComponent(days)}`, {
      headers: { authorization: `Bearer ${reportToken}` },
      cache: "no-store",
    });
    if (response.status === 404) throw new DashboardError("That report token was not accepted.", "authorization");
    if (!response.ok) throw new DashboardError(`The report service returned ${response.status}.`, "service");
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.rows)) throw new DashboardError("The report response was malformed.", "service");
    latestReport = payload;
    showDashboard();
    updateFilterOptions(payload.rows);
    renderReport();
    setStatus(`Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
  } catch (error) {
    if (error instanceof DashboardError && error.kind === "authorization") {
      sessionStorage.removeItem(STORAGE_KEY);
      reportToken = "";
      showAuthentication(error.message);
    } else {
      const message = error instanceof DashboardError ? error.message : "Could not reach the analytics service.";
      if (latestReport) setStatus(message, true);
      else showAuthentication(message);
    }
  } finally {
    setLoading(false);
  }
}

function renderReport() {
  if (!latestReport) return;
  const model = buildDashboardModel(latestReport.rows, {
    channel: refs["channel-select"].value,
    version: refs["version-select"].value,
  });
  renderContext(model);
  renderSummary(model);
  renderScorecard(model);
  renderInsights(model.insights);
  renderModes(model.modes);
  renderConversionTable(refs["source-conversion-body"], model.conversions.bySource);
  renderConversionTable(refs["kind-conversion-body"], model.conversions.byGameKind);
  renderDurationTable(refs["mode-duration-body"], model.durationBreakdowns.byMode);
  renderDurationTable(refs["source-duration-body"], model.durationBreakdowns.bySource);
  renderGameDesign(model);
  renderCommunity(model.community);
  renderJourneys(model.journeys);
  renderExperienceQuality(model);
  renderBarList(refs["source-list"], model.gameSources);
  renderBarList(refs["outcome-list"], model.outcomes);
  renderMilestones(model.onboarding);
  renderCohorts(model.onboardingCohorts);
  renderSharing(model.sharing);
  renderFriction(model.friction);
  renderReliability(model.reliability);
  renderActivity(model.dailyActivity);
  renderDataHealth(model.dataHealth);
}

function renderScorecard(model) {
  refs["scorecard-grid"].replaceChildren(...model.scorecard.map((item) => metric(
    item.label,
    formatPercent(item.value),
    item.detail,
  )));
  const active = model.activeInstalls;
  refs["active-install-grid"].replaceChildren(
    metric("Approx. average DAU", formatDecimal(active.averageDailyActiveInstalls), `${active.activeInstallDays} active install-days`),
    metric("Approx. current WAU", active.currentWeeklyActiveInstalls, `${active.activeInstallWeeks} install-week events in window`),
    metric("Returned next day", active.returnedNextDay, `${active.firstOpens} first opens`),
    metric("Returned after a week", active.returnedNextWeek, `${active.firstOpens} first opens`),
  );
}

function renderGameDesign(model) {
  refs["creation-summary"].replaceChildren(
    metric("Games created", model.creations.total, "kept Remix games"),
    metric("Custom starts", groupCount(model.gameKinds, "remixed"), "saved or shared games"),
  );
  renderBarList(refs["creation-mode-list"], model.creations.modes);
  renderBarList(refs["creation-length-list"], model.creations.wordLengths);
  renderBarList(refs["created-rule-list"], model.creations.rules);
  renderBarList(refs["game-kind-list"], model.gameKinds);
  renderBarList(refs["word-length-list"], model.wordLengths);
  renderBarList(refs["played-rule-list"], model.playedRules);
}

function renderCommunity(community) {
  refs["community-summary"].replaceChildren(
    metric("Section opened", community.sectionOpened, "picker disclosures"),
    metric("Games selected", community.selected, "community card taps"),
    metric("Games started", community.started, `${formatPercent(community.observedStartRatio)} of selections`),
    metric("Games saved", community.saved, "added to Your Games"),
    metric("Catalog refresh", community.refreshSucceeded, `${community.refreshFailed} failed · ${community.cacheUsed} cache uses`),
  );
  renderBarList(refs["community-selection-source-list"], community.selectionsBySource);
  renderBarList(refs["community-start-source-list"], community.startsBySource);
}

function renderContext(model) {
  const range = model.dateRange.first
    ? `${formatDay(model.dateRange.first)} to ${formatDay(model.dateRange.last)}`
    : "No matching events";
  refs["date-label"].textContent = `${range} · ${numberFormatter.format(model.rowCount)} aggregate rows`;
}

function renderSummary(model) {
  const items = [
    metric("Games started", model.headline.started, "start events"),
    metric("Games finished", model.headline.completed, "finish events"),
    metric("Observed finish ratio", formatPercent(model.headline.observedFinishRatio), "not cohort-based"),
    metric("Player shares", model.headline.sharesCompleted, "completed shares"),
    metric("Offline fallbacks", model.headline.offlineFallbacks, "service fallback events"),
  ];
  refs["summary-grid"].replaceChildren(...items);
}

function renderInsights(insights) {
  if (!insights.length) {
    refs["insight-grid"].replaceChildren(emptyMessage("No signals for these filters yet."));
    return;
  }
  refs["insight-grid"].replaceChildren(...insights.map((insight) => {
    const card = element("article", "insight");
    card.append(
      element("p", "insight-label", insight.label),
      element("p", "insight-value", insight.value),
      element("p", "insight-detail", insight.detail),
    );
    return card;
  }));
}

function renderModes(modes) {
  refs["mode-body"].replaceChildren(...modes.map((mode) => {
    const row = document.createElement("tr");
    row.append(
      cell(mode.label, "mode-name"),
      cellNumber(mode.selected),
      cellNumber(mode.started),
      cellNumber(mode.completed),
      cellNumber(mode.left),
      cell(formatPercent(mode.observedFinishRatio)),
    );
    return row;
  }));
}

function renderConversionTable(container, conversions) {
  renderTableRows(container, conversions, 5, "No conversion events for these filters.", (item) => [
    cell(formatKey(item.key)),
    cellNumber(item.started),
    cellNumber(item.completed),
    cellNumber(item.left),
    cell(formatPercent(item.observedFinishRatio)),
  ]);
}

function renderDurationTable(container, breakdowns) {
  const order = ["under_5m", "5_15m", "15_60m", "1_24h", "1_7d", "7d_plus"];
  renderTableRows(container, breakdowns, 7, "No completion durations for these filters.", (item) => [
    cell(formatKey(item.key)),
    ...order.map((bucket) => cellNumber(groupCount(item.buckets, bucket))),
  ]);
}

function renderMilestones(milestones) {
  renderMilestoneList(refs["onboarding-list"], milestones);
}

function renderCohorts(cohorts) {
  renderTableRows(refs["cohort-body"], cohorts, 8, "No cohort-aware app events yet.", (cohort) => [
    cell(cohort.key),
    cellNumber(cohort.firstOpen),
    cellNumber(cohort.pickerOpened),
    cellNumber(cohort.gameStarted),
    cellNumber(cohort.firstGuess),
    cellNumber(cohort.gameCompleted),
    cellNumber(cohort.secondGame),
    cell(formatPercent(cohort.activationRatio)),
  ]);
}

function renderMilestoneList(container, milestones) {
  const max = Math.max(0, ...milestones.map((item) => item.count));
  container.replaceChildren(...milestones.map((item) => {
    const row = element("div", "milestone-row");
    row.append(
      element("span", "milestone-label", item.label),
      barTrack(item.count, max),
      element("strong", "bar-value", numberFormatter.format(item.count)),
    );
    return row;
  }));
}

function renderJourneys(journeys) {
  renderMilestoneList(refs["start-funnel"], journeys.gameStart);
  renderMilestoneList(refs["invite-funnel"], journeys.invitation);
  renderMilestoneList(refs["remix-funnel"], journeys.remix);
  renderMilestoneList(refs["shared-game-funnel"], journeys.sharedGame);
}

function renderExperienceQuality(model) {
  const start = model.startExperience;
  refs["start-experience-summary"].replaceChildren(
    metric("Start requested", start.requested, "player taps"),
    metric("Game ready", start.ready, "playable boards"),
    metric("Observed ready ratio", formatPercent(start.observedReadyRatio), "not cohort-based"),
    metric("Start failed", start.failed, "contained failures"),
  );
  renderBarList(refs["start-performance-list"], start.performance);
  renderBarList(refs["start-failure-list"], start.failures);

  const invite = model.inviteExperience;
  refs["invite-experience-summary"].replaceChildren(
    metric("Invites joined", invite.joined, "accepted game routes"),
    metric("Join failures", totalGroups(invite.failures), "contained failures"),
  );
  renderBarList(refs["invite-performance-list"], invite.performance);
  renderBarList(refs["invite-failure-list"], invite.failures);

  const moves = model.moveExperience;
  refs["move-experience-summary"].replaceChildren(
    metric("Attempts", moves.attempted, "submit actions"),
    metric("Completed", moves.completed, "accepted locally or remotely"),
    metric("Observed success", formatPercent(moves.observedSuccessRatio), "attempt denominator"),
    metric("Failed", moves.failed, "validation or sync failures"),
  );
  renderBarList(refs["move-performance-list"], moves.performance);
  renderBarList(refs["move-failure-list"], moves.failures);

  const suggestions = model.suggestions;
  refs["suggestion-summary"].replaceChildren(
    metric("Suggestions shown", suggestions.shown, "tray impressions"),
    metric("Suggestions used", suggestions.used, "word taps"),
    metric("Observed use ratio", formatPercent(suggestions.observedUseRatio), "not user-level"),
    metric("Observed submit ratio", formatPercent(suggestions.observedSubmitRatio), "shown denominator"),
    metric("Submitted", suggestions.submitted, `${suggestions.rejected} rejected`),
    metric("Unavailable", suggestions.unavailable, "empty trays"),
  );
  renderBarList(refs["suggestion-context-list"], suggestions.shownByContext);

  const rules = model.rulesHelp;
  refs["rules-help-summary"].replaceChildren(
    metric("Rules shown", rules.shown, "automatic explanations"),
    metric("Rules dismissed", rules.dismissed, "completed explanations"),
    metric("Rules reopened", rules.reopened, "full-sheet revisits"),
    metric("Observed reopen ratio", formatPercent(rules.observedReopenRatio), "rules-shown denominator"),
    metric("Symbols opened", rules.symbolsOpened, "inline help taps"),
  );
  renderBarList(refs["rules-help-context-list"], rules.helpByContext);

  const notifications = model.notifications;
  refs["notification-summary"].replaceChildren(
    metric("Permission prompts", notifications.permissionPrompted, `${notifications.permissionAccepted} allowed · ${notifications.permissionDeclined} declined`),
    metric("Registration", notifications.registrationSucceeded, `${notifications.registrationFailed} failed`),
    metric("Notifications opened", notifications.opened, "tap events"),
    metric("Observed route success", formatPercent(notifications.observedRouteRatio), `${notifications.routeFailed} failed`),
  );
  renderRuleOutcomes(model.ruleOutcomes);
  renderBarList(refs["termination-list"], model.terminations);
}

function renderRuleOutcomes(outcomes) {
  if (!outcomes.length) {
    const row = document.createElement("tr");
    const value = cell("No rule outcomes for these filters.");
    value.colSpan = 5;
    row.append(value);
    refs["rule-outcome-body"].replaceChildren(row);
    return;
  }
  refs["rule-outcome-body"].replaceChildren(...outcomes.map((outcome) => {
    const row = document.createElement("tr");
    row.append(
      cell(formatKey(outcome.key)),
      cellNumber(outcome.started),
      cellNumber(outcome.completed),
      cellNumber(outcome.left),
      cell(formatPercent(outcome.observedFinishRatio)),
    );
    return row;
  }));
}

function renderSharing(sharing) {
  refs["sharing-summary"].replaceChildren(
    metric("Sheets opened", sharing.opened, "player-facing shares"),
    metric("Shares completed", sharing.completed, "player-facing shares"),
    metric("Observed share completion", formatPercent(sharing.observedCompletionRatio), "not user-level"),
    metric("Problem reports", sharing.problemReports, "kept separate"),
  );
  renderBarList(refs["share-source-list"], sharing.sources);
  renderBarList(refs["share-channel-list"], sharing.channels);
}

function renderFriction(friction) {
  refs["friction-grid"].replaceChildren(
    metric("Invalid words", friction.invalidWords, `${formatPercent(friction.invalidWordRatio)} of ${friction.guessAttempts} attempts`),
    metric("Rules reopened", friction.rulesReopened, "help revisits"),
    metric("Suggestions used", friction.suggestedWordsUsed, "word nudges tapped"),
    metric("Games left", friction.gamesLeft, "leave events"),
    metric("Hard-word warnings", friction.warningsShown, `${friction.warningsProceeded} proceeded`),
    metric("Notification choice", friction.notificationAccepted + friction.notificationDeclined, `${friction.notificationAccepted} allowed · ${friction.notificationDeclined} declined`),
  );
  renderBarList(refs["left-turn-list"], friction.leftByTurn);
}

function renderReliability(reliability) {
  refs["reliability-summary"].replaceChildren(
    metric("Cache under 100 ms", formatPercent(reliability.cacheUnder100msRatio), `${reliability.cachePaints} paints`),
    metric("Reconciled within 3 s", formatPercent(reliability.reconcileUnder3sRatio), `${reliability.reconciles} reconciliations`),
    metric("Sync failures", totalGroups(reliability.syncFailureReasons), "ultimate failures"),
    metric("Syncs queued", reliability.syncQueued, `${reliability.syncRecovered} recoveries`),
    metric("Outboxes drained", reliability.outboxDrained, "completed recovery batches"),
    metric("Local events dropped", reliability.localEventsDropped, "analytics queue loss"),
  );
  renderBarList(refs["cache-list"], reliability.cachePerformance);
  renderBarList(refs["reconcile-list"], reliability.reconcilePerformance);
  const outageRows = mergeGroups(reliability.offlineReasons, reliability.syncFailureReasons);
  renderBarList(refs["offline-list"], outageRows);
  renderBarList(refs["sync-queue-list"], reliability.queueReasons);
  renderBarList(refs["drain-performance-list"], reliability.drainPerformance);
}

function renderActivity(activity) {
  if (!activity.length) {
    const row = document.createElement("tr");
    const value = cell("No daily activity for these filters.");
    value.colSpan = 6;
    row.append(value);
    refs["activity-body"].replaceChildren(row);
    return;
  }
  refs["activity-body"].replaceChildren(...[...activity].reverse().map((day) => {
    const row = document.createElement("tr");
    row.append(cell(formatDay(day.day)), cellNumber(day.activeInstalls), cellNumber(day.started), cellNumber(day.completed), cellNumber(day.left), cellNumber(day.shares));
    return row;
  }));
}

function renderDataHealth(health) {
  refs["data-health-summary"].replaceChildren(
    metric("Latest event", health.latestEventDay ? formatDay(health.latestEventDay) : "-", "most recent aggregate day"),
    metric("Aggregate rows", health.aggregateRows, `${numberFormatter.format(health.eventCount)} represented events`),
    metric("Missing cohort", health.cohortMilestonesMissingCohort, "legacy cohort milestones"),
    metric("Dropped locally", health.localEventsDropped, "analytics queue overflow"),
  );
  renderBarList(refs["health-version-list"], health.versions);
  renderBarList(refs["health-channel-list"], health.channels);
  renderTableRows(refs["dimension-health-body"], health.dimensionQuality, 5, "No dimension data yet.", (item) => [
    cell(formatKey(item.key)),
    cellNumber(item.populated),
    cell(formatPercent(item.coverageRatio)),
    cellNumber(item.unknown),
    cell(formatPercent(item.unknownRatio)),
  ]);
}

function renderTableRows(container, items, columnCount, emptyText, cells) {
  if (!items.length) {
    const row = document.createElement("tr");
    const value = cell(emptyText);
    value.colSpan = columnCount;
    row.append(value);
    container.replaceChildren(row);
    return;
  }
  container.replaceChildren(...items.map((item) => {
    const row = document.createElement("tr");
    row.append(...cells(item));
    return row;
  }));
}

function renderBarList(container, groups) {
  if (!groups.length) {
    container.replaceChildren(emptyMessage("No events for these filters."));
    return;
  }
  const max = Math.max(...groups.map((group) => group.count));
  container.replaceChildren(...groups.map((group) => {
    const row = element("div", "bar-row");
    row.append(
      element("span", "bar-label", formatKey(group.key)),
      barTrack(group.count, max),
      element("strong", "bar-value", numberFormatter.format(group.count)),
    );
    return row;
  }));
}

function updateFilterOptions(rows) {
  const currentChannel = refs["channel-select"].value;
  const currentVersion = refs["version-select"].value;
  const available = buildDashboardModel(rows).available;
  const channel = filtersInitialized ? currentChannel : preferredReleaseChannel(available.channels);
  replaceOptions(refs["channel-select"], "All channels", available.channels, channel);
  replaceOptions(refs["version-select"], "All versions", available.versions, currentVersion);
  filtersInitialized = true;
}

function replaceOptions(select, allLabel, values, selectedValue) {
  const all = option("all", allLabel);
  const choices = values.map((value) => option(value, formatKey(value)));
  select.replaceChildren(all, ...choices);
  select.value = values.includes(selectedValue) ? selectedValue : "all";
}

function showDashboard() {
  refs["auth-section"].hidden = true;
  refs.dashboard.hidden = false;
  refs["auth-error"].hidden = true;
}

function showAuthentication(message = "") {
  refs.dashboard.hidden = true;
  refs["auth-section"].hidden = false;
  refs["auth-error"].textContent = message;
  refs["auth-error"].hidden = !message;
  refs["token-input"].focus();
}

function lockDashboard() {
  sessionStorage.removeItem(STORAGE_KEY);
  reportToken = "";
  latestReport = null;
  filtersInitialized = false;
  showAuthentication();
}

function setLoading(value) {
  loading = value;
  refs["refresh-button"].disabled = value;
  refs["days-select"].disabled = value;
}

function setStatus(message, isError = false) {
  refs["status-live"].textContent = message;
  refs["status-live"].classList.toggle("error", isError);
}

function downloadReport() {
  if (!latestReport) return;
  const blob = new Blob([JSON.stringify(latestReport, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `jottly-analytics-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function metric(label, value, detail) {
  const card = element("article", "metric");
  card.append(
    element("p", "metric-label", label),
    element("p", "metric-value", typeof value === "number" ? numberFormatter.format(value) : value),
    element("p", "metric-detail", detail),
  );
  return card;
}

function barTrack(value, max) {
  const track = element("div", "bar-track");
  const fill = element("div", "bar-fill");
  fill.style.width = `${max ? Math.max(2, (value / max) * 100) : 0}%`;
  track.append(fill);
  return track;
}

function cell(value, className = "") {
  return element("td", className, value);
}

function cellNumber(value) {
  return cell(numberFormatter.format(value));
}

function element(tag, className = "", text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = String(text);
  return node;
}

function emptyMessage(message) {
  return element("p", "empty", message);
}

function option(value, label) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  return node;
}

function formatPercent(value) {
  return value === null ? "-" : `${Math.round(value * 100)}%`;
}

function formatDecimal(value) {
  return value === null ? "-" : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

function formatDay(day) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${day}T00:00:00Z`));
}

function formatKey(value) {
  const labels = {
    under_100ms: "Under 100 ms", "100_250ms": "100–250 ms", "250ms_1s": "250 ms–1 s",
    "1_3s": "1–3 s", "3s_plus": "3 s or more", zero: "Before a guess", "1_3": "Turns 1–3",
    "4_6": "Turns 4–6", "7_9": "Turns 7–9", "10_plus": "Turn 10 or later",
    under_5m: "Under 5 min", "5_15m": "5–15 min", "15_60m": "15–60 min",
    "1_24h": "1–24 hours", "1_7d": "1–7 days", "7d_plus": "7 days or more",
  };
  return labels[value] ?? String(value ?? "unknown").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function mergeGroups(...collections) {
  const counts = new Map();
  for (const collection of collections) {
    for (const group of collection) counts.set(group.key, (counts.get(group.key) ?? 0) + group.count);
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

function totalGroups(groups) {
  return groups.reduce((total, group) => total + group.count, 0);
}

function groupCount(groups, key) {
  return groups.find((group) => group.key === key)?.count ?? 0;
}

class DashboardError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}
