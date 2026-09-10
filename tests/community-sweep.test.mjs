import assert from "node:assert/strict";
import test from "node:test";
import { projectCommunityObservations, runCommunitySweep } from "../functions/api/community/v1/sweep.js";
import {
  CommunityPublicationPolicy,
  CommunityPublicationRejection,
} from "../functions/api/community/v1/publication-policy.js";
import { allowlistFor, communityPackage, completionRecord, featuredPool } from "./community-fixtures.mjs";

const day = 86_400_000;
const asOf = Date.parse("2026-09-08T12:00:00Z");

test("only complete, non-forfeit, human, approved PvP records qualify", () => {
  const sourcePackage = communityPackage(1);
  const allowlist = new Map(allowlistFor([sourcePackage]).map((entry) => [entry.packageID, entry.canonicalDefinitionDigest]));
  const records = [
    completionRecord(sourcePackage, { timestamp: asOf - day }),
    completionRecord(sourcePackage, { timestamp: asOf - day, outcome: { tie: {} } }),
    completionRecord(sourcePackage, { timestamp: asOf - day, outcome: { forfeit: { winnerID: "player-a" } } }),
    completionRecord(sourcePackage, { timestamp: asOf - day, phase: "definitionFinalTurn" }),
    completionRecord(sourcePackage, { timestamp: asOf - day, inviteeID: "computer-opponent" }),
  ];
  const result = projectCommunityObservations({ records, allowlist, fallbackStartMilliseconds: asOf - 28 * day, asOfMilliseconds: asOf });
  assert.equal(result.observations.length, 2);
  assert.equal(result.metrics.malformedRecordCount, 0);
  assert.deepEqual(result.metrics.rejectionCounts, {
    forfeit: 1,
    incomplete: 1,
    nonHuman: 1,
  });
});

test("publication policy rules compose without changing the sweep projector", () => {
  const policy = new CommunityPublicationPolicy([
    { id: "alwaysReject", evaluate: () => CommunityPublicationRejection.incomplete },
  ]);
  assert.deepEqual(policy.evaluate({}), { allowed: false, reason: "incomplete" });
  assert.deepEqual(new CommunityPublicationPolicy([]).evaluate({}), { allowed: true });
});

test("malformed Base64, oversized state, bad JSON, and missing timestamps are skipped", () => {
  const sourcePackage = communityPackage(1);
  const allowlist = new Map(allowlistFor([sourcePackage]).map((entry) => [entry.packageID, entry.canonicalDefinitionDigest]));
  const records = [
    { modified: { timestamp: asOf - day }, fields: { stateData: { value: "***=" } } },
    { modified: { timestamp: asOf - day }, fields: { stateData: { value: "e25vdCBqc29ufQ==" } } },
    { modified: { timestamp: asOf - day }, fields: { stateData: { value: "A".repeat(2_800_000) } } },
    { fields: completionRecord(sourcePackage, { timestamp: asOf - day }).fields },
  ];
  const result = projectCommunityObservations({ records, allowlist, fallbackStartMilliseconds: asOf - 28 * day, asOfMilliseconds: asOf });
  assert.equal(result.observations.length, 0);
  assert.equal(result.metrics.malformedRecordCount, 4);
});

test("built-in, Solo-carried, unapproved, and digest-mismatched packages do not contribute", () => {
  const authored = communityPackage(1);
  const solo = communityPackage(2, { topology: "solo" });
  const builtIn = structuredClone(authored);
  builtIn.id = "catalog.lightning";
  const wrongDigestAllowlist = new Map([[authored.id, "f".repeat(64)]]);
  const result = projectCommunityObservations({
    records: [
      completionRecord(authored, { timestamp: asOf - day }),
      completionRecord(solo, { timestamp: asOf - day }),
      completionRecord(builtIn, { timestamp: asOf - day }),
    ],
    allowlist: wrongDigestAllowlist,
    fallbackStartMilliseconds: asOf - 28 * day,
    asOfMilliseconds: asOf,
  });
  assert.equal(result.observations.length, 0);
  assert.equal(result.metrics.unallowlistedRecordCount, 1);
});

test("unordered pair keys are stable across participant order and collision-safe", () => {
  const sourcePackage = communityPackage(1);
  const allowlist = new Map(allowlistFor([sourcePackage]).map((entry) => [entry.packageID, entry.canonicalDefinitionDigest]));
  const result = projectCommunityObservations({
    records: [
      completionRecord(sourcePackage, { timestamp: asOf - day, inviterID: "alpha", inviteeID: "beta" }),
      completionRecord(sourcePackage, { timestamp: asOf - day, inviterID: "beta", inviteeID: "alpha" }),
      completionRecord(sourcePackage, { timestamp: asOf - day, inviterID: "alpha\u0000beta", inviteeID: "gamma" }),
      completionRecord(sourcePackage, { timestamp: asOf - day, inviterID: "alpha", inviteeID: "beta\u0000gamma" }),
    ],
    allowlist,
    fallbackStartMilliseconds: asOf - 28 * day,
    asOfMilliseconds: asOf,
  });

  assert.equal(result.observations[0].unorderedPairKey, result.observations[1].unorderedPairKey);
  assert.notEqual(result.observations[2].unorderedPairKey, result.observations[3].unorderedPairKey);
});

