import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../worker.js";
import { devReportSchemaSQL, clearFixedDiagnosticsSQL } from "../functions/api/dev-reports/v1/schema.js";

const path = "https://icedmatchalabs.com/api/dev-reports/v1";
const id = "a2f75428-f25c-4546-8b92-f40ad38a50bb";

test("a bug and its recent diagnostics become one durable ticket", async () => {
  const env = environment();
  const report = payload();
  const created = await worker.fetch(request(path, "POST", report), env);
  assert.equal(created.status, 201);
  const ticket = await created.json();
  assert.equal(ticket.id, id);
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
  assert.equal(Object.hasOwn(summary, "diagnostics"), false);
  const detail = await (await worker.fetch(request(`${path}/${id}`, "GET"), env)).json();
  assert.equal(detail.diagnostics, report.diagnostics);
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
  assert.deepEqual(fixed.reports[0], { id, description: payload().description, status: "fixed" });
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
  assert.deepEqual(detail, { id, description: payload().description, status: "fixed" });
  const row = sqlite.prepare("SELECT diagnostics, app_version, build_number FROM dev_reports WHERE id = ?").get(id);
  assert.equal(row.diagnostics, "");
  assert.equal(row.app_version, payload().appVersion);
  assert.equal(row.build_number, payload().buildNumber);
});

test("reports are bounded and invalid requests never enter the queue", async () => {
  const env = environment();
  for (const body of [
    { ...payload(), description: " " },
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
  assert.equal(list.reports[49].description, "Feature 2");
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
        expectedStatus, status, resolution: "",
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
  assert.equal((await worker.fetch(request(`${path}/${id}`, "DELETE"), {})).status, 405);
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
});

function payload() {
  return {
    schemaVersion: 1, id, kind: "bug", description: "The game did not open",
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
