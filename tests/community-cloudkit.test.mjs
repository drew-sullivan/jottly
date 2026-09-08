import assert from "node:assert/strict";
import test from "node:test";
import {
  CloudKitCommunityClient,
  cloudKitDatabasePath,
  ecdsaSignatureToDER,
  importP256PrivateKey,
  makeCloudKitHeaders,
  makeRecordsQueryBody,
  requestBodyDigestBase64,
  signedMessage,
} from "../functions/api/community/v1/cloudkit-client.js";

test("query requests only stateData inside the exact server-time window", () => {
  const body = makeRecordsQueryBody({ fallbackStartMilliseconds: 10, asOfMilliseconds: 20, continuationMarker: "next" });
  assert.deepEqual(body.desiredKeys, ["stateData"]);
  assert.deepEqual(body.query.filterBy.map(({ systemFieldName, comparator, fieldValue }) => (
    [systemFieldName, comparator, fieldValue.value]
  )), [
    ["modifiedTimestamp", "GREATER_THAN_OR_EQUALS", 10],
    ["modifiedTimestamp", "LESS_THAN", 20],
  ]);
  assert.deepEqual(body.query.sortBy, [
    { systemFieldName: "modifiedTimestamp", ascending: true },
  ]);
  assert.equal(body.query.filterBy.some((filter) => "fieldName" in filter), false);
  assert.equal(body.query.sortBy.some((sort) => "fieldName" in sort), false);
  assert.equal(body.continuationMarker, "next");
  assert.equal(body.resultsLimit, 200);
});

test("signed messages use the date, Base64 body digest, and exact CloudKit path", async () => {
  const body = new TextEncoder().encode('{"hello":"world"}');
  const digest = await requestBodyDigestBase64(body);
  const path = cloudKitDatabasePath({ containerIdentifier: "iCloud.com.dsull.Jotto", environment: "production" });
  assert.equal(path, "/database/1/iCloud.com.dsull.Jotto/production/public/records/query");
  assert.equal(signedMessage({ date: "2026-09-08T12:00:00Z", bodyDigestBase64: digest, path }), `2026-09-08T12:00:00Z:${digest}:${path}`);
});

test("raw P-256 signatures become canonical DER integers", () => {
  const raw = new Uint8Array(64);
  raw[0] = 0x80;
  raw[31] = 0x01;
  raw[32] = 0x00;
  raw[63] = 0x7f;
  const der = ecdsaSignatureToDER(raw);
  assert.equal(der[0], 0x30);
  assert.equal(der[2], 0x02);
  assert.equal(der[3], 33);
  assert.equal(der[4], 0);
  assert.equal(der[37], 0x02);
  assert.equal(der[38], 1);
  assert.equal(der[39], 0x7f);
  assert.deepEqual(ecdsaSignatureToDER(der), der);
});

test("PKCS8 import and CloudKit headers produce a verifiable signature", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const privateKey = await importP256PrivateKey(bytesToBase64(pkcs8));
  const body = new TextEncoder().encode("{}");
  const path = "/database/1/iCloud.test/production/public/records/query";
  const date = "2026-09-08T12:00:00Z";
  const headers = await makeCloudKitHeaders({ keyID: "key", privateKey, bodyBytes: body, path, date });
  assert.equal(headers["X-Apple-CloudKit-Request-KeyID"], "key");
  assert.equal(headers["X-Apple-CloudKit-Request-ISO8601Date"], date);
  const message = new TextEncoder().encode(signedMessage({
    date,
    bodyDigestBase64: await requestBodyDigestBase64(body),
    path,
  }));
  const raw = derToRaw(base64ToBytes(headers["X-Apple-CloudKit-Request-SignatureV1"]));
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, raw, message), true);
});

test("pagination consumes each continuation marker exactly once", async () => {
  const calls = [];
  const key = await exportedPrivateKey();
  const responses = [
    { records: [{ recordName: "one" }], continuationMarker: "page-2" },
    { records: [{ recordName: "two" }] },
  ];
  const client = new CloudKitCommunityClient({
    containerIdentifier: "iCloud.test", environment: "production", keyID: "key",
    privateKeyPKCS8Base64: key,
    fetchImplementation: async (_url, options) => {
      calls.push(JSON.parse(new TextDecoder().decode(options.body)));
      return Response.json(responses.shift());
    },
  });
  const result = await client.queryGameStates({ fallbackStartMilliseconds: 10, asOfMilliseconds: 20 });
  assert.deepEqual(result.records.map(({ recordName }) => recordName), ["one", "two"]);
  assert.equal(result.pageCount, 2);
  assert.equal(calls[0].continuationMarker, undefined);
  assert.equal(calls[1].continuationMarker, "page-2");
});

test("retryable status uses bounded retry while page and record errors fail the run", async () => {
  const key = await exportedPrivateKey();
  const sleeps = [];
  let calls = 0;
  const client = new CloudKitCommunityClient({
    containerIdentifier: "iCloud.test", environment: "production", keyID: "key",
    privateKeyPKCS8Base64: key,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    fetchImplementation: async () => {
      calls += 1;
      if (calls === 1) return new Response("private body", { status: 503 });
      return Response.json({ records: [] });
    },
  });
  assert.equal((await client.queryGameStates({ fallbackStartMilliseconds: 10, asOfMilliseconds: 20 })).pageCount, 1);
  assert.deepEqual(sleeps, [250]);

  const itemFailure = new CloudKitCommunityClient({
    containerIdentifier: "iCloud.test", environment: "production", keyID: "key",
    privateKeyPKCS8Base64: key,
    fetchImplementation: async () => Response.json({ records: [{ serverErrorCode: "UNKNOWN_ITEM" }] }),
  });
  await assert.rejects(
    itemFailure.queryGameStates({ fallbackStartMilliseconds: 10, asOfMilliseconds: 20 }),
    (error) => error.kind === "record error" && !error.message.includes("UNKNOWN_ITEM"),
  );
});

async function exportedPrivateKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
}

function derToRaw(der) {
  let offset = 2;
  const read = () => {
    assert.equal(der[offset++], 0x02);
    const length = der[offset++];
    let value = der.slice(offset, offset + length);
    offset += length;
    if (value[0] === 0) value = value.slice(1);
    const padded = new Uint8Array(32);
    padded.set(value, 32 - value.length);
    return padded;
  };
  return Uint8Array.from([...read(), ...read()]);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
