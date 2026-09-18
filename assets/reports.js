const endpoint = "/api/dev-reports/v1";
const tickets = document.querySelector("#tickets");
const notice = document.querySelector("#notice");
const status = document.querySelector("#status");
const detail = document.querySelector("#detail");
const empty = document.querySelector("#detail-empty");
let selectedID = null;

async function requestJSON(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`The report service returned ${response.status}.`);
  return response.json();
}

async function refresh() {
  notice.textContent = "Loading reports…";
  tickets.replaceChildren();
  selectedID = null;
  detail.hidden = true;
  empty.hidden = false;
  try {
    const { reports } = await requestJSON(`${endpoint}?status=${encodeURIComponent(status.value)}`);
    if (!Array.isArray(reports)) throw new Error("The report service returned an invalid list.");
    notice.textContent = reports.length === 0 ? "No reports in this view." : `${reports.length} reports`;
    for (const report of reports) {
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
    notice.textContent = error.message;
  }
}

async function openReport(id, button) {
  selectedID = id;
  for (const item of tickets.querySelectorAll(".ticket")) item.setAttribute("aria-current", item === button ? "true" : "false");
  notice.textContent = "Loading report…";
  try {
    const report = await requestJSON(`${endpoint}/${encodeURIComponent(id)}`);
    if (report.id !== id) throw new Error("The report service returned a different ticket.");
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
    notice.textContent = "";
  } catch (error) {
    notice.textContent = error.message;
  }
}

document.querySelector("#refresh").addEventListener("click", refresh);
status.addEventListener("change", refresh);
refresh();
