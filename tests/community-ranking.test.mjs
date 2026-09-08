import assert from "node:assert/strict";
import test from "node:test";
import { rankCommunityGames, rotateFeatured } from "../functions/api/community/v1/ranking.js";
import { communityPackage, featuredPool } from "./community-fixtures.mjs";

const day = 86_400_000;
const asOf = Date.parse("2026-09-08T12:00:00Z");

function observation(packageIndex, pair, ageDays, overrides = {}) {
  const sourcePackage = overrides.sourcePackage ?? communityPackage(packageIndex);
  return {
    packageID: sourcePackage.id,
    sourcePackage,
    unorderedPairKey: pair,
    completedAtMilliseconds: asOf - ageDays * day,
    ...overrides,
  };
}

test("one pair and package contributes once per UTC day", () => {
  const packageOne = communityPackage(1);
  const result = rankCommunityGames({
    observations: [
      observation(1, "a-b", 1, { sourcePackage: packageOne }),
      observation(1, "a-b", 1.1, { sourcePackage: packageOne }),
      observation(1, "a-b", 2, { sourcePackage: packageOne }),
      observation(2, "c-d", 1),
    ],
    featuredPackages: featuredPool(), asOfMilliseconds: asOf,
  });
  assert.equal(result.games[0].sourcePackage.id, packageOne.id);
  assert.equal(result.metrics.weeklyCandidateCount, 2);
});

test("weekly, recent, then featured tiers fill in deterministic order", () => {
  const observations = [
    observation(1, "a-b", 1), observation(1, "c-d", 2),
    observation(2, "a-b", 10), observation(2, "c-d", 11),
  ];
  const result = rankCommunityGames({ observations, featuredPackages: featuredPool(), asOfMilliseconds: asOf });
  assert.deepEqual(result.games.slice(0, 2).map(({ selectionSource }) => selectionSource), ["weeklyPopular", "recentlyPopular"]);
  assert.equal(result.games.length, 6);
  assert.equal(result.metrics.featuredFillCount, 4);
  assert.equal(result.catalogKind, "mixed");
});

test("weekly ordering uses completions, pairs, recency, then package identity", () => {
  const observations = [
    observation(3, "a-b", 1), observation(3, "c-d", 1),
    observation(2, "a-b", 1), observation(2, "c-d", 1),
    observation(1, "a-b", 3), observation(1, "c-d", 3), observation(1, "e-f", 3),
  ];
  const forward = rankCommunityGames({ observations, featuredPackages: featuredPool(), asOfMilliseconds: asOf });
  const reverse = rankCommunityGames({ observations: [...observations].reverse(), featuredPackages: featuredPool(), asOfMilliseconds: asOf });
  assert.deepEqual(forward.games.map((game) => game.sourcePackage.id), reverse.games.map((game) => game.sourcePackage.id));
  assert.equal(forward.games[0].sourcePackage.id, communityPackage(1).id);
  assert.equal(forward.games[1].sourcePackage.id, communityPackage(2).id);
});

test("conflicting package content quarantines every observation for that identity", () => {
  const original = communityPackage(1);
  const conflicting = structuredClone(original);
  conflicting.presentation.title = "Conflicting title";
  const result = rankCommunityGames({
    observations: [
      observation(1, "a-b", 1, { sourcePackage: original }),
      observation(1, "c-d", 2, { sourcePackage: conflicting }),
    ],
    featuredPackages: featuredPool(), asOfMilliseconds: asOf,
  });
  assert.equal(result.metrics.conflictingPackageCount, 1);
  assert.equal(result.games.some((game) => game.sourcePackage.id === original.id), false);
});

test("window bounds are half-open and future completions never count", () => {
  const result = rankCommunityGames({
    observations: [
      observation(1, "a-b", 7),
      observation(2, "c-d", 28),
      observation(3, "e-f", -1),
      observation(4, "g-h", 27.999),
    ],
    featuredPackages: featuredPool(), asOfMilliseconds: asOf,
  });
  assert.equal(result.games[0].sourcePackage.id, communityPackage(1).id);
  assert.equal(result.games[0].selectionSource, "weeklyPopular");
  assert.equal(result.games[1].sourcePackage.id, communityPackage(4).id);
  assert.equal(result.games[1].selectionSource, "recentlyPopular");
});

test("catalog graduates only when all six weekly entries meet the pair threshold", () => {
  const observations = Array.from({ length: 6 }, (_, index) => [
    observation(index + 1, `a-${index}`, 1),
    observation(index + 1, `b-${index}`, 2),
  ]).flat();
  const graduated = rankCommunityGames({
    observations, featuredPackages: featuredPool(), asOfMilliseconds: asOf, organicGraduationPairs: 2,
  });
  assert.equal(graduated.catalogKind, "weekly");
  const below = rankCommunityGames({
    observations: observations.slice(0, -1), featuredPackages: featuredPool(), asOfMilliseconds: asOf,
    organicGraduationPairs: 2,
  });
  assert.equal(below.catalogKind, "mixed");
});

test("featured rotation is stable within an ISO week and changes in a later week", () => {
  const packages = featuredPool(8);
  assert.deepEqual(rotateFeatured(packages, asOf), rotateFeatured(packages, asOf + day));
  assert.notDeepEqual(rotateFeatured(packages, asOf), rotateFeatured(packages, asOf + 7 * day));
});