test("scheduled sweep queries once, ranks, and publishes only the public snapshot", async () => {
  const organic = communityPackage(1);
  const featured = featuredPool();
  const allowlistEntries = allowlistFor([organic, ...featured]);
  const client = {
    async queryGameStates(window) {
      assert.equal(window.asOfMilliseconds, asOf);
      return { records: [completionRecord(organic, { timestamp: asOf - day })], pageCount: 3 };
    },
  };
  let published;
  const summary = await runCommunitySweep({
    env: environment(), asOfMilliseconds: asOf, client, allowlistEntries, featuredPackages: featured,
    publish: async (_db, snapshot) => { published = snapshot; return { published: true }; },
  });
  assert.equal(published.games.length, 5);
  assert.equal(published.games[0].selectionSource, "weeklyPopular");
  assert.equal(JSON.stringify(published).includes("player-a"), false);
  assert.equal(JSON.stringify(published).includes("never-published"), false);
  assert.deepEqual({
    pages: summary.cloudKitPageCount,
    inspected: summary.recordsInspected,
    qualifying: summary.qualifyingCompletions,
    published: summary.publishedEntryCount,
    organicSource: summary.organicSourceStatus,
  }, { pages: 3, inspected: 1, qualifying: 1, published: 5, organicSource: "available" });
});

test("invalid featured configuration never calls publication", async () => {
  let publicationCalls = 0;
  const publish = async () => { publicationCalls += 1; };
  await assert.rejects(runCommunitySweep({
    env: environment(), asOfMilliseconds: asOf,
    client: { queryGameStates: async () => ({ records: [], pageCount: 1 }) },
    allowlistEntries: [], featuredPackages: [], publish,
  }), /featured/);
  assert.equal(publicationCalls, 0);
});

test("reviewed featured games publish when CloudKit is unconfigured or unavailable", async () => {
  const featured = featuredPool();
  const snapshots = [];
  const publish = async (_db, snapshot) => {
    snapshots.push(snapshot);
    return { published: true };
  };
  const withoutCredentials = environment();
  delete withoutCredentials.CLOUDKIT_KEY_ID;
  delete withoutCredentials.CLOUDKIT_PRIVATE_KEY_PKCS8_BASE64;

  const unconfigured = await runCommunitySweep({
    env: withoutCredentials,
    asOfMilliseconds: asOf,
    allowlistEntries: allowlistFor(featured),
    featuredPackages: featured,
    publish,
  });
  const unavailable = await runCommunitySweep({
    env: environment(),
    asOfMilliseconds: asOf + 1,
    client: { queryGameStates: async () => { throw new Error("query failed"); } },
    allowlistEntries: allowlistFor(featured),
    featuredPackages: featured,
    publish,
  });

  assert.equal(unconfigured.organicSourceStatus, "unconfigured");
  assert.equal(unavailable.organicSourceStatus, "unavailable");
  assert.deepEqual(snapshots.map((snapshot) => snapshot.games.length), [5, 5]);
  assert.ok(snapshots.every((snapshot) => (
    snapshot.games.every((game) => game.selectionSource === "featured")
  )));
});

test("a partially installed CloudKit credential fails before publication", async () => {
  const featured = featuredPool();
  let publicationCalls = 0;
  const env = environment();
  delete env.CLOUDKIT_PRIVATE_KEY_PKCS8_BASE64;

  await assert.rejects(runCommunitySweep({
    env,
    asOfMilliseconds: asOf,
    allowlistEntries: allowlistFor(featured),
    featuredPackages: featured,
    publish: async () => { publicationCalls += 1; },
  }), /configuration/);
  assert.equal(publicationCalls, 0);
});

test("invalid production configuration fails before CloudKit or D1 work begins", async () => {
  let queryCalls = 0;
  let publicationCalls = 0;
  const featured = featuredPool();
  const client = {
    async queryGameStates() {
      queryCalls += 1;
      return { records: [], pageCount: 1 };
    },
  };
  const invalidEnvironments = [
    { ...environment(), CLOUDKIT_ENVIRONMENT: "development" },
    { ...environment(), COMMUNITY_CATALOG_SIZE: "7" },
    {
      ...environment(),
      COMMUNITY_WEEKLY_WINDOW_DAYS: "28",
      COMMUNITY_FALLBACK_WINDOW_DAYS: "28",
    },
  ];

  for (const env of invalidEnvironments) {
    await assert.rejects(runCommunitySweep({
      env,
      asOfMilliseconds: asOf,
      client,
      allowlistEntries: allowlistFor(featured),
      featuredPackages: featured,
      publish: async () => { publicationCalls += 1; },
    }), /configuration/);
  }

  assert.equal(queryCalls, 0);
  assert.equal(publicationCalls, 0);
});

test("development CloudKit is accepted only through the explicit test seam", async () => {
  const featured = featuredPool();
  const env = { ...environment(), CLOUDKIT_ENVIRONMENT: "development" };
  const client = { queryGameStates: async () => ({ records: [], pageCount: 1 }) };
  await assert.rejects(runCommunitySweep({
    env, asOfMilliseconds: asOf, client,
    allowlistEntries: allowlistFor(featured), featuredPackages: featured,
    publish: async () => ({ published: true }),
  }), /configuration/);
  const result = await runCommunitySweep({
    env, asOfMilliseconds: asOf, client,
    allowlistEntries: allowlistFor(featured), featuredPackages: featured,
    publish: async () => ({ published: true }),
    allowDevelopmentSource: true,
  });
  assert.equal(result.status, "published");
});

function environment() {
  return {
    COMMUNITY_DB: {}, CLOUDKIT_CONTAINER: "iCloud.com.dsull.Jotto", CLOUDKIT_ENVIRONMENT: "production",
    CLOUDKIT_KEY_ID: "test", CLOUDKIT_PRIVATE_KEY_PKCS8_BASE64: "test",
  };
}
