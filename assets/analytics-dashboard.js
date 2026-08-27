import { buildDashboardModel, preferredReleaseChannel } from "./analytics-dashboard-model.js";

const STORAGE_KEY = "jottly.analytics.reportToken";
const numberFormatter = new Intl.NumberFormat();
const refs = Object.fromEntries([
  "auth-section", "token-form", "token-input", "auth-error", "dashboard", "days-select",
  "channel-select", "version-select", "refresh-button", "download-button", "signout-button",
  "date-label", "status-live", "summary-grid", "insight-grid", "mode-body", "source-list",
  "outcome-list", "onboarding-list", "sharing-summary", "share-source-list", "share-channel-list",
  "friction-grid", "left-turn-list", "reliability-summary", "cache-list", "reconcile-list",
  "offline-list", "activity-body",
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
  renderInsights(model.insights);
  renderModes(model.modes);
  renderBarList(refs["source-list"], model.gameSources);
  renderBarList(refs["outcome-list"], model.outcomes);
  renderMilestones(model.onboarding);
  renderSharing(model.sharing);
  renderFriction(model.friction);
  renderReliability(model.reliability);
  renderActivity(model.dailyActivity);
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

function renderMilestones(milestones) {
  const max = Math.max(0, ...milestones.map((item) => item.count));
  refs["onboarding-list"].replaceChildren(...milestones.map((item) => {
    const row = element("div", "milestone-row");
    row.append(
      element("span", "milestone-label", item.label),
      barTrack(item.count, max),
      element("strong", "bar-value", numberFormatter.format(item.count)),
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
    metric("Invalid words", friction.invalidWords, "rejection events"),
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
    metric("Local events dropped", reliability.localEventsDropped, "analytics queue loss"),
  );
  renderBarList(refs["cache-list"], reliability.cachePerformance);
  renderBarList(refs["reconcile-list"], reliability.reconcilePerformance);
  const outageRows = mergeGroups(reliability.offlineReasons, reliability.syncFailureReasons);
  renderBarList(refs["offline-list"], outageRows);
}

function renderActivity(activity) {
  if (!activity.length) {
    const row = document.createElement("tr");
    const value = cell("No daily activity for these filters.");
    value.colSpan = 5;
    row.append(value);
    refs["activity-body"].replaceChildren(row);
    return;
  }
  refs["activity-body"].replaceChildren(...[...activity].reverse().map((day) => {
    const row = document.createElement("tr");
    row.append(cell(formatDay(day.day)), cellNumber(day.started), cellNumber(day.completed), cellNumber(day.left), cellNumber(day.shares));
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

class DashboardError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}
