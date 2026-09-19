import { ensureAnalyticsSchema } from "./schema.js";
import { sha256Hex, stableJSONStringify } from "../../community/v1/contract.js";

const maximumBodyBytes = 64 * 1024;
const maximumDailySubmissions = 1_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^[0-9a-f]{64}$/;
const sharedOpenerID = "com.icedmatchalabs.jottly.modifier.shared-opening-guess";
const allowedComponentIDs = new Set([
  "com.icedmatchalabs.jottly.target.fixed-secret", "com.icedmatchalabs.jottly.target.adversarial-largest-family",
  "com.icedmatchalabs.jottly.feedback.membership", "com.icedmatchalabs.jottly.feedback.exact-position",
  "com.icedmatchalabs.jottly.hint.known-letter", "com.icedmatchalabs.jottly.hint.known-position",
  "com.icedmatchalabs.jottly.termination.guess-limit", "com.icedmatchalabs.jottly.termination.exact-word-wins",
  "com.icedmatchalabs.jottly.experience.type-track", "com.icedmatchalabs.jottly.experience.auto-deduction",
  "com.icedmatchalabs.jottly.experience.word-suggestions", "com.icedmatchalabs.jottly.experience.dictionary-words",
  "com.icedmatchalabs.jottly.policy.player-tools", sharedOpenerID,
  "com.icedmatchalabs.jottly.modifier.buy-hint", "com.icedmatchalabs.jottly.modifier.last-chance-clue",
  "com.icedmatchalabs.jottly.modifier.feedback-delay", "com.icedmatchalabs.jottly.modifier.feedback-retention",
  "com.icedmatchalabs.jottly.modifier.clue-boost", "com.icedmatchalabs.jottly.modifier.must-use-letter",
  "com.icedmatchalabs.jottly.modifier.fixed-position-letter", "com.icedmatchalabs.jottly.modifier.poison-letter",
  "com.icedmatchalabs.jottly.modifier.available-letters", "com.icedmatchalabs.jottly.modifier.duplicate-pattern",
  "com.icedmatchalabs.jottly.modifier.word-chain", "com.icedmatchalabs.jottly.termination.zero-match-strikes",
]);
const allowedConfigurationKeys = new Set([
  "requiresPositiveOpeningMatch", "disclosure", "includesExactPositions", "scoring", "count", "enabled",
  "maximumUses", "remainingGuesses", "turns", "latestScores", "mode", "letter", "letters", "position",
  "pattern", "minimumSharedLetters", "typeTrackEnabled", "autoDeductionEnabled", "wordSuggestionsEnabled",
  "dictionaryWordsOnly",
]);

export async function onRequestPost(context) {
  const request = context.request;
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "Expected application/json" }, 415);
  if (Number(request.headers.get("content-length") || 0) > maximumBodyBytes) return json({ error: "Payload too large" }, 413);
  let raw;
  try { raw = await request.text(); } catch { return json({ error: "Invalid request body" }, 400); }
  if (new TextEncoder().encode(raw).byteLength > maximumBodyBytes) return json({ error: "Payload too large" }, 413);
  let payload;
  try { payload = JSON.parse(raw); } catch { return json({ error: "Invalid JSON" }, 400); }
  const validation = await validateLovedGameCandidate(payload);
  if (!validation.ok) return json({ error: validation.error }, 400);
  if (request.headers.get("x-jottly-validate-only") === "1") return json({ accepted: 1 }, 200);
  if (!context.env.ANALYTICS_DB) return json({ error: "Analytics unavailable" }, 503);
  await ensureAnalyticsSchema(context.env.ANALYTICS_DB);
  const daily = await context.env.ANALYTICS_DB.prepare("SELECT COUNT(*) AS count FROM loved_game_candidates WHERE received_at >= date('now')").first();
  if (Number(daily?.count ?? 0) >= maximumDailySubmissions) return json({ error: "Daily intake full" }, 429);
  const result = await context.env.ANALYTICS_DB.prepare("INSERT OR IGNORE INTO loved_game_candidates (submission_id, definition_digest, contract_json) VALUES (?, ?, ?)")
    .bind(payload.submissionID, payload.contract.definitionDigest, validation.canonicalContract).run();
  return json({ accepted: 1, inserted: Number(result?.meta?.changes ?? 0) }, 200);
}

