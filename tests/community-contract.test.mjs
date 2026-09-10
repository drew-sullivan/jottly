import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { communityContract } from "../functions/api/community/v1/generated-contract.js";
import {
  stableJSONStringify,
  validateCommunityAllowlist,
  validateCommunityCatalogSnapshot,
  validateCommunitySourcePackage,
  validateFeaturedPackages,
} from "../functions/api/community/v1/contract.js";
import { allowlistFor, communityPackage, featuredPool } from "./community-fixtures.mjs";

test("generated contract exactly matches its machine-readable source", async () => {
  const source = JSON.parse(await readFile(
    new URL("../community/catalog-contract-v1.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(JSON.parse(JSON.stringify(communityContract)), source);
});

test("authored packages require portable identity, canonical Solo provenance, and save capability", () => {
  const valid = communityPackage(1);
  assert.equal(validateCommunitySourcePackage(valid).ok, true);
  const mutations = [
    (value) => { value.id = "catalog.lightning"; },
    (value) => { value.capabilities.canSaveToLibrary = false; },
    (value) => { value.presentation.authorship = "jottly"; },
    (value) => { value.presentation.sharedProvenance.savedGameID = crypto.randomUUID(); },
    (value) => { value.presentation.sharedProvenance.canonicalEnvelope.definition.match.kind = "headToHead"; },
    (value) => { value.contract.definition.match.kind = "unknown"; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(valid);
    mutate(candidate);
    assert.equal(validateCommunitySourcePackage(candidate).ok, false);
  }
});

test("package identity accepts the same canonical UUID space as Swift", () => {
  const sourcePackage = communityPackage(1);
  sourcePackage.id = "authored.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  sourcePackage.presentation.sharedProvenance.savedGameID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
  assert.equal(validateCommunitySourcePackage(sourcePackage).ok, true);
});

test("metadata revisions are positive safe integers and legacy packages default to revision one", () => {
  const legacy = communityPackage(1);
  assert.equal(validateCommunitySourcePackage(legacy).ok, true);
  for (const metadataRevision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2"]) {
    const candidate = communityPackage(1, { metadataRevision: 2 });
    candidate.presentation.sharedProvenance.metadataRevision = metadataRevision;
    assert.equal(validateCommunitySourcePackage(candidate).ok, false);
  }
  assert.equal(validateCommunitySourcePackage(communityPackage(1, { metadataRevision: 2 })).ok, true);
});

test("allowlists bind one exact package ID to one exact canonical digest", () => {
  const packages = [communityPackage(1), communityPackage(2)];
  const valid = validateCommunityAllowlist(allowlistFor(packages));
  assert.equal(valid.ok, true);
  assert.equal(valid.values.size, 2);
  assert.equal(validateCommunityAllowlist([...allowlistFor(packages), allowlistFor(packages)[0]]).ok, false);
  assert.equal(validateCommunityAllowlist([{ packageID: packages[0].id, canonicalDefinitionDigest: "wrong" }]).ok, false);
});

test("featured pools are complete, unique, structurally valid, and allowlisted", () => {
  const packages = featuredPool();
  const allowlist = validateCommunityAllowlist(allowlistFor(packages)).values;
  assert.equal(validateFeaturedPackages(packages, allowlist, 5).ok, true);
  assert.equal(validateFeaturedPackages(packages.slice(0, 4), allowlist, 5).ok, false);
  assert.equal(validateFeaturedPackages([...packages.slice(0, 4), packages[0]], allowlist, 5).ok, false);
});

test("catalog validation requires contiguous ranks, bounded entries, timestamps, and unique packages", () => {
  const generatedAt = Date.parse("2026-09-08T12:00:00Z");
  const packages = featuredPool();
  const snapshot = {
    schemaVersion: 1,
    generatedAtUnixMilliseconds: generatedAt,
    weeklyWindowStartsAtUnixMilliseconds: generatedAt - 7 * 86_400_000,
    fallbackWindowStartsAtUnixMilliseconds: generatedAt - 28 * 86_400_000,
    catalogKind: "mixed",
    games: packages.map((sourcePackage, index) => ({ rank: index + 1, selectionSource: "featured", sourcePackage })),
  };
  assert.equal(validateCommunityCatalogSnapshot(snapshot).ok, true);
  for (const mutate of [
    (value) => { value.schemaVersion = 2; },
    (value) => { value.games[1].rank = 8; },
    (value) => { value.games[1].sourcePackage = value.games[0].sourcePackage; },
    (value) => { value.catalogKind = "surprise"; },
    (value) => { value.weeklyWindowStartsAtUnixMilliseconds = value.generatedAtUnixMilliseconds; },
  ]) {
    const candidate = structuredClone(snapshot);
    mutate(candidate);
    assert.equal(validateCommunityCatalogSnapshot(candidate).ok, false);
  }
});

test("stable serialization is independent of object insertion order", () => {
  assert.equal(stableJSONStringify({ b: 2, a: { d: 4, c: 3 } }), stableJSONStringify({ a: { c: 3, d: 4 }, b: 2 }));
});
