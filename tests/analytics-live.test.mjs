import assert from "node:assert/strict";
import test from "node:test";

const enabled = process.env.RUN_LIVE_ANALYTICS_TESTS === "1";
const endpoint = "https://icedmatchalabs.com/api/analytics/v1/events";
const reportEndpoint = "https://icedmatchalabs.com/api/analytics/v1/report";
const reportToken = process.env.ANALYTICS_REPORT_TOKEN;

test("production analytics persists, deduplicates, and rejects identity", { skip: !enabled }, async () => {
  const entryID = crypto.randomUUID();
  const entry = {
    entry_id: entryID,
    day: new Date().toISOString().slice(0, 10),
    category: "reliability",
    event: "home_cache_painted",
    app_version: "2.9.1",
    release_channel: "debug",
    performance_bucket: "under_100ms",
    count: 1,
  };

  const first = await post({ schemaVersion: 1, entries: [entry] });
  assert.equal(first.response.status, 200);
  assert.deepEqual(first.body, { accepted: 1, inserted: 1 });

  const replay = await post({ schemaVersion: 1, entries: [entry] });
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.body, { accepted: 1, inserted: 0 });

  const identifying = await post({
    schemaVersion: 1,
    entries: [{ ...entry, entry_id: crypto.randomUUID(), device_id: "must-be-rejected" }],
  });
  assert.equal(identifying.response.status, 400);

  const hiddenReport = await fetch("https://icedmatchalabs.com/api/analytics/v1/report");
  assert.equal(hiddenReport.status, 404);
});

test("production dashboard is private, uncached, and deploys its first-party assets", { skip: !enabled }, async () => {
  const response = await fetch("https://icedmatchalabs.com/analytics");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/);
  const html = await response.text();
  assert.match(html, /<title>Jottly Product Dashboard<\/title>/);
  assert.match(html, /src="\/assets\/analytics-dashboard\.js"/);
});

test("production report token returns only approved anonymous dimensions", {
  skip: !enabled || !reportToken,
}, async () => {
  const response = await fetch(`${reportEndpoint}?days=7`, {
    headers: { authorization: `Bearer ${reportToken}` },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  const report = await response.json();
  assert.equal(report.days, 7);
  assert.equal(Array.isArray(report.rows), true);
  const forbidden = /player|device|game_id|opponent|word|name|timestamp/i;
  for (const row of report.rows) {
    for (const key of Object.keys(row)) assert.doesNotMatch(key, forbidden);
  }
});

async function post(payload) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}
