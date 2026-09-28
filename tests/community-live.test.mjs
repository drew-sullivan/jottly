import assert from "node:assert/strict";
import test from "node:test";
import { validateCommunityCatalogSnapshot } from "../functions/api/community/v1/contract.js";

const endpointLive = process.env.RUN_LIVE_COMMUNITY_ENDPOINT_TESTS === "1";

test("live public catalog is valid and honors its ETag", { skip: !endpointLive }, async () => {
  const endpoint = process.env.COMMUNITY_CATALOG_URL
    ?? "https://icedmatchalabs.com/api/community/v1/games";
  const response = await fetch(endpoint, { headers: { accept: "application/json" } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /public/);
  const etag = response.headers.get("etag");
  assert.ok(etag);
  assert.ok(Number.isSafeInteger(Number(response.headers.get("x-jottly-catalog-generated-at"))));
  assert.equal(validateCommunityCatalogSnapshot(await response.json()).ok, true);

  const unchanged = await fetch(endpoint, { headers: { "if-none-match": etag } });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), "");
});

test("live catalog health meets the freshness SLO", { skip: !endpointLive }, async () => {
  const endpoint = process.env.COMMUNITY_HEALTH_URL
    ?? "https://icedmatchalabs.com/api/community/v1/health";
  const response = await fetch(endpoint, { headers: { accept: "application/json" } });
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.status, "healthy");
  assert.equal(health.entryCount, 5);
});
