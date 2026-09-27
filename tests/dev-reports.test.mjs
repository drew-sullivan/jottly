import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../worker.js";
import {
  addTitleSQL, addSubmissionFingerprintSQL, backfillTitleSQL, clearFixedDiagnosticsSQL, devReportSchemaSQL,
} from "../functions/api/dev-reports/v1/schema.js";

const path = "https://icedmatchalabs.com/api/dev-reports/v1";
const healthPath = `${path}/health`;
const id = "a2f75428-f25c-4546-8b92-f40ad38a50bb";

test("a bug and its recent diagnostics become one durable ticket", async () => {
  const env = environment();
  const report = payload();
  const created = await worker.fetch(request(path, "POST", report), env);
  assert.equal(created.status, 201);
  const ticket = await created.json();
  assert.equal(ticket.id, id);
  assert.equal(ticket.ticketNumber, 1);
  assert.equal(ticket.title, report.title);
  assert.equal(ticket.kind, "bug");
  assert.equal(ticket.description, report.description);
  assert.equal(Object.hasOwn(ticket, "diagnostics"), false);
  assert.equal(ticket.appVersion, "3.4.0");
  assert.equal(ticket.buildNumber, "500");
  assert.equal(ticket.status, "new");
  assert.equal(ticket.resolution, null);
  assert.ok(Number.isSafeInteger(ticket.createdAtMilliseconds));

  const listed = await worker.fetch(request(path, "GET"), env);
  assert.equal(listed.status, 200);
  const summary = (await listed.json()).reports[0];
  assert.equal(summary.description, report.description);
  assert.equal(summary.title, report.title);
  assert.equal(summary.resolution, null);
  assert.equal(Object.hasOwn(summary, "diagnostics"), false);
  const detail = await (await worker.fetch(request(`${path}/${id}`, "GET"), env)).json();
  assert.equal(detail.diagnostics, report.diagnostics);
});

test("public health proves the private queue storage is deployed without exposing tickets", async () => {
  const healthy = await worker.fetch(request(healthPath, "GET", undefined, false), environment());
  assert.equal(healthy.status, 200);
  assert.deepEqual(await healthy.json(), {
    status: "ok",
    schemaVersion: 2,
    queueAccess: "private",
    submissionIdentityVersion: 1,
    automaticReliabilityVersion: 1,
  });

  const unavailable = await worker.fetch(request(healthPath, "GET", undefined, false), {});
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "Report inbox unavailable" });
  assert.equal((await worker.fetch(request(healthPath, "POST", {}, false), environment())).status, 405);
});

test("retries keep the same ticket, while an ID collision cannot rewrite it", async () => {
  const env = environment();
  assert.equal((await worker.fetch(request(path, "POST", payload()), env)).status, 201);
  assert.equal((await worker.fetch(request(path, "POST", payload()), env)).status, 200);
  assert.equal((await worker.fetch(request(path, "POST", { ...payload(), description: "Different" }), env)).status, 409);
  const list = await (await worker.fetch(request(path, "GET"), env)).json();
  assert.equal(list.reports.length, 1);
  assert.equal(list.reports[0].description, payload().description);
});

test("legacy app submissions receive a bounded fallback title", async () => {
  const env = environment();
  const legacy = { ...payload(), description: "word ".repeat(40).trim() };
  delete legacy.title;

  const response = await worker.fetch(request(path, "POST", legacy), env);
  const created = await response.json();

  assert.equal(response.status, 201);
  assert.ok(created.title.endsWith("…"));
  assert.ok(created.title.length <= 120);
  assert.equal(created.description, legacy.description);
});

