import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { onRequestPost, validateLovedGameCandidate } from "../functions/api/analytics/v1/loved-games.js";
import { sha256Hex, stableJSONStringify } from "../functions/api/community/v1/contract.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/featured-community-packages-v1.json", import.meta.url), "utf8"));
const gamePackage = fixture[0];
const contract = fixture[0].presentation.sharedProvenance.canonicalEnvelope;

function payload(overrides = {}) {
  return {
    schemaVersion: 2,
    submissionID: crypto.randomUUID(),
    package: structuredClone(gamePackage),
    ...overrides,
  };
}

test("a complete authored Solo package validates with all reusable metadata", async () => {
  const candidate = payload();
  assert.deepEqual(await validateLovedGameCandidate(candidate), {
    ok: true,
    definitionDigest: candidate.package.contract.definitionDigest,
    canonicalPayload: stableJSONStringify(candidate.package),
    payloadKind: "game-package",
  });
  assert.equal(candidate.package.presentation.title, "Pocket Vowels");
  assert.equal(candidate.package.presentation.creator.displayName, "JotBot");
  assert.ok(candidate.package.presentation.glyph);
});

test("legacy contracts may omit the optional lexicon digest", async () => {
  const candidate = {
    schemaVersion: 1,
    submissionID: crypto.randomUUID(),
    contract: structuredClone(contract),
  };
  delete candidate.contract.definition.word.lexicon.contentDigest;
  candidate.contract.definitionDigest = await sha256Hex(
    stableJSONStringify(candidate.contract.definition),
  );
  assert.equal((await validateLovedGameCandidate(candidate)).ok, true);
});

test("reviewed featured contracts without embedded gameplay data stay compatible", async () => {
  for (const game of fixture) {
    const candidate = payload({
      package: structuredClone(game),
    });
    const result = await validateLovedGameCandidate(candidate);
    const hasConcreteOpener = candidate.package.contract.definition.guessTransformations.some(
      (component) => component.typeID === "com.icedmatchalabs.jottly.modifier.shared-opening-guess"
        && (component.version !== 2 || Object.keys(component.configuration).length > 0),
    );
    assert.equal(
      result.ok,
      !hasConcreteOpener,
      `${game.presentation.title} had the wrong discovery eligibility`,
    );
  }
});

test("the intake persists the complete game package idempotently", async () => {
  const db = new CandidateDB();
  const candidate = payload();
  const first = await onRequestPost(context(candidate, db));
  const replay = await onRequestPost(context(candidate, db));
  assert.deepEqual(await first.json(), { accepted: 1, inserted: 1 });
  assert.deepEqual(await replay.json(), { accepted: 1, inserted: 0 });
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0][1], gamePackage.contract.definitionDigest);
  const stored = JSON.parse(db.rows[0][2]);
  assert.deepEqual(stored, gamePackage);
  assert.equal(stored.presentation.title, "Pocket Vowels");
  assert.equal(stored.presentation.subtitle, gamePackage.presentation.subtitle);
  assert.deepEqual(stored.presentation.glyph, gamePackage.presentation.glyph);
  assert.deepEqual(stored.presentation.creator, gamePackage.presentation.creator);
  assert.deepEqual(stored.presentation.sharedProvenance, gamePackage.presentation.sharedProvenance);
  assert.equal(Object.hasOwn(stored, "secretWord"), false);
  assert.equal(Object.hasOwn(stored, "guesses"), false);
});

test("validation rejects gameplay state, tampering, non-Solo rules, and concrete opener words", async () => {
  const gameplay = payload({ secretWord: "never" });
  assert.equal((await validateLovedGameCandidate(gameplay)).ok, false);

  const tampered = payload();
  tampered.package.presentation.title = "Changed without a revision";
  assert.equal((await validateLovedGameCandidate(tampered)).ok, false);

  const friend = payload();
  friend.package.contract.definition.match.kind = "headToHead";
  assert.equal((await validateLovedGameCandidate(friend)).ok, false);

  const opener = payload();
  opener.package.contract.definition.guessTransformations.push({
    typeID: "com.icedmatchalabs.jottly.modifier.shared-opening-guess",
    version: 1,
    configuration: { word: "crane" },
  });
  assert.equal((await validateLovedGameCandidate(opener)).ok, false);
});

test("validate-only avoids D1 and malformed or oversized requests fail closed", async () => {
  const db = new CandidateDB();
  const valid = await onRequestPost(context(payload(), db, { "x-jottly-validate-only": "1" }));
  assert.deepEqual(await valid.json(), { accepted: 1 });
  assert.equal(db.rows.length, 0);

  const wrongType = new Request("https://icedmatchalabs.com/api/analytics/v1/loved-games", {
    method: "POST", headers: { "content-type": "text/plain" }, body: "hello",
  });
  assert.equal((await onRequestPost({ request: wrongType, env: { ANALYTICS_DB: db } })).status, 415);
  const oversized = context(payload(), db, { "content-length": String(65 * 1024) });
  assert.equal((await onRequestPost(oversized)).status, 413);
});

test("the global daily cap rejects storage before another row is written", async () => {
  const db = new CandidateDB(1_000);
  const response = await onRequestPost(context(payload(), db));
  assert.equal(response.status, 429);
  assert.equal(db.rows.length, 0);
});

function context(body, db, extraHeaders = {}) {
  return {
    request: new Request("https://icedmatchalabs.com/api/analytics/v1/loved-games", {
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
    }),
    env: { ANALYTICS_DB: db },
  };
}

class CandidateDB {
  constructor(dailyCount = 0) {
    this.dailyCount = dailyCount;
    this.rows = [];
    this.ids = new Set();
  }
  prepare(sql) {
    const db = this;
    return {
      sql,
      values: [],
      bind(...values) {
        return {
          sql,
          values,
          async run() {
            const inserted = db.ids.has(values[0]) ? 0 : 1;
            db.ids.add(values[0]);
            if (inserted) db.rows.push(values);
            return { meta: { changes: inserted } };
          },
        };
      },
      async first() { return { count: db.dailyCount }; },
    };
  }
  async batch(statements) { return statements.map(() => ({ success: true, meta: { changes: 0 } })); }
}
