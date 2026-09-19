const endpoint = "/api/dev-reports/v1";
const storageKey = "jottly.analytics.reportToken";
const tickets = document.querySelector("#tickets");
const notice = document.querySelector("#notice");
const status = document.querySelector("#status");
const workspace = document.querySelector(".workspace");
const toolbar = document.querySelector(".toolbar");
const authForm = document.querySelector("#auth-form");
const tokenInput = document.querySelector("#token-input");
const signout = document.querySelector("#signout");
let reportToken = sessionStorage.getItem(storageKey) ?? "";
let openID = null;
let authGeneration = 0;

async function requestJSON(url) {
  const token = reportToken;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (response.status === 404) {
    if (token === reportToken) lock("That dashboard token was not accepted.");
    throw new Error("That dashboard token was not accepted.");
  }
  if (!response.ok) throw new Error(`The report service returned ${response.status}.`);
  return response.json();
}

async function refresh() {
  if (!reportToken) return;
  const generation = authGeneration;
  authForm.hidden = true;
  toolbar.hidden = false;
  workspace.hidden = false;
  notice.textContent = "Loading reports…";
  tickets.replaceChildren();
  openID = null;
  try {
    const reports = (await requestJSON(`${endpoint}?status=${encodeURIComponent(status.value)}`)).reports;
    if (generation !== authGeneration) return;
    if (!Array.isArray(reports)) throw new Error("The report service returned an invalid list.");
    notice.textContent = reports.length === 0 ? "No reports in this view." : `${reports.length} reports`;
    for (const report of reports) {
      tickets.append(reportRow(report));
    }
  } catch (error) {
    if (reportToken) notice.textContent = error.message;
  }
}

function reportRow(report) {
  const row = document.createElement("tr");
  row.dataset.reportID = report.id;
  const id = document.createElement("td");
  id.textContent = displayID(report);
  const description = document.createElement("td");
  description.textContent = report.description;
  const state = document.createElement("td");
  const stateText = document.createElement("span");
  stateText.className = `status status-${report.status}`;
  const icon = document.createElement("span");
  icon.className = "status-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = statusIcon(report.status);
  const label = document.createElement("span");
  label.textContent = report.status.replaceAll("_", " ");
  stateText.append(icon, label);
  state.append(stateText);
  const diagnostics = document.createElement("td");
  if (report.status === "fixed") {
    const cleared = document.createElement("span");
    cleared.className = "fixed-note";
    cleared.textContent = "Cleared";
    diagnostics.append(cleared);
  } else {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "diagnostic-toggle";
    button.textContent = "View";
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", () => toggleDiagnostics(report.id, row, button));
    diagnostics.append(button);
  }
  row.append(id, description, state, diagnostics);
  return row;
}

async function toggleDiagnostics(id, row, button) {
  const existing = row.nextElementSibling?.dataset?.detailFor === id ? row.nextElementSibling : null;
  if (existing) {
    existing.remove();
    button.textContent = "View";
    button.setAttribute("aria-expanded", "false");
    openID = null;
    return;
  }
  const prior = tickets.querySelector(".diagnostic-row");
  if (prior) prior.remove();
  for (const toggle of tickets.querySelectorAll(".diagnostic-toggle")) {
    toggle.textContent = "View";
    toggle.setAttribute("aria-expanded", "false");
  }
  const generation = authGeneration;
  openID = id;
  button.textContent = "Loading…";
  button.disabled = true;
  try {
    const report = await requestJSON(`${endpoint}/${encodeURIComponent(id)}`);
    if (generation !== authGeneration || openID !== id) return;
    if (report?.id !== id) throw new Error("The report service returned a different ticket.");
    const detailRow = document.createElement("tr");
    detailRow.className = "diagnostic-row";
    detailRow.dataset.detailFor = id;
    const cell = document.createElement("td");
    cell.colSpan = 4;
    const log = document.createElement("pre");
    log.textContent = report.diagnostics || "No diagnostic events attached.";
    cell.append(log);
    detailRow.append(cell);
    row.after(detailRow);
    button.textContent = "Hide";
    button.setAttribute("aria-expanded", "true");
  } catch (error) {
    if (reportToken) notice.textContent = error.message;
    button.textContent = "View";
  } finally {
    button.disabled = false;
  }
}

function lock(message = "Enter your dashboard token to view reports.") {
  authGeneration += 1;
  reportToken = "";
  sessionStorage.removeItem(storageKey);
  tickets.replaceChildren();
  openID = null;
  workspace.hidden = true;
  toolbar.hidden = true;
  authForm.hidden = false;
  notice.textContent = message;
}

authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  reportToken = tokenInput.value.trim();
  tokenInput.value = "";
  if (!reportToken) return;
  sessionStorage.setItem(storageKey, reportToken);
  refresh();
});
document.querySelector("#signout").addEventListener("click", () => lock());
document.querySelector("#refresh").addEventListener("click", refresh);
status.addEventListener("change", refresh);
if (reportToken) refresh();

function displayID(report) {
  if (!Number.isSafeInteger(report.ticketNumber)
      || !Number.isSafeInteger(report.createdAtMilliseconds)) return "Unknown ticket";
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver", month: "short", day: "numeric", year: "numeric",
  }).format(new Date(report.createdAtMilliseconds));
  return `${date} - ${report.ticketNumber}`;
}

function statusIcon(value) {
  switch (value) {
    case "fixed": return "✓";
    case "needs_info": return "?";
    case "in_progress": return "…";
    default: return "•";
  }
}