test("a ticket moves through a compare-and-swap work lifecycle", async () => {
  const env = environment();
  await worker.fetch(request(path, "POST", payload()), env);
  const update = (expectedStatus, status, resolution = "") => worker.fetch(
    request(`${path}/${id}`, "PATCH", { expectedStatus, status, resolution }), env,
  );
  assert.equal((await update("new", "in_progress")).status, 200);
  assert.equal((await update("new", "in_progress", "wrong worker")).status, 409);
  assert.equal((await update("in_progress", "needs_info", "Need a second device trace")).status, 200);
  const waiting = await (await worker.fetch(request(`${path}/${id}`, "GET"), env)).json();
  assert.equal(waiting.diagnostics, payload().diagnostics);
  assert.equal(waiting.resolution, "Need a second device trace");
  assert.equal((await update("needs_info", "in_progress")).status, 200);
  assert.equal((await update("in_progress", "fixed", "commit abc123;\n tests passed")).status, 200);
  assert.equal((await (await worker.fetch(request(path, "GET"), env)).json()).reports.length, 0);
  const fixed = await (await worker.fetch(request(`${path}?status=fixed`, "GET"), env)).json();
  assert.deepEqual(fixed.reports[0], {
    id,
    ticketNumber: 1,
    title: payload().title,
    description: payload().description,
    createdAtMilliseconds: waiting.createdAtMilliseconds,
    status: "fixed",
    resolution: "commit abc123;\n tests passed",
  });
  const detail = await (await worker.fetch(request(`${path}/${id}`, "GET"), env)).json();
  assert.deepEqual(detail, fixed.reports[0]);
  const stored = await env.COMMUNITY_DB.prepare(
    "SELECT diagnostics, app_version, build_number, description FROM dev_reports WHERE id = ?",
  ).bind(id).first();
  assert.equal(stored.diagnostics, "");
  assert.equal(stored.app_version, payload().appVersion);
  assert.equal(stored.build_number, payload().buildNumber);
  assert.equal(stored.description, payload().description);
  assert.equal((await update("fixed", "in_progress")).status, 400);
  assert.equal((await worker.fetch(request(path, "POST", payload()), env)).status, 200);
  assert.equal((await env.COMMUNITY_DB.prepare("SELECT diagnostics FROM dev_reports WHERE id = ?")
    .bind(id).first()).diagnostics, "");
});

test("already-fixed tickets lose legacy diagnostics on the next report request", async () => {
  const sqlite = new DatabaseSync(":memory:");
  await worker.fetch(request(path, "POST", payload()), environment(sqlite));
  sqlite.prepare("UPDATE dev_reports SET status = 'fixed', resolution = 'commit old' WHERE id = ?").run(id);
  const detail = await (await worker.fetch(request(`${path}/${id}`, "GET"), environment(sqlite))).json();
  assert.deepEqual(detail, {
    id,
    ticketNumber: 1,
    title: payload().title,
    description: payload().description,
    createdAtMilliseconds: detail.createdAtMilliseconds,
    status: "fixed",
    resolution: "commit old",
  });
  const row = sqlite.prepare("SELECT diagnostics, app_version, build_number FROM dev_reports WHERE id = ?").get(id);
  assert.equal(row.diagnostics, "");
  assert.equal(row.app_version, payload().appVersion);
  assert.equal(row.build_number, payload().buildNumber);
});

test("authorized cleanup deletes exactly one requested ticket", async () => {
  const env = environment();
  await worker.fetch(request(path, "POST", payload()), env);
  const deleted = await worker.fetch(request(`${path}/${id}`, "DELETE"), env);
  assert.equal(deleted.status, 204);
  assert.equal((await worker.fetch(request(`${path}/${id}`, "GET"), env)).status, 404);
  assert.equal((await worker.fetch(request(`${path}/${id}`, "DELETE"), env)).status, 404);
  assert.equal((await worker.fetch(request(`${path}/${id}`, "DELETE", undefined, false), env)).status, 404);
});

test("reports are bounded and invalid requests never enter the queue", async () => {
  const env = environment();
  for (const body of [
    { ...payload(), description: " " },
    { ...payload(), title: " " },
    { ...payload(), title: "x".repeat(121) },
    { ...payload(), kind: "admin" },
    { ...payload(), id: "not-an-id" },
    { ...payload(), diagnostics: "x".repeat(100_001) },
  ]) {
    assert.equal((await worker.fetch(request(path, "POST", body), env)).status, 400);
  }
  assert.equal((await worker.fetch(request(path, "POST", {
    ...payload(), diagnostics: "x".repeat(129 * 1024),
  }), env)).status, 413);
  assert.equal((await worker.fetch(request(path, "GET"), env)).status, 200);
  assert.equal((await worker.fetch(request(`${path}?status=unknown`, "GET"), env)).status, 400);
  assert.equal((await worker.fetch(request(`${path}/${id}`, "PATCH", {
    expectedStatus: "new", status: "in_progress", resolution: "",
  }), env)).status, 404);
});

