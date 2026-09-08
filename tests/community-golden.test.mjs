import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  validateCommunityCatalogSnapshot,
  validateCommunitySourcePackage,
} from "../functions/api/community/v1/contract.js";
import { projectCommunityObservations } from "../functions/api/community/v1/sweep.js";
import { allowlistFor, completionRecord } from "./community-fixtures.mjs";

const asOf = Date.parse("2026-09-08T12:00:00Z");

test("Swift-authored golden package crosses publication and catalog boundaries unchanged", async () => {
  const encoded = (await readFile(
    new URL("./fixtures/community-game-package-v1.base64", import.meta.url),
    "utf8",
  )).trim();
  const sourcePackage = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  const validation = validateCommunitySourcePackage(sourcePackage);
  assert.equal(validation.ok, true);

  const allowlist = new Map(allowlistFor([sourcePackage]).map((entry) => [
    entry.packageID, entry.canonicalDefinitionDigest,
  ]));
  const projection = projectCommunityObservations({
    records: [completionRecord(sourcePackage, { timestamp: asOf - 1 })],
    allowlist,
    fallbackStartMilliseconds: asOf - 28 * 86_400_000,
    asOfMilliseconds: asOf,
  });
  assert.equal(projection.observations.length, 1);
  assert.deepEqual(projection.observations[0].sourcePackage, sourcePackage);

  const snapshot = {
    schemaVersion: 1,
    generatedAtUnixMilliseconds: asOf,
    weeklyWindowStartsAtUnixMilliseconds: asOf - 7 * 86_400_000,
    fallbackWindowStartsAtUnixMilliseconds: asOf - 28 * 86_400_000,
    catalogKind: "weekly",
    games: [{ rank: 1, selectionSource: "weeklyPopular", sourcePackage }],
  };
  assert.equal(validateCommunityCatalogSnapshot(snapshot).ok, true);
});
