const endpoint = "/api/dev-reports/v1";
const storageKey = "jottly.analytics.reportToken";
const tickets = document.querySelector("#tickets");
const notice = document.querySelector("#notice");
const status = document.querySelector("#status");
const detail = document.querySelector("#detail");
const empty = document.querySelector("#detail-empty");
const workspace = document.querySelector(".workspace");
const toolbar = document.querySelector(".toolbar");
const authForm = document.querySelector("#auth-form");
const tokenInput = document.querySelector("#token-input");
const sampleBanner = document.querySelector("#sample-banner");
const sampleIndicator = document.querySelector("#sample-indicator");
const exitSample = document.querySelector("#exit-sample");
const signout = document.querySelector("#signout");
const sampleReports = [
  {
    id: "00000006-0000-4000-8000-000000000006", kind: "bug",
    description: "A shared game link opened the wrong rule sheet",
    diagnostics: "[sample] 14:32:18 link.opened purpose=shareGame\n[sample] 14:32:19 route.selected package=example\n[sample] 14:32:20 rules.presented package=other-example",
    appVersion: "3.4.0", buildNumber: "500", createdAtMilliseconds: Date.UTC(2026, 8, 18, 14, 32),
    status: "new", resolution: "",
  },
  {
    id: "00000005-0000-4000-8000-000000000005", kind: "feature",
    description: "Add a quick way to replay a recently finished game",
    diagnostics: "[sample] No diagnostic events were needed for this feature request.",
    appVersion: "3.4.0", buildNumber: "500", createdAtMilliseconds: Date.UTC(2026, 8, 18, 11, 5),
    status: "new", resolution: "",
  },
  {
    id: "00000004-0000-4000-8000-000000000004", kind: "bug",
    description: "Changing excluded letters did not stick in Try It",
    diagnostics: "[sample] 09:11:02 builder.rule.changed excludedLetters=Z\n[sample] 09:11:05 playtest.started definition=previous-revision",
    appVersion: "3.4.0", buildNumber: "499", createdAtMilliseconds: Date.UTC(2026, 8, 17, 9, 11),
    status: "in_progress", resolution: "Reproduced; adding a draft-to-playtest regression test.",
  },
  {
    id: "00000003-0000-4000-8000-000000000003", kind: "bug",
    description: "A friend did not receive a remixed-game invitation",
    diagnostics: "[sample] 16:40:10 invitation.sent package=example\n[sample] 16:40:11 delivery.pending recipient=example-player",
    appVersion: "3.4.0", buildNumber: "498", createdAtMilliseconds: Date.UTC(2026, 8, 16, 16, 40),
    status: "needs_info", resolution: "Waiting for a recipient-side trace.",
  },
  {
    id: "00000002-0000-4000-8000-000000000002", kind: "bug",
    description: "The solo picker briefly showed two loading indicators",
    appVersion: "3.4.0", buildNumber: "497", createdAtMilliseconds: Date.UTC(2026, 8, 15, 10, 22),
    status: "fixed",
  },
  {
    id: "00000001-0000-4000-8000-000000000001", kind: "feature",
    description: "Show recently played games at the top of the picker",
    appVersion: "3.4.0", buildNumber: "496", createdAtMilliseconds: Date.UTC(2026, 8, 14, 8, 15),
    status: "fixed",
  },
];
let reportToken = sessionStorage.getItem(storageKey) ?? "";
let selectedID = null;
let authGeneration = 0;
let sampleMode = false;

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
  if (!reportToken && !sampleMode) return;
  const generation = authGeneration;
  authForm.hidden = true;
  toolbar.hidden = false;
  workspace.hidden = false;
  sampleBanner.hidden = !sampleMode;
  sampleIndicator.hidden = !sampleMode;
  exitSample.hidden = !sampleMode;
  signout.hidden = sampleMode;
  notice.textContent = sampleMode ? "Loading sample tickets…" : "Loading reports…";
  tickets.replaceChildren();
  selectedID = null;
  detail.hidden = true;
  empty.hidden = false;
  detail.parentElement.classList.remove("has-selection");
  workspace.classList.toggle("is-completed", status.value === "fixed");
  try {
    const reports = sampleMode
      ? sampleReports.filter((report) => status.value === "all" || report.status === status.value)
      : (await requestJSON(`${endpoint}?status=${encodeURIComponent(status.value)}`)).reports;
    if (generation !== authGeneration) return;
    if (!Array.isArray(reports)) throw new Error("The report service returned an invalid list.");
    notice.textContent = reports.length === 0 ? "No reports in this view."
      : `${reports.length} ${sampleMode ? "sample tickets" : "reports"}`;
    for (const report of reports) {
      if (report.status === "fixed") {
        const summary = document.createElement("div");
        summary.className = "ticket ticket-fixed";
        summary.textContent = `${report.id} · ${report.description} · Fixed`;
        tickets.append(summary);
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ticket";
      button.setAttribute("aria-current", report.id === selectedID ? "true" : "false");
      const top = document.createElement("span");
      top.className = "ticket-top";
      const identity = document.createElement("span");
      identity.textContent = `${report.kind === "bug" ? "Bug" : "Feature"} · ${report.id.slice(0, 8)}`;
      const state = document.createElement("span");
      state.textContent = report.status.replaceAll("_", " ");
      top.append(identity, state);
      const summary = document.createElement("span");
      summary.className = "ticket-description";
      summary.textContent = report.description;
      button.append(top, summary);
      button.addEventListener("click", () => openReport(report.id, button));
      tickets.append(button);
    }
  } catch (error) {
    if (reportToken || sampleMode) notice.textContent = error.message;
  }
}