test("every queue shows the newest reports first and remains bounded", async () => {
  const env = environment();
  for (let n = 0; n < 52; n += 1) {
    const next = `${n.toString(16).padStart(8, "0")}-f25c-4546-8b92-f40ad38a50bb`;
    assert.equal((await worker.fetch(request(path, "POST", {
      ...payload(), id: next, kind: "feature", description: `Feature ${n}`,
    }), env)).status, 201);
  }
  const list = await (await worker.fetch(request(path, "GET"), env)).json();
  assert.equal(list.reports.length, 50);
  assert.equal(list.reports[0].description, "Feature 51");
  assert.equal(list.reports[0].ticketNumber, 52);
  assert.equal(list.reports[49].description, "Feature 2");
  assert.equal(list.reports[49].ticketNumber, 3);
  const recent = await (await worker.fetch(request(`${path}?status=all`, "GET"), env)).json();
  assert.equal(recent.reports.length, 50);
  assert.equal(recent.reports[0].description, "Feature 51");

  const oldestID = "00000000-f25c-4546-8b92-f40ad38a50bb";
  const newestID = "00000033-f25c-4546-8b92-f40ad38a50bb";
  await env.COMMUNITY_DB.prepare("UPDATE dev_reports SET created_at_ms = ? WHERE id = ?")
    .bind(100, oldestID).run();
  await env.COMMUNITY_DB.prepare("UPDATE dev_reports SET created_at_ms = ? WHERE id = ?")
    .bind(200, newestID).run();
  for (const reportID of [oldestID, newestID]) {
    for (const [expectedStatus, status] of [["new", "in_progress"], ["in_progress", "fixed"]]) {
      assert.equal((await worker.fetch(request(`${path}/${reportID}`, "PATCH", {
        expectedStatus, status, resolution: status === "fixed" ? "Completed legacy queue item" : "",
      }), env)).status, 200);
    }
  }
  const fixed = await (await worker.fetch(request(`${path}?status=fixed`, "GET"), env)).json();
  assert.deepEqual(fixed.reports.map((report) => report.description), ["Feature 51", "Feature 0"]);
});

test("missing storage and unsupported methods fail explicitly", async () => {
  assert.equal((await worker.fetch(request(path, "POST", payload()), {})).status, 503);
  assert.equal((await worker.fetch(request(path, "GET"), { ANALYTICS_REPORT_TOKEN: "test-report-token" })).status, 503);
  assert.equal((await worker.fetch(request(path, "DELETE"), {})).status, 405);
  assert.equal((await worker.fetch(request(`${path}/${id}`, "GET"), { ANALYTICS_REPORT_TOKEN: "test-report-token" })).status, 503);
  assert.equal((await worker.fetch(request(`${path}/${id}`, "DELETE"), {})).status, 404);
});

test("report reads and status changes require the dashboard token, while app submissions remain public", async () => {
  const env = environment();
  assert.equal((await worker.fetch(request(path, "POST", payload(), false), env)).status, 201);
  for (const url of [path, `${path}/${id}`]) {
    for (const authorization of [undefined, "Bearer wrong-token"]) {
      const headers = authorization ? { authorization } : {};
      const response = await worker.fetch(new Request(url, { headers }), env);
      assert.equal(response.status, 404);
      assert.doesNotMatch(await response.text(), /diagnostics|description|Report inbox/);
    }
  }
  const unauthorizedUpdate = await worker.fetch(request(`${path}/${id}`, "PATCH", {
    expectedStatus: "new", status: "fixed", resolution: "not authorized",
  }, false), env);
  assert.equal(unauthorizedUpdate.status, 404);
  const row = await env.COMMUNITY_DB.prepare("SELECT status, diagnostics FROM dev_reports WHERE id = ?").bind(id).first();
  assert.equal(row.status, "new");
  assert.equal(row.diagnostics, payload().diagnostics);
  assert.equal((await worker.fetch(request(path, "GET"), env)).status, 200);
  assert.equal((await worker.fetch(request(`${path}/${id}`, "GET"), env)).status, 200);
  assert.equal((await worker.fetch(request(`${path}/${id}`, "PATCH", {
    expectedStatus: "new", status: "in_progress", resolution: "",
  }), env)).status, 200);
});

