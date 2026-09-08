import { communityContract } from "./generated-contract.js";

// Swift's UUID decoder validates the canonical hexadecimal shape, but does not require a specific
// RFC version or variant nibble. The public contract must accept exactly that same identity space.
const authoredPackagePattern = /^authored\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const digestPattern = /^[0-9a-f]{64}$/;

export const communityCatalogSchemaVersion = communityContract.schemaVersion;
export const communityCatalogMaximumEntries = communityContract.catalog.maximumEntries;
export const communityCatalogMaximumBytes = communityContract.catalog.maximumBytes;
export const communitySelectionSources = communityContract.catalog.selectionSources;

export function canonicalSoloDigest(sourcePackage) {
  return sourcePackage?.presentation?.sharedProvenance?.canonicalEnvelope?.definitionDigest ?? null;
}

export function validateCommunitySourcePackage(sourcePackage) {
  if (!isPlainObject(sourcePackage) || sourcePackage.schemaVersion !== communityContract.package.schemaVersion) return invalid("package schema");
  const packageMatch = authoredPackagePattern.exec(sourcePackage.id ?? "");
  if (!packageMatch || !digestPattern.test(sourcePackage.revisionDigest ?? "")) return invalid("package identity");
  if (!isPlainObject(sourcePackage.contract)
      || sourcePackage.contract.protocolVersion !== communityContract.package.contractProtocolVersion
      || !isPlainObject(sourcePackage.contract.definition)
      || !digestPattern.test(sourcePackage.contract.definitionDigest ?? "")) {
    return invalid("package contract");
  }
  if (!communityContract.package.carrierTopologies.includes(sourcePackage.contract.definition?.match?.kind)) {
    return invalid("package topology");
  }
  if (!isPlainObject(sourcePackage.requirements) || !isPlainObject(sourcePackage.capabilities)) {
    return invalid("package requirements");
  }
  if (sourcePackage.capabilities.canSaveToLibrary !== true) return invalid("package capability");
  const presentation = sourcePackage.presentation;
  if (!isPlainObject(presentation)
      || presentation.authorship !== communityContract.package.authorship
      || !isPlainObject(presentation.glyph)) return invalid("package authorship");
  if (typeof presentation.title !== "string" || !presentation.title.trim()
      || presentation.title.length > communityContract.package.maximumTitleCharacters) {
    return invalid("package title");
  }
  if (typeof presentation.subtitle !== "string"
      || presentation.subtitle.length > communityContract.package.maximumSubtitleCharacters) {
    return invalid("package subtitle");
  }
  const provenance = presentation.sharedProvenance;
  if (!isPlainObject(provenance) || provenance.schemaVersion !== 1) return invalid("package provenance");
  if (provenance.savedGameID?.toLowerCase() !== packageMatch[1].toLowerCase()) {
    return invalid("package provenance identity");
  }
  const canonical = provenance.canonicalEnvelope;
  if (!isPlainObject(canonical)
      || canonical.protocolVersion !== communityContract.package.contractProtocolVersion
      || !digestPattern.test(canonical.definitionDigest ?? "")) {
    return invalid("canonical contract");
  }
  if (canonical.definition?.match?.kind !== communityContract.package.canonicalTopology) return invalid("canonical topology");
  return { ok: true, canonicalDigest: canonical.definitionDigest };
}

export function validateCommunityAllowlist(entries) {
  if (!Array.isArray(entries)) return invalid("allowlist shape");
  const values = new Map();
  for (const entry of entries) {
    if (!isPlainObject(entry)
        || !authoredPackagePattern.test(entry.packageID ?? "")
        || !digestPattern.test(entry.canonicalDefinitionDigest ?? "")
        || values.has(entry.packageID)) return invalid("allowlist entry");
    values.set(entry.packageID, entry.canonicalDefinitionDigest);
  }
  return { ok: true, values };
}

export function validateFeaturedPackages(packages, allowlist, minimumCount = 1) {
  if (!Array.isArray(packages) || packages.length < minimumCount) return invalid("featured pool size");
  const seen = new Set();
  for (const sourcePackage of packages) {
    const validation = validateCommunitySourcePackage(sourcePackage);
    if (!validation.ok
        || seen.has(sourcePackage.id)
        || allowlist.get(sourcePackage.id) !== validation.canonicalDigest) {
      return invalid("featured package");
    }
    seen.add(sourcePackage.id);
  }
  return { ok: true };
}

export function validateCommunityCatalogSnapshot(snapshot, options = {}) {
  if (!isPlainObject(snapshot) || snapshot.schemaVersion !== communityCatalogSchemaVersion) {
    return invalid("catalog schema");
  }
  const generatedAt = snapshot.generatedAtUnixMilliseconds;
  const weeklyStart = snapshot.weeklyWindowStartsAtUnixMilliseconds;
  const fallbackStart = snapshot.fallbackWindowStartsAtUnixMilliseconds;
  if (![generatedAt, weeklyStart, fallbackStart].every(Number.isSafeInteger)
      || !(fallbackStart < weeklyStart && weeklyStart < generatedAt)) {
    return invalid("catalog timestamps");
  }
  if (!new Set(["mixed", "weekly"]).has(snapshot.catalogKind)) return invalid("catalog kind");
  if (!Array.isArray(snapshot.games)
      || snapshot.games.length < 1
      || snapshot.games.length > communityCatalogMaximumEntries) {
    return invalid("catalog entries");
  }
  const seen = new Set();
  for (const [index, game] of snapshot.games.entries()) {
    if (!isPlainObject(game) || game.rank !== index + 1
        || !communitySelectionSources.includes(game.selectionSource)) {
      return invalid("catalog ordering");
    }
    const packageValidation = (options.validatePackage ?? validateCommunitySourcePackage)(game.sourcePackage);
    if (!packageValidation.ok || seen.has(game.sourcePackage.id)) return invalid("catalog package");
    seen.add(game.sourcePackage.id);
  }
  const payload = stableJSONStringify(snapshot);
  if (new TextEncoder().encode(payload).byteLength > communityCatalogMaximumBytes) {
    return invalid("catalog size");
  }
  return { ok: true, payload };
}

export function stableJSONStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSONStringify).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJSONStringify(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Hex(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function packageContentFingerprint(sourcePackage) {
  return stableJSONStringify(sourcePackage);
}

function invalid(error) { return { ok: false, error }; }
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
