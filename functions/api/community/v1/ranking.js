import {
  packageImmutableIdentityFingerprint,
  packageMetadataRevision,
  packageRevisionContentFingerprint,
} from "./contract.js";

export const millisecondsPerDay = 86_400_000;

export function rankCommunityGames({
  observations,
  featuredPackages,
  asOfMilliseconds,
  catalogSize = 5,
  weeklyWindowDays = 7,
  fallbackWindowDays = 28,
  minimumDistinctPairs = 1,
  organicGraduationPairs = 2,
}) {
  requirePositiveInteger(catalogSize, "catalogSize");
  requirePositiveInteger(weeklyWindowDays, "weeklyWindowDays");
  requirePositiveInteger(fallbackWindowDays, "fallbackWindowDays");
  if (fallbackWindowDays <= weeklyWindowDays) throw new Error("fallback window must exceed weekly window");
  const weeklyStart = asOfMilliseconds - weeklyWindowDays * millisecondsPerDay;
  const fallbackStart = asOfMilliseconds - fallbackWindowDays * millisecondsPerDay;
  const quarantined = conflictingPackageIDs(observations);
  const aggregates = aggregateObservations(
    observations.filter((item) => !quarantined.has(item.packageID)),
    { fallbackStart, weeklyStart, asOfMilliseconds }
  );
  const weekly = [...aggregates.values()]
    .filter((item) => item.weeklyPairs.size >= minimumDistinctPairs)
    .sort(weeklyComparator);
  const weeklyIDs = new Set(weekly.map((item) => item.packageID));
  const recent = [...aggregates.values()]
    .filter((item) => !weeklyIDs.has(item.packageID) && item.recentPairs.size >= minimumDistinctPairs)
    .sort(recentComparator);

  const selected = [];
  appendCandidates(selected, weekly, "weeklyPopular", catalogSize);
  appendCandidates(selected, recent, "recentlyPopular", catalogSize);
  const organicIDs = new Set(selected.map((item) => item.sourcePackage.id));
  const featured = rotateFeatured(featuredPackages, asOfMilliseconds)
    .filter((sourcePackage) => !organicIDs.has(sourcePackage.id));
  for (const sourcePackage of featured) {
    if (selected.length >= catalogSize) break;
    selected.push({ sourcePackage, selectionSource: "featured", aggregate: null });
  }
  if (selected.length !== catalogSize) throw new Error("community catalog could not be filled");

  const allGraduatedWeekly = selected.every(({ selectionSource, aggregate }) => (
    selectionSource === "weeklyPopular"
      && aggregate.weeklyPairs.size >= organicGraduationPairs
  ));
  return {
    weeklyWindowStartsAtUnixMilliseconds: weeklyStart,
    fallbackWindowStartsAtUnixMilliseconds: fallbackStart,
    catalogKind: allGraduatedWeekly ? "weekly" : "mixed",
    games: selected.map(({ sourcePackage, selectionSource }, index) => ({
      rank: index + 1,
      selectionSource,
      sourcePackage,
    })),
    metrics: {
      conflictingPackageCount: quarantined.size,
      weeklyCandidateCount: weekly.length,
      recentCandidateCount: recent.length,
      featuredFillCount: selected.filter((item) => item.selectionSource === "featured").length,
    },
  };
}

export function conflictingPackageIDs(observations) {
  const packages = new Map();
  const conflicts = new Set();
  for (const observation of observations) {
    const revision = packageMetadataRevision(observation.sourcePackage);
    if (revision === null) {
      conflicts.add(observation.packageID);
      continue;
    }
    const immutableFingerprint = packageImmutableIdentityFingerprint(observation.sourcePackage);
    const revisionFingerprint = packageRevisionContentFingerprint(observation.sourcePackage);
    const existing = packages.get(observation.packageID);
    if (existing === undefined) {
      packages.set(observation.packageID, {
        immutableFingerprint,
        revisions: new Map([[revision, revisionFingerprint]]),
      });
      continue;
    }
    if (existing.immutableFingerprint !== immutableFingerprint
        || (existing.revisions.has(revision)
          && existing.revisions.get(revision) !== revisionFingerprint)) {
      conflicts.add(observation.packageID);
      continue;
    }
    existing.revisions.set(revision, revisionFingerprint);
  }
  return conflicts;
}

function aggregateObservations(observations, window) {
  const results = new Map();
  const counted = new Set();
  for (const observation of observations) {
    const timestamp = observation.completedAtMilliseconds;
    if (!Number.isSafeInteger(timestamp)
        || timestamp < window.fallbackStart
        || timestamp >= window.asOfMilliseconds) continue;
    const aggregate = results.get(observation.packageID) ?? {
      packageID: observation.packageID,
      sourcePackage: observation.sourcePackage,
      metadataRevision: packageMetadataRevision(observation.sourcePackage),
      weeklyCount: 0,
      weeklyPairs: new Set(),
      recentCount: 0,
      recentPairs: new Set(),
      mostRecentMilliseconds: 0,
    };
    const metadataRevision = packageMetadataRevision(observation.sourcePackage);
    if (metadataRevision > aggregate.metadataRevision) {
      aggregate.sourcePackage = observation.sourcePackage;
      aggregate.metadataRevision = metadataRevision;
    }
    aggregate.mostRecentMilliseconds = Math.max(aggregate.mostRecentMilliseconds, timestamp);
    results.set(observation.packageID, aggregate);

    const day = new Date(timestamp).toISOString().slice(0, 10);
    const contribution = `${observation.packageID}\u0000${observation.unorderedPairKey}\u0000${day}`;
    if (counted.has(contribution)) continue;
    counted.add(contribution);
    if (timestamp >= window.weeklyStart) {
      aggregate.weeklyCount += 1;
      aggregate.weeklyPairs.add(observation.unorderedPairKey);
    } else {
      aggregate.recentCount += 1;
      aggregate.recentPairs.add(observation.unorderedPairKey);
    }
  }
  return results;
}

function weeklyComparator(left, right) {
  return right.weeklyCount - left.weeklyCount
    || right.weeklyPairs.size - left.weeklyPairs.size
    || right.mostRecentMilliseconds - left.mostRecentMilliseconds
    || left.packageID.localeCompare(right.packageID);
}

function recentComparator(left, right) {
  return right.recentCount - left.recentCount
    || right.recentPairs.size - left.recentPairs.size
    || right.mostRecentMilliseconds - left.mostRecentMilliseconds
    || left.packageID.localeCompare(right.packageID);
}

function appendCandidates(target, candidates, selectionSource, maximum) {
  for (const aggregate of candidates) {
    if (target.length >= maximum) return;
    target.push({ sourcePackage: aggregate.sourcePackage, selectionSource, aggregate });
  }
}

export function rotateFeatured(packages, timestamp) {
  if (packages.length < 2) return [...packages];
  const { year, week } = isoWeek(new Date(timestamp));
  const offset = Math.abs(year * 53 + week) % packages.length;
  return [...packages.slice(offset), ...packages.slice(0, offset)];
}

function isoWeek(date) {
  const working = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  working.setUTCDate(working.getUTCDate() + 4 - (working.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(working.getUTCFullYear(), 0, 1));
  return {
    year: working.getUTCFullYear(),
    week: Math.ceil((((working - yearStart) / millisecondsPerDay) + 1) / 7),
  };
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be positive`);
}
