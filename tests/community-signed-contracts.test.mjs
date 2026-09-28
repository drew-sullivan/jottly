import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import { CloudKitCommunityClient } from "../functions/api/community/v1/cloudkit-client.js";
import { validateCommunityCatalogSnapshot } from "../functions/api/community/v1/contract.js";
import { onRequestGet } from "../functions/api/community/v1/catalog.js";
import { runCommunitySweep } from "../functions/api/community/v1/sweep.js";
import { allowlistFor, communityPackage, completionRecord, featuredPool } from "./community-fixtures.mjs";
import { SQLiteD1 } from "./support/sqlite-d1.mjs";

const asOf = Date.parse("2026-09-08T12:00:00Z");
const query = { fallbackStartMilliseconds: asOf - 28 * 86_400_000, asOfMilliseconds: asOf };

// Apple is the only fake seam. Signatures, query construction, retries, projection,
// publication SQL and the DTO returned to app clients all execute production code.
function authority(reply) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privateKeyPKCS8Base64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const requests = [], sleeps = [];
  const client = new CloudKitCommunityClient({
    containerIdentifier: "iCloud.test", environment: "production", keyID: "test-key", privateKeyPKCS8Base64,
    now: () => new Date(asOf), sleep: async milliseconds => { sleeps.push(milliseconds); },
    fetchImplementation: async (url, options) => {
      assert.equal(url, "https://api.apple-cloudkit.com/database/1/iCloud.test/production/public/records/query");
      assert.equal(options.method, "POST");
      assert.equal(options.headers["X-Apple-CloudKit-Request-KeyID"], "test-key");
      const date = options.headers["X-Apple-CloudKit-Request-ISO8601Date"];
      assert.equal(date, "2026-09-08T12:00:00Z");
      const digest = createHash("sha256").update(options.body).digest("base64");
      const message = Buffer.from(`${date}:${digest}:${new URL(url).pathname}`);
      const signature = Buffer.from(options.headers["X-Apple-CloudKit-Request-SignatureV1"], "base64");
      // Independent OpenSSL verifier accepts DER, unlike WebCrypto's raw signature API.
      assert.equal(verify("sha256", message, publicKey, signature), true);
      assert.equal(verify("sha256", Buffer.concat([message, Buffer.from("changed")]), publicKey, signature), false);
      const body = JSON.parse(new TextDecoder().decode(options.body));
      assert.deepEqual(body.desiredKeys, ["stateData"]);
      assert.equal(body.resultsLimit, 200);
      assert.equal(body.query.recordType, "JottoGameState");
      assert.deepEqual(body.query.filterBy.map(x => [x.systemFieldName, x.comparator, x.fieldValue.value]), [
        ["modifiedTimestamp", "GREATER_THAN_OR_EQUALS", query.fallbackStartMilliseconds],
        ["modifiedTimestamp", "LESS_THAN", query.asOfMilliseconds],
      ]);
      assert.deepEqual(body.query.sortBy, [{ systemFieldName: "modifiedTimestamp", ascending: true }]);
      requests.push(body);
      return reply(body, requests.length);
    },
  });
  return { client, requests, sleeps, privateKeyPKCS8Base64 };
}

test("signed CloudKit query retries and paginates through an independently verified authority", async () => {
  const boundary = authority((_body, call) => call === 1
    ? new Response(null, { status: 503, headers: { "retry-after": "99" } })
    : Response.json(call === 2 ? { records: [{ recordName: "one" }], continuationMarker: "next" } : { records: [{ recordName: "two" }] }));
  const result = await boundary.client.queryGameStates(query);
  assert.deepEqual(result, { records: [{ recordName: "one" }, { recordName: "two" }], pageCount: 2 });
  assert.deepEqual(boundary.requests.map(x => x.continuationMarker), [undefined, undefined, "next"]);
  assert.deepEqual(boundary.sleeps, [5000]);
});