test("a missing dashboard secret fails closed", async () => {
  const env = environment();
  delete env.ANALYTICS_REPORT_TOKEN;
  assert.equal((await worker.fetch(request(path, "POST", payload()), env)).status, 201);
  assert.equal((await worker.fetch(request(path, "GET"), env)).status, 404);
  assert.equal((await worker.fetch(request(`${path}/${id}`, "GET"), env)).status, 404);
  assert.equal((await worker.fetch(request(`${path}/${id}`, "PATCH", {
    expectedStatus: "new", status: "in_progress", resolution: "",
  }), env)).status, 404);
});

test("runtime schema matches its deployable migration", async () => {
  const migration = await readFile(new URL("../migrations/0005_dev_reports.sql", import.meta.url), "utf8");
  assert.equal(migration.trim(), devReportSchemaSQL);
  const cleanup = await readFile(new URL("../migrations/0006_clear_fixed_diagnostics.sql", import.meta.url), "utf8");
  assert.equal(cleanup.trim(), clearFixedDiagnosticsSQL);
  const titles = await readFile(new URL("../migrations/0007_dev_report_titles.sql", import.meta.url), "utf8");
  assert.equal(titles.trim(), `${addTitleSQL}\n\n${backfillTitleSQL}`);
  const identity = await readFile(new URL("../migrations/0008_dev_report_submission_identity.sql", import.meta.url), "utf8");
  assert.equal(identity.trim(), addSubmissionFingerprintSQL);
});

function payload() {
  return {
    schemaVersion: 1, id, kind: "bug", title: "Game launch fails", description: "The game did not open",
    diagnostics: "last 200 events", appVersion: "3.4.0", buildNumber: "500",
  };
}

