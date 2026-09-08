import { CloudKitCommunityClient } from "./cloudkit-client.js";
import {
  communityCatalogMaximumEntries,
  packageContentFingerprint,
  validateCommunityAllowlist,
  validateCommunitySourcePackage,
  validateFeaturedPackages,
} from "./contract.js";
import { rankCommunityGames } from "./ranking.js";
import { publishCommunityCatalog } from "./schema.js";
import {
  CommunityPublicationPolicy,
  CommunityPublicationRejection,
} from "./publication-policy.js";
import { communityAllowlist } from "../../../../community/allowlist-v1.js";
import { featuredCommunityPackages } from "../../../../community/featured-games-v1.js";

const maximumStateDataBytes = 2_097_152;

export async function runCommunitySweep({
  env,
  asOfMilliseconds,
  client,
  allowlistEntries = communityAllowlist,
  featuredPackages = featuredCommunityPackages,
  publish = publishCommunityCatalog,
  allowDevelopmentSource = false,
}) {
  const startedAt = Date.now();
  const configuration = communityConfiguration(env, { allowDevelopmentSource });
  if (!Number.isSafeInteger(asOfMilliseconds)) throw new Error("Invalid scheduled time");
  const allowlistValidation = validateCommunityAllowlist(allowlistEntries);
  if (!allowlistValidation.ok) throw new Error("Invalid community allowlist");
  const allowlist = allowlistValidation.values;
  const featuredValidation = validateFeaturedPackages(
    featuredPackages,
    allowlist,
    configuration.catalogSize,
  );
  if (!featuredValidation.ok) throw new Error("Invalid featured package pool");
  if (!env.COMMUNITY_DB) throw new Error("Community D1 binding unavailable");

  const cloudKit = client ?? new CloudKitCommunityClient({
    containerIdentifier: configuration.containerIdentifier,
    environment: configuration.environment,
    keyID: env.CLOUDKIT_KEY_ID,
    privateKeyPKCS8Base64: env.CLOUDKIT_PRIVATE_KEY_PKCS8_BASE64,
  });
  const fallbackStart = asOfMilliseconds - configuration.fallbackWindowDays * 86_400_000;
  const query = await cloudKit.queryGameStates({ fallbackStartMilliseconds: fallbackStart, asOfMilliseconds });
  const projection = projectCommunityObservations({
    records: query.records,
    allowlist,
    fallbackStartMilliseconds: fallbackStart,
    asOfMilliseconds,
  });
  const ranked = rankCommunityGames({
    observations: projection.observations,
    featuredPackages,
    asOfMilliseconds,
    catalogSize: configuration.catalogSize,
    weeklyWindowDays: configuration.weeklyWindowDays,
    fallbackWindowDays: configuration.fallbackWindowDays,
    minimumDistinctPairs: configuration.minimumDistinctPairs,
    organicGraduationPairs: configuration.organicGraduationPairs,
  });
  const snapshot = {
    schemaVersion: 1,
    generatedAtUnixMilliseconds: asOfMilliseconds,
    weeklyWindowStartsAtUnixMilliseconds: ranked.weeklyWindowStartsAtUnixMilliseconds,
    fallbackWindowStartsAtUnixMilliseconds: ranked.fallbackWindowStartsAtUnixMilliseconds,
    catalogKind: ranked.catalogKind,
    games: ranked.games,
  };
  const publication = await publish(env.COMMUNITY_DB, snapshot);
  return {
    status: publication.published ? "published" : "superseded",
    durationMilliseconds: Math.max(0, Date.now() - startedAt),
    cloudKitPageCount: query.pageCount,
    recordsInspected: query.records.length,
    qualifyingCompletions: projection.observations.length,
    malformedRecordCount: projection.metrics.malformedRecordCount,
    unallowlistedRecordCount: projection.metrics.unallowlistedRecordCount,
    rejectionCounts: projection.metrics.rejectionCounts,
    conflictingPackageCount: ranked.metrics.conflictingPackageCount,
    weeklyCandidateCount: ranked.metrics.weeklyCandidateCount,
    recentCandidateCount: ranked.metrics.recentCandidateCount,
    featuredFillCount: ranked.metrics.featuredFillCount,
    publishedEntryCount: ranked.games.length,
    generatedSnapshotAgeMilliseconds: 0,
  };
}