test("CloudKit rejects unexpected success statuses, malformed pages, repeated markers and exhausted retries", async () => {
  for (const status of [201, 202, 204, 206, 301, 400, 401, 403, 404]) {
    const boundary = authority(() => new Response(null, { status }));
    await assert.rejects(boundary.client.queryGameStates(query), error => error.kind === "request failed" && error.status === status);
    assert.equal(boundary.requests.length, 1);
    assert.deepEqual(boundary.sleeps, []);
  }
  for (const status of [429, 500, 502, 503, 504]) {
    const boundary = authority(() => new Response("private body must not escape", { status }));
    await assert.rejects(boundary.client.queryGameStates(query), error => error.status === status && !error.message.includes("private"));
    assert.equal(boundary.requests.length, 3);
    assert.deepEqual(boundary.sleeps, [250, 500]);
  }
  for (const [body, kind] of [[{}, "malformed response"], [{ records: [], continuationMarker: 3 }, "malformed continuation marker"], [{ records: [], continuationMarker: "again" }, "repeated continuation marker"], [{ records: [{ serverErrorCode: "UNKNOWN_ITEM" }] }, "record error"]]) {
    const boundary = authority(() => Response.json(body));
    await assert.rejects(boundary.client.queryGameStates(query), error => error.kind === kind);
  }
  const network = authority(() => { throw new Error("private network detail"); });
  await assert.rejects(network.client.queryGameStates(query), error => error.kind === "network" && !error.message.includes("private"));
  assert.equal(network.requests.length, 3);
});

test("signed completion reaches durable publication, private-data exclusion, cache validation and recovery", async (t) => {
  const db = new SQLiteD1(); t.after(() => db.close());
  const sourcePackage = communityPackage(1), featured = featuredPool();
  const good = completionRecord(sourcePackage, { timestamp: asOf - 1000 });
  let outage = false;
  const boundary = authority(body => {
    if (outage) return new Response(null, { status: 503 });
    return Response.json(body.continuationMarker === undefined
      ? { records: [good], continuationMarker: "final" }
      : { records: [good, completionRecord(sourcePackage, { timestamp: asOf - 1000, outcome: { forfeit: { winnerID: "player-a" } } })] });
  });
  const env = { COMMUNITY_DB: db, CLOUDKIT_CONTAINER: "iCloud.test", CLOUDKIT_ENVIRONMENT: "production", CLOUDKIT_KEY_ID: "test-key", CLOUDKIT_PRIVATE_KEY_PKCS8_BASE64: boundary.privateKeyPKCS8Base64 };
  const sweep = () => runCommunitySweep({ env, asOfMilliseconds: asOf, client: boundary.client, allowlistEntries: allowlistFor([sourcePackage, ...featured]), featuredPackages: featured });
  const summary = await sweep();
  assert.equal(summary.status, "published");
  assert.equal(summary.cloudKitPageCount, 2);
  assert.equal(summary.organicSourceStatus, "available");
  assert.equal(summary.qualifyingCompletions, 2);
  assert.equal(summary.rejectionCounts.forfeit, 1);
  const read = etag => onRequestGet({ request: new Request("https://test/api/community/v1/games", { headers: etag ? { "if-none-match": etag } : {} }), env });
  const reply = await read(); assert.equal(reply.status, 200);
  const etag = reply.headers.get("etag"), text = await reply.text(), snapshot = JSON.parse(text);
  assert.equal(validateCommunityCatalogSnapshot(snapshot).ok, true);
  assert.equal(snapshot.games.length, 5);
  assert.equal(snapshot.games.filter(game => game.sourcePackage.id === sourcePackage.id).length, 1);
  assert.doesNotMatch(text, /player-a|player-b|never-published|secretWord|stateData/);
  assert.equal((await read(`W/${etag}`)).status, 304);
  assert.equal((await sweep()).status, "superseded");
  outage = true;
  const unavailable = await sweep();
  assert.equal(unavailable.organicSourceStatus, "unavailable");
  assert.equal(unavailable.status, "superseded");
  assert.equal(await (await read()).text(), text, "An equal/older fallback cannot overwrite the valid published snapshot");
  outage = false;
  assert.equal((await sweep()).organicSourceStatus, "available");
  assert.equal(await (await read()).text(), text);
});