async function openReport(id, button) {
  const generation = authGeneration;
  selectedID = id;
  for (const item of tickets.querySelectorAll(".ticket")) item.setAttribute("aria-current", item === button ? "true" : "false");
  notice.textContent = "Loading report…";
  try {
    const report = sampleMode ? sampleReports.find((item) => item.id === id)
      : await requestJSON(`${endpoint}/${encodeURIComponent(id)}`);
    if (generation !== authGeneration) return;
    if (report?.id !== id) throw new Error("The report service returned a different ticket.");
    document.querySelector("#detail-kind").textContent = report.kind === "bug" ? "Bug" : "Small feature";
    document.querySelector("#detail-title").textContent = report.description;
    document.querySelector("#detail-status").textContent = report.status.replaceAll("_", " ");
    document.querySelector("#detail-meta").textContent = `${report.id} · app ${report.appVersion} (${report.buildNumber}) · ${new Date(report.createdAtMilliseconds).toLocaleString()}`;
    const resolution = document.querySelector("#detail-resolution");
    resolution.textContent = report.resolution || "";
    resolution.hidden = !report.resolution;
    document.querySelector("#detail-log").textContent = report.diagnostics || "No diagnostic events attached.";
    empty.hidden = true;
    detail.hidden = false;
    detail.parentElement.classList.add("has-selection");
    notice.textContent = "";
    if (matchMedia("(max-width: 740px)").matches) detail.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    if (reportToken || sampleMode) notice.textContent = error.message;
  }
}

function lock(message = "Enter your dashboard token to view reports.") {
  authGeneration += 1;
  reportToken = "";
  sampleMode = false;
  sessionStorage.removeItem(storageKey);
  tickets.replaceChildren();
  detail.hidden = true;
  for (const id of ["detail-kind", "detail-title", "detail-status", "detail-meta", "detail-resolution", "detail-log"]) {
    document.querySelector(`#${id}`).textContent = "";
  }
  workspace.hidden = true;
  toolbar.hidden = true;
  sampleBanner.hidden = true;
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
function enterSample() {
  authGeneration += 1;
  sampleMode = true;
  status.value = "all";
  refresh();
}

document.querySelector("#sample").addEventListener("click", enterSample);
exitSample.addEventListener("click", () => lock());
document.querySelector("#refresh").addEventListener("click", refresh);
status.addEventListener("change", refresh);
if (new URLSearchParams(location.search).get("sample") === "1") enterSample();
else if (reportToken) refresh();