export function projectCommunityObservations({ records, allowlist, fallbackStartMilliseconds, asOfMilliseconds }) {
  const observations = [];
  const metrics = {
    malformedRecordCount: 0,
    unallowlistedRecordCount: 0,
    rejectionCounts: {},
  };
  const policy = new CommunityPublicationPolicy();
  for (const record of records) {
    let projected;
    try {
      projected = projectRecord(record, {
        allowlist,
        fallbackStartMilliseconds,
        asOfMilliseconds,
        policy,
      });
    } catch {
      metrics.malformedRecordCount += 1;
      continue;
    }
    if (projected.rejection) {
      metrics.rejectionCounts[projected.rejection] = (metrics.rejectionCounts[projected.rejection] ?? 0) + 1;
    }
    if (projected.rejection === CommunityPublicationRejection.unallowlisted) {
      metrics.unallowlistedRecordCount += 1;
    } else if (projected.observation) {
      observations.push(projected.observation);
    }
  }
  return { observations, metrics };
}

function projectRecord(record, { allowlist, fallbackStartMilliseconds, asOfMilliseconds, policy }) {
  if (!record || typeof record !== "object" || record.serverErrorCode) throw new Error("Malformed record");
  const completedAtMilliseconds = record.modified?.timestamp ?? record.modifiedTimestamp;
  if (!Number.isSafeInteger(completedAtMilliseconds)) throw new Error("Missing modification time");
  const state = decodeStateData(record.fields?.stateData?.value);
  const candidate = {
    state,
    completedAtMilliseconds,
    fallbackStartMilliseconds,
    asOfMilliseconds,
    allowlist,
  };
  const decision = policy.evaluate(candidate);
  if (!decision.allowed) return { rejection: decision.reason };
  const inviterID = state.game.inviter?.id;
  const inviteeID = state.game.invitee?.id;
  const sourcePackage = state.game.gamePackage;
  const validation = validateCommunitySourcePackage(sourcePackage);
  return {
    observation: {
      packageID: sourcePackage.id,
      canonicalDefinitionDigest: validation.canonicalDigest,
      sourcePackage,
      packageFingerprint: packageContentFingerprint(sourcePackage),
      unorderedPairKey: JSON.stringify([inviterID, inviteeID].sort()),
      completedAtMilliseconds,
    },
  };
}

function decodeStateData(value) {
  if (typeof value !== "string"
      || value.length === 0
      || value.length > Math.ceil(maximumStateDataBytes / 3) * 4 + 4
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
      || value.length % 4 !== 0) throw new Error("Invalid state data");
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw new Error("Invalid state data");
  }
  if (binary.length > maximumStateDataBytes) throw new Error("Oversized state data");
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid state data");
  }
}

function communityConfiguration(env, { allowDevelopmentSource = false } = {}) {
  const configuration = {
    containerIdentifier: env.CLOUDKIT_CONTAINER ?? "iCloud.com.dsull.Jotto",
    environment: env.CLOUDKIT_ENVIRONMENT ?? "production",
    catalogSize: configuredInteger(env.COMMUNITY_CATALOG_SIZE, 6),
    weeklyWindowDays: configuredInteger(env.COMMUNITY_WEEKLY_WINDOW_DAYS, 7),
    fallbackWindowDays: configuredInteger(env.COMMUNITY_FALLBACK_WINDOW_DAYS, 28),
    minimumDistinctPairs: configuredInteger(env.COMMUNITY_MINIMUM_DISTINCT_PAIRS, 1),
    organicGraduationPairs: configuredInteger(env.COMMUNITY_ORGANIC_GRADUATION_PAIRS, 2),
  };
  const validEnvironment = configuration.environment === "production"
    || (allowDevelopmentSource && configuration.environment === "development");
  if (!configuration.containerIdentifier
      || !validEnvironment
      || !env.CLOUDKIT_KEY_ID
      || !env.CLOUDKIT_PRIVATE_KEY_PKCS8_BASE64
      || configuration.catalogSize > communityCatalogMaximumEntries
      || configuration.fallbackWindowDays <= configuration.weeklyWindowDays) {
    throw new Error("Incomplete production CloudKit configuration");
  }
  return configuration;
}

function configuredInteger(value, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Invalid community configuration");
  return parsed;
}
