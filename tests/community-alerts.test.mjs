import assert from "node:assert/strict";
import test from "node:test";
import { notifyCommunityCatalogFailure } from "../functions/api/community/v1/alerts.js";

const failure = {
  operationID: "scheduled:1789000000000",
  source: "scheduled",
  errorCode: "CloudKitUnavailable",
  occurredAtUnixMilliseconds: 1789000000123,
};

test("catalog alerts emit the bounded operations payload to the configured webhook", async () => {
  const requests = [];
  const result = await withMutedConsoleError(() => notifyCommunityCatalogFailure(
    { COMMUNITY_ALERT_WEBHOOK_URL: "https://alerts.example.test/community" },
    failure,
    async (url, options) => {
      requests.push({ url, options });
      return new Response(null, { status: 204 });
    }
  ));

  assert.deepEqual(result, { delivered: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://alerts.example.test/community");
  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    event: "community_catalog_alert",
    status: "failed",
    ...failure,
  });
});

test("catalog alert delivery is optional and can never hide the original sweep failure", async () => {
  const unconfigured = await withMutedConsoleError(() => notifyCommunityCatalogFailure(
    {},
    failure,
    async () => assert.fail("An unconfigured alert must not make a network request")
  ));
  const unavailable = await withMutedConsoleError(() => notifyCommunityCatalogFailure(
    { COMMUNITY_ALERT_WEBHOOK_URL: "https://alerts.example.test/community" },
    failure,
    async () => { throw new Error("network down"); }
  ));
  const rejected = await withMutedConsoleError(() => notifyCommunityCatalogFailure(
    { COMMUNITY_ALERT_WEBHOOK_URL: "https://alerts.example.test/community" },
    failure,
    async () => new Response(null, { status: 503 })
  ));

  assert.deepEqual(unconfigured, { delivered: false });
  assert.deepEqual(unavailable, { delivered: false });
  assert.deepEqual(rejected, { delivered: false });
});

async function withMutedConsoleError(operation) {
  const original = console.error;
  console.error = () => {};
  try {
    return await operation();
  } finally {
    console.error = original;
  }
}
