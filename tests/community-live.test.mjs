import assert from "node:assert/strict";
import test from "node:test";
import { CloudKitCommunityClient } from "../functions/api/community/v1/cloudkit-client.js";
import { validateCommunityCatalogSnapshot } from "../functions/api/community/v1/contract.js";
import { runCommunitySweep } from "../functions/api/community/v1/sweep.js";
import { allowlistFor, featuredPool } from "./community-fixtures.mjs";

const endpointLive = process.env.RUN_LIVE_COMMUNITY_ENDPOINT_TESTS === "1";
const cloudKitLive = process.env.RUN_LIVE_COMMUNITY_CLOUDKIT_TESTS === "1";
const sweepLive = process.env.RUN_LIVE_COMMUNITY_E2E_TESTS === "1";

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
  assert.equal(health.entryCount, 6);
});

test("development CloudKit accepts the production signer and bounded query", { skip: !cloudKitLive }, async () => {
  assert.equal(
    process.env.COMMUNITY_DEV_CLOUDKIT_ENVIRONMENT,
    "development",
    "The opt-in live test is intentionally forbidden from querying production.",
  );
  const asOfMilliseconds = Date.now();
  const client = new CloudKitCommunityClient({
    containerIdentifier: process.env.COMMUNITY_DEV_CLOUDKIT_CONTAINER ?? "iCloud.com.dsull.Jotto",
    environment: "development",
    keyID: process.env.COMMUNITY_DEV_CLOUDKIT_KEY_ID,
    privateKeyPKCS8Base64: process.env.COMMUNITY_DEV_CLOUDKIT_PRIVATE_KEY_PKCS8_BASE64,
  });

  const result = await client.queryGameStates({
    fallbackStartMilliseconds: asOfMilliseconds - 60_000,
    asOfMilliseconds,
  });

  assert.ok(Array.isArray(result.records));
  assert.ok(result.pageCount >= 1);
});

test("development completion crosses CloudKit, sweep, publication, and DTO validation", { skip: !sweepLive }, async () => {
  assert.equal(process.env.COMMUNITY_DEV_CLOUDKIT_ENVIRONMENT, "development");
  const sourcePackage = JSON.parse(Buffer.from(
    process.env.COMMUNITY_DEV_E2E_PACKAGE_BASE64 ?? "",
    "base64",
  ).toString("utf8"));
  const featured = featuredPool();
  const asOfMilliseconds = Date.now();
  const client = new CloudKitCommunityClient({
    containerIdentifier: process.env.COMMUNITY_DEV_CLOUDKIT_CONTAINER ?? "iCloud.com.dsull.Jotto",
    environment: "development",
    keyID: process.env.COMMUNITY_DEV_CLOUDKIT_KEY_ID,
    privateKeyPKCS8Base64: process.env.COMMUNITY_DEV_CLOUDKIT_PRIVATE_KEY_PKCS8_BASE64,
  });
  let published;
  const summary = await runCommunitySweep({
    env: {
      COMMUNITY_DB: {},
      CLOUDKIT_CONTAINER: process.env.COMMUNITY_DEV_CLOUDKIT_CONTAINER ?? "iCloud.com.dsull.Jotto",
      CLOUDKIT_ENVIRONMENT: "development",
      CLOUDKIT_KEY_ID: process.env.COMMUNITY_DEV_CLOUDKIT_KEY_ID,
      CLOUDKIT_PRIVATE_KEY_PKCS8_BASE64: process.env.COMMUNITY_DEV_CLOUDKIT_PRIVATE_KEY_PKCS8_BASE64,
    },
    asOfMilliseconds,
    client,
    allowlistEntries: allowlistFor([sourcePackage, ...featured]),
    featuredPackages: featured,
    publish: async (_db, snapshot) => {
      published = snapshot;
      return { published: true };
    },
    allowDevelopmentSource: true,
  });
  assert.ok(summary.qualifyingCompletions >= 1);
  assert.equal(validateCommunityCatalogSnapshot(published).ok, true);
  assert.equal(published.games.some((game) => game.sourcePackage.id === sourcePackage.id), true);
});