export async function validateLovedGameCandidate(payload) {
  if (!hasExactKeys(payload, ["schemaVersion", "submissionID", "contract"]) || payload.schemaVersion !== 1 || !uuidPattern.test(payload.submissionID ?? "")) return invalid("Invalid submission envelope");
  const contract = payload.contract;
  if (!hasExactKeys(contract, ["protocolVersion", "definition", "definitionDigest"]) || contract.protocolVersion !== 1 || !digestPattern.test(contract.definitionDigest ?? "")) return invalid("Invalid game contract");
  if (!validateDefinition(contract.definition)) return invalid("Invalid game definition");
  const canonicalDefinition = stableJSONStringify(contract.definition);
  if (await sha256Hex(canonicalDefinition) !== contract.definitionDigest) return invalid("Definition digest mismatch");
  return { ok: true, canonicalContract: stableJSONStringify(contract) };
}

function validateDefinition(definition) {
  const required = ["schemaVersion", "word", "match", "target", "feedback", "startingHints", "guessTransformations", "termination"];
  if (!hasOnlyKeys(definition, [...required, "playerExperience"]) || !required.every((key) => key in definition) || definition.schemaVersion !== 1) return false;
  if (!hasExactKeys(definition.word, ["length", "allowsDuplicates", "lexicon"]) || !Number.isSafeInteger(definition.word.length) || definition.word.length < 1 || definition.word.length > 10_000 || typeof definition.word.allowsDuplicates !== "boolean") return false;
  if (!hasOnlyKeys(definition.word.lexicon, ["id", "version", "contentDigest"])
      || !("id" in definition.word.lexicon)
      || !("version" in definition.word.lexicon)
      || !/^com\.icedmatchalabs\.jottly\.[a-z0-9.-]{1,80}$/.test(definition.word.lexicon.id ?? "")
      || !Number.isSafeInteger(definition.word.lexicon.version)
      || (definition.word.lexicon.contentDigest !== undefined
        && !digestPattern.test(definition.word.lexicon.contentDigest))) return false;
  if (!hasExactKeys(definition.match, ["kind", "grantsFinalEqualizer"]) || definition.match.kind !== "solo" || typeof definition.match.grantsFinalEqualizer !== "boolean") return false;
  return validateComponent(definition.target) && ["feedback", "startingHints", "guessTransformations", "playerExperience", "termination"].every((key) => validateComponents(definition[key] ?? []));
}

function validateComponents(components) { return Array.isArray(components) && components.length <= 64 && components.every(validateComponent); }
function validateComponent(component) {
  if (!hasExactKeys(component, ["typeID", "version", "configuration"]) || !allowedComponentIDs.has(component.typeID) || !Number.isSafeInteger(component.version) || component.version < 1 || component.version > 10 || !isPlainObject(component.configuration) || Object.keys(component.configuration).length > 16) return false;
  if (component.typeID === sharedOpenerID && (component.version !== 2 || Object.keys(component.configuration).length !== 0)) return false;
  return Object.entries(component.configuration).every(([key, value]) => allowedConfigurationKeys.has(key) && validateConfigurationValue(value));
}
function validateConfigurationValue(value) {
  if (typeof value === "boolean") return true;
  if (Number.isSafeInteger(value)) return Math.abs(value) <= 10_000;
  return typeof value === "string" && value.length <= 26 && /^[a-zA-Z_-]*$/.test(value);
}
function hasExactKeys(value, keys) { return hasOnlyKeys(value, keys) && Object.keys(value).length === keys.length; }
function hasOnlyKeys(value, keys) { return isPlainObject(value) && Object.keys(value).every((key) => keys.includes(key)); }
function isPlainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function invalid(error) { return { ok: false, error }; }
function json(value, status) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
