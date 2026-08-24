import assert from "node:assert/strict";
import test from "node:test";

const enabled = process.env.RUN_LIVE_ANALYTICS_TESTS === "1";
const endpoint = "https://icedmatchalabs.com/api/analytics/v1/events";

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

async function post(payload) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}
