import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const policy = await readFile(new URL("../privacy.html", import.meta.url), "utf8");
const enabled = process.env.RUN_LIVE_PRIVACY_TESTS === "1";
const origin = process.env.PRIVACY_POLICY_ORIGIN ?? "https://icedmatchalabs.com";
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
  assert.match(html, /name="jottly-privacy-version" content="2026-09-25"/, `${route}: stale policy version`);
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  for (const disclosure of disclosures) assert.ok(text.includes(disclosure), `${route}: missing disclosure: ${disclosure}`);
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
  await assert.rejects(verifyPolicy(response(policy.replaceAll("2026-09-25", "2026-09-18")), "/privacy"), /stale policy version/);
  await assert.rejects(verifyPolicy(response(policy, 200, "application/json"), "/privacy"), /expected HTML/);
  for (const disclosure of disclosures) {
    const flattened = policy.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const incomplete = '<meta name="jottly-privacy-version" content="2026-09-25">' + flattened.replaceAll(disclosure, "[removed]");
    await assert.rejects(verifyPolicy(response(incomplete), "/privacy"), /missing disclosure/);
  }
});

test("Production serves the revised policy on both supported routes", { skip: !enabled }, async () => {
  for (const route of ["/privacy", "/privacy.html"]) {
    const reply = await fetch(new URL(route, origin), { headers: { accept: "text/html" }, signal: AbortSignal.timeout(15_000) });
    await verifyPolicy(reply, route);
  }
});
