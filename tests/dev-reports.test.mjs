import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../worker.js";
import { devReportSchemaSQL } from "../functions/api/dev-reports/v1/schema.js";

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
  assert.equal(ticket.diagnostics, report.diagnostics);
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
  assert.equal((await update("new", "fixed", "wrong worker")).status, 409);
  assert.equal((await update("in_progress", "fixed", "commit abc123; tests passed")).status, 200);
  assert.equal((await (await worker.fetch(request(path, "GET"), env)).json()).reports.length, 0);
  const fixed = await (await worker.fetch(request(`${path}?status=fixed`, "GET"), env)).json();
  assert.equal(fixed.reports[0].resolution, "commit abc123; tests passed");
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
    expectedStatus: "new", status: "fixed", resolution: "",
  }), env)).status, 404);
});

test("the queue is ordered, capped to one day's practical batch, and supports features", async () => {
  const env = environment();
  for (let n = 0; n < 52; n += 1) {
    const next = `${n.toString(16).padStart(8, "0")}-f25c-4546-8b92-f40ad38a50bb`;
    assert.equal((await worker.fetch(request(path, "POST", {
      ...payload(), id: next, kind: "feature", description: `Feature ${n}`,
    }), env)).status, 201);
  }
  const list = await (await worker.fetch(request(path, "GET"), env)).json();
  assert.equal(list.reports.length, 50);
  assert.equal(list.reports[0].description, "Feature 0");
  assert.equal(list.reports[49].description, "Feature 49");
  const recent = await (await worker.fetch(request(`${path}?status=all`, "GET"), env)).json();
  assert.equal(recent.reports.length, 50);
  assert.equal(recent.reports[0].description, "Feature 51");
});

test("missing storage and unsupported methods fail explicitly", async () => {
  assert.equal((await worker.fetch(request(path, "POST", payload()), {})).status, 503);
  assert.equal((await worker.fetch(request(path, "GET"), {})).status, 503);
  assert.equal((await worker.fetch(request(path, "DELETE"), {})).status, 405);
  assert.equal((await worker.fetch(request(`${path}/${id}`, "GET"), {})).status, 503);
  assert.equal((await worker.fetch(request(`${path}/${id}`, "DELETE"), {})).status, 405);
});

test("runtime schema matches its deployable migration", async () => {
  const migration = await readFile(new URL("../migrations/0005_dev_reports.sql", import.meta.url), "utf8");
  assert.equal(migration.trim(), devReportSchemaSQL);
});

function payload() {
  return {
    schemaVersion: 1, id, kind: "bug", description: "The game did not open",
    diagnostics: "last 200 events", appVersion: "3.4.0", buildNumber: "500",
  };
}

function request(url, method, body) {
  return new Request(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function environment() {
  const sqlite = new DatabaseSync(":memory:");
  return {
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