function request(url, method, body, authorized = true) {
  return new Request(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(authorized && method !== "POST" ? { authorization: "Bearer test-report-token" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function environment(sqlite = new DatabaseSync(":memory:")) {
  return {
    ANALYTICS_REPORT_TOKEN: "test-report-token",
    COMMUNITY_DB: {
      prepare(sql) {
        return new Prepared(sqlite.prepare(sql));
      },
    },
  };
}

class Prepared {
  constructor(statement, args = []) {
    this.statement = statement;
    this.args = args;
  }

  bind(...args) { return new Prepared(this.statement, args); }
  async run() { return { meta: { changes: Number(this.statement.run(...this.args).changes) } }; }
  first() { return this.statement.get(...this.args) ?? null; }
  all() { return { results: this.statement.all(...this.args) }; }
}

test("an immutable submission survives display-title edits and closure without restoring diagnostics", async () => {
  const env = environment();
  const original = payload();
  assert.equal((await worker.fetch(request(path, "POST", original), env)).status, 201);
  for (const [expectedStatus, status, title] of [
    ["new", "in_progress", "Investigating the launch issue"],
    ["in_progress", "needs_info", "Waiting for launch diagnostics"],
    ["needs_info", "in_progress", "Confirmed launch regression"],
    ["in_progress", "fixed", "Game launch now recovers"],
  ]) {
    assert.equal((await worker.fetch(request(`${path}/${id}`, "PATCH", {
      expectedStatus, status, title, resolution: status === "fixed" ? "Launch recovery is verified." : "",
    }), env)).status, 200);
    const retries = await Promise.all(Array.from({ length: 4 }, () => worker.fetch(request(path, "POST", original), env)));
    assert.deepEqual(retries.map((response) => response.status), [200, 200, 200, 200]);
    const current = await (await worker.fetch(request(`${path}/${id}`, "GET"), env)).json();
    assert.equal(current.title, title);
    assert.equal(current.status, status);
  }
  for (const change of [
    { title: "Different original title" }, { description: "Different original description" },
    { diagnostics: "Different original diagnostics" }, { appVersion: "4.0" },
    { buildNumber: "501" }, { kind: "feature" },
  ]) {
    assert.equal((await worker.fetch(request(path, "POST", { ...original, ...change }), env)).status, 409);
  }
  const row = await env.COMMUNITY_DB.prepare("SELECT *, (SELECT count(*) FROM dev_reports) AS total FROM dev_reports WHERE id = ?").bind(id).first();
  assert.equal(row.total, 1);
  assert.equal(row.diagnostics, "");
  assert.equal(row.title, "Game launch now recovers");
  assert.equal(row.resolution, "Launch recovery is verified.");
});

test("submission identity normalizes titles and descriptions but preserves diagnostic bytes", async () => {
  const env = environment();
  const original = { ...payload(), title: "  A report title  ", description: "  Some report text  " };
  assert.equal((await worker.fetch(request(path, "POST", original), env)).status, 201);
  assert.equal((await worker.fetch(request(path, "POST", {
    ...original, title: original.title.trim(), description: original.description.trim(),
  }), env)).status, 200);
  assert.equal((await worker.fetch(request(path, "POST", { ...original, diagnostics: original.diagnostics + " " }), env)).status, 409);
  const row = await env.COMMUNITY_DB.prepare("SELECT submission_fingerprint FROM dev_reports WHERE id = ?").bind(id).first();
  assert.match(row.submission_fingerprint, /^v1:[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(await (await worker.fetch(request(`${path}/${id}`, "GET"), env)).json(), "submission_fingerprint"), false);
});

test("legacy title fallback and its explicit equivalent have the same submission identity", async () => {
  const env = environment();
  const original = { ...payload() };
  delete original.title;
  assert.equal((await worker.fetch(request(path, "POST", original), env)).status, 201);
  assert.equal((await worker.fetch(request(path, "POST", { ...original, title: original.description }), env)).status, 200);
});

test("concurrent first submissions cannot bind the same ID to different original content", async () => {
  const env = environment();
  const reports = [payload(), { ...payload(), title: "Another original title" }];
  const responses = await Promise.all(reports.map((report) => worker.fetch(request(path, "POST", report), env)));
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  const winner = responses.findIndex((response) => response.status === 201);
  assert.equal((await worker.fetch(request(path, "POST", reports[winner]), env)).status, 200);
  assert.equal((await worker.fetch(request(path, "POST", reports[1 - winner]), env)).status, 409);
  assert.equal((await env.COMMUNITY_DB.prepare("SELECT count(*) AS total FROM dev_reports").first()).total, 1);
});

test("pre-fingerprint reports retain known immutable identity after historical title edits", async () => {
  for (const status of ["new", "in_progress", "fixed"]) {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(devReportSchemaSQL);
    sqlite.exec(addTitleSQL);
    const original = payload();
    sqlite.prepare(`INSERT INTO dev_reports
      (id, kind, title, description, diagnostics, app_version, build_number, created_at_ms, updated_at_ms, status, resolution)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 2, ?, ?)`)
      .run(id, original.kind, "Historically edited title", original.description,
        status === "fixed" ? "" : original.diagnostics, original.appVersion, original.buildNumber, status, "Keep this resolution");
    const env = environment(sqlite);
    assert.equal((await worker.fetch(request(path, "POST", original), env)).status, 200);
    for (const change of [{ kind: "feature" }, { description: "Different text" }, { appVersion: "other" }, { buildNumber: "other" }]) {
      assert.equal((await worker.fetch(request(path, "POST", { ...original, ...change }), env)).status, 409);
    }
    if (status !== "fixed") {
      assert.equal((await worker.fetch(request(path, "POST", { ...original, diagnostics: "different" }), env)).status, 409);
    }
    const retained = sqlite.prepare("SELECT * FROM dev_reports WHERE id = ?").get(id);
    assert.equal(retained.title, "Historically edited title");
    assert.equal(retained.resolution, "Keep this resolution");
    assert.equal(retained.submission_fingerprint, null, "Unknown original title/erased logs must not be invented or rebound");
    assert.equal(retained.diagnostics, status === "fixed" ? "" : original.diagnostics);
    sqlite.close();
  }
});

test("fingerprint migration retries a real failure and tolerates concurrent workers", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const env = environment(sqlite);
  const prepare = env.COMMUNITY_DB.prepare;
  let failOnce = true;
  env.COMMUNITY_DB.prepare = (sql) => {
    if (sql === addSubmissionFingerprintSQL && failOnce) {
      failOnce = false;
      throw new Error("injected unavailable database");
    }
    return prepare(sql);
  };
  assert.equal((await worker.fetch(request(healthPath, "GET", undefined, false), env)).status, 503);
  assert.equal((await worker.fetch(request(path, "POST", payload()), env)).status, 201);
  sqlite.close();

  const shared = new DatabaseSync(":memory:");
  const results = await Promise.all([environment(shared), environment(shared)].map((binding) =>
    worker.fetch(request(path, "POST", payload()), binding)));
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 201]);
  assert.equal(shared.prepare("SELECT count(*) AS total FROM dev_reports").get().total, 1);
  shared.close();
});
