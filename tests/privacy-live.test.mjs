import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const policy = await readFile(new URL("../privacy.html", import.meta.url), "utf8");
const enabled = process.env.RUN_LIVE_PRIVACY_TESTS === "1";
const origin = process.env.PRIVACY_POLICY_ORIGIN ?? "https://icedmatchalabs.com";
const pagesOrigin = "https://drew-sullivan.github.io/jottly/";
const internalRecordRoutes = [
  "docs/work-items/privacy-policy-disclosures.json",
  "docs/work-items/github-pages-internal-docs-exclusion.json",
];
const disclosures = [
  "Both optional sharing settings start off",
  "Contribute favorite custom games",
  "complete reusable game package",
  "creator attribution, package identifiers",
  "automatically send a sanitized error report",
  "separate from the two optional sharing settings",
  "may process audio using its speech-recognition services",
  "does not delete data already received",
  "does not delete another player's copy or all CloudKit records",
];

async function verifyPolicy(response, route) {
  assert.equal(response.status, 200, `${route}: HTTP ${response.status}; expected 200`);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html(?:;|$)/i, `${route}: expected HTML`);
  const html = await response.text();
  assert.match(html, /name="jottly-privacy-version" content="2026-09-27"/, `${route}: stale policy version`);
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  for (const disclosure of disclosures) assert.ok(text.includes(disclosure), `${route}: missing disclosure: ${disclosure}`);
}

async function verifyPolicyRoute(fetcher, url, canonicalURL = null) {
  const options = { redirect: "manual", headers: { accept: "text/html" }, signal: AbortSignal.timeout(15_000) };
  const reply = await fetcher(url, options);
  if (reply.status === 307 && canonicalURL !== null) {
    const location = reply.headers.get("location");
    assert.ok(location, `${url}: missing canonical redirect location`);
    assert.equal(new URL(location, url).href, canonicalURL.href, `${url}: unexpected canonical redirect`);
    await verifyPolicy(await fetcher(canonicalURL, options), canonicalURL.href);
    return;
  }
  await verifyPolicy(reply, url.href);
}

function verifyInternalRecord(reply, route, location = route) {
  assert.ok(internalRecordRoutes.includes(route), `${location}: not an expected internal work-record route`);
  assert.equal(reply.status, 404, `${location}: HTTP ${reply.status}; expected 404 for an excluded internal work record`);
}

function response(body, status = 200, type = "text/html; charset=utf-8") {
  return new Response(body, { status, headers: { "content-type": type } });
}

test("policy verification accepts the current complete policy", async () => {
  await verifyPolicy(response(policy), "/privacy");
});

test("policy verification rejects HTTP failures before consuming even matching content", async () => {
  for (const status of [301, 403, 404, 500, 503]) {
    let consumed = false;
    const reply = { status, headers: new Headers({ "content-type": "text/html" }), text: async () => { consumed = true; return policy; } };
    await assert.rejects(verifyPolicy(reply, "/privacy"), new RegExp(`/privacy: HTTP ${status}`));
    assert.equal(consumed, false);
  }
});

test("policy verification rejects stale versions, missing disclosures and non-HTML responses", async () => {
  await assert.rejects(verifyPolicy(response(policy.replaceAll("2026-09-27", "2026-09-18")), "/privacy"), /stale policy version/);
  await assert.rejects(verifyPolicy(response(policy, 200, "application/json"), "/privacy"), /expected HTML/);
  for (const disclosure of disclosures) {
    const flattened = policy.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const incomplete = '<meta name="jottly-privacy-version" content="2026-09-27">' + flattened.replaceAll(disclosure, "[removed]");
    await assert.rejects(verifyPolicy(response(incomplete), "/privacy"), /missing disclosure/);
  }
});

test("policy route verification explicitly handles only the known canonical redirect", async () => {
  const alias = new URL("https://icedmatchalabs.com/privacy.html");
  const canonical = new URL("/privacy", alias);
  const visited = [];
  await verifyPolicyRoute(async (url, options) => {
    visited.push(url.href);
    assert.equal(options.redirect, "manual");
    return url.href === alias.href
      ? new Response(null, { status: 307, headers: { location: "/privacy" } })
      : response(policy);
  }, alias, canonical);
  assert.deepEqual(visited, [alias.href, canonical.href]);
  await verifyPolicyRoute(async () => response(policy), alias, canonical);
  for (const location of ["https://example.com/privacy", "/support", "/privacy?unexpected=1"]) {
    await assert.rejects(verifyPolicyRoute(async () => new Response(null, { status: 307, headers: { location } }), alias, canonical), /unexpected canonical redirect/);
  }
  await assert.rejects(verifyPolicyRoute(async () => new Response(null, { status: 307 }), alias, canonical), /missing canonical redirect/);
  await assert.rejects(verifyPolicyRoute(async () => new Response(null, { status: 307, headers: { location: "/privacy" } }), canonical), /HTTP 307/);
  await assert.rejects(verifyPolicyRoute(async () => new Response(null, { status: 307, headers: { location: "/privacy" } }), alias, canonical), /HTTP 307/);
  for (const status of [301, 302, 308, 403, 404, 503]) {
    await assert.rejects(verifyPolicyRoute(async () => response(policy, status), alias, canonical), new RegExp(`HTTP ${status}`));
  }
});

test("internal-record verification accepts 404 only for explicitly identified internal routes", () => {
  for (const route of internalRecordRoutes) {
    verifyInternalRecord({ status: 404 }, route);
    for (const status of [200, 204, 301, 307, 403, 500, 503]) {
      const reply = { status, text() { assert.fail("An unexpected HTTP status must not consume the body"); } };
      assert.throws(() => verifyInternalRecord(reply, route), new RegExp(`HTTP ${status}; expected 404`));
    }
  }
  for (const route of ["privacy", "privacy.html", "docs/unknown.json", "docs/work-items/privacy-policy-disclosures.json?unexpected=1"]) {
    assert.throws(() => verifyInternalRecord({ status: 404 }, route), /not an expected internal work-record route/);
  }
});

test("Production serves the revised policy on both supported routes", { skip: !enabled }, async () => {
  const canonical = new URL("/privacy", origin);
  await verifyPolicyRoute(fetch, canonical);
  await verifyPolicyRoute(fetch, new URL("/privacy.html", origin), canonical);
});

test("both publication surfaces exclude work records while retaining the current public policy", { skip: !enabled }, async () => {
  for (const base of [new URL("/", origin), new URL(pagesOrigin)]) {
    const publicPolicy = new URL(base.pathname === "/" ? "privacy" : "privacy.html", base);
    await verifyPolicyRoute(fetch, publicPolicy);
    for (const route of internalRecordRoutes) {
      const url = new URL(route, base);
      const reply = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
      verifyInternalRecord(reply, route, url.href);
    }
  }
});
