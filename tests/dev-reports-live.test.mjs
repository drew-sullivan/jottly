import assert from "node:assert/strict";
import test from "node:test";

const enabled = process.env.RUN_LIVE_REPORT_TESTS === "1";
const token = process.env.ANALYTICS_REPORT_TOKEN;
const endpoint = "https://icedmatchalabs.com/api/dev-reports/v1";
const unknownID = "00000000-0000-4000-8000-000000000000";

test("production report data and status changes are private", { skip: !enabled }, async () => {
  for (const [url, method] of [
    [endpoint, "GET"],
    [`${endpoint}/${unknownID}`, "GET"],
    [`${endpoint}/${unknownID}`, "PATCH"],
  ]) {
    const response = await fetch(url, { method });
    assert.equal(response.status, 404, `${method} ${url} must be hidden without a token`);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
});

test("production dashboard token reads the private queue", { skip: !enabled || !token }, async () => {
  const response = await fetch(`${endpoint}?status=all`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  const body = await response.json();
  assert.equal(Array.isArray(body.reports), true);
  if (body.reports.length === 0) return;

  const detail = await fetch(`${endpoint}/${encodeURIComponent(body.reports[0].id)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).id, body.reports[0].id);
});
