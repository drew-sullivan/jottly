export const schemaVersion = 1;

export const allowedValues = Object.freeze({
  category: ["product", "reliability"],
  event: [
    "mode_selected", "game_started", "game_completed", "game_left",
    "invalid_word_rejected", "suggested_word_used", "rules_reopened",
    "secret_word_warning_shown", "secret_word_warning_proceeded",
    "notification_permission_accepted", "notification_permission_declined",
    "share_sheet_opened", "share_completed", "share_cancelled",
    "invite_opened", "invite_joined", "offline_fallback_entered",
    "sync_ultimately_failed", "home_cache_painted", "home_reconciled",
    "first_game_started", "first_valid_guess_submitted", "first_game_completed",
    "second_game_started", "first_friend_invited", "first_friend_game_completed",
    "first_rematch_started", "returned_next_day", "returned_next_week",
    "local_events_dropped",
  ],
  mode: ["lightning", "cowpoke", "classic", "mystery"],
  game_source: ["solo", "friend", "daily", "invitation", "rematch"],
  share_source: [
    "friend_invitation", "game_result", "daily_result", "streak",
    "monthly_best", "tell_a_friend", "problem_report", "other",
  ],
  share_channel: ["messages", "airdrop", "mail", "copy_link", "other"],
  turn_bucket: ["zero", "1_3", "4_6", "7_9", "10_plus"],
  duration_bucket: ["under_5m", "5_15m", "15_60m", "1_24h", "1_7d", "7d_plus"],
  outcome: ["won", "lost", "tied", "stumped", "forfeited"],
  performance_bucket: ["under_100ms", "100_250ms", "250ms_1s", "1_3s", "3s_plus"],
  reliability_reason: ["network", "cloudkit", "outbox"],
});

const requiredKeys = ["entry_id", "day", "category", "event", "app_version", "release_channel", "count"];
const optionalKeys = Object.keys(allowedValues).filter((key) => !["category", "event"].includes(key));
const entryKeys = new Set([...requiredKeys, ...optionalKeys]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const versionPattern = /^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/;
const releaseChannels = new Set(["appstore", "testflight", "debug"]);
const reliabilityEvents = new Set([
  "offline_fallback_entered", "sync_ultimately_failed", "home_cache_painted",
  "home_reconciled", "local_events_dropped",
]);
const dimensionsByEvent = Object.freeze({
  mode_selected: ["mode", "game_source"],
  game_started: ["mode", "game_source"],
  game_completed: ["mode", "game_source", "turn_bucket", "duration_bucket", "outcome"],
  game_left: ["mode", "game_source", "turn_bucket"],
  invalid_word_rejected: ["mode", "game_source"],
  suggested_word_used: ["mode", "game_source"],
  rules_reopened: ["mode", "game_source"],
  secret_word_warning_shown: ["mode", "game_source"],
  secret_word_warning_proceeded: ["mode", "game_source"],
  notification_permission_accepted: [],
  notification_permission_declined: [],
  share_sheet_opened: ["share_source"],
  share_completed: ["share_source", "share_channel"],
  share_cancelled: ["share_source"],
  invite_opened: ["game_source"],
  invite_joined: ["mode", "game_source"],
  offline_fallback_entered: ["reliability_reason"],
  sync_ultimately_failed: ["reliability_reason"],
  home_cache_painted: ["performance_bucket"],
  home_reconciled: ["performance_bucket"],
  first_game_started: [],
  first_valid_guess_submitted: ["mode", "game_source"],
  first_game_completed: [],
  second_game_started: [],
  first_friend_invited: [],
  first_friend_game_completed: ["mode", "game_source"],
  first_rematch_started: ["mode", "game_source"],
  returned_next_day: [],
  returned_next_week: [],
  local_events_dropped: [],
});
const requiredDimensionsByEvent = Object.freeze({
  mode_selected: ["mode", "game_source"],
  game_started: ["mode", "game_source"],
  game_completed: ["mode", "game_source", "turn_bucket", "duration_bucket", "outcome"],
  game_left: ["mode", "game_source", "turn_bucket"],
  invalid_word_rejected: ["mode", "game_source"],
  suggested_word_used: ["mode", "game_source"],
  rules_reopened: ["mode", "game_source"],
  secret_word_warning_shown: ["mode", "game_source"],
  secret_word_warning_proceeded: ["mode", "game_source"],
  share_sheet_opened: ["share_source"],
  share_completed: ["share_source", "share_channel"],
  share_cancelled: ["share_source"],
  invite_opened: ["game_source"],
  invite_joined: ["mode", "game_source"],
  offline_fallback_entered: ["reliability_reason"],
  sync_ultimately_failed: ["reliability_reason"],
  home_cache_painted: ["performance_bucket"],
  home_reconciled: ["performance_bucket"],
  first_valid_guess_submitted: ["mode", "game_source"],
  first_friend_game_completed: ["mode", "game_source"],
  first_rematch_started: ["mode", "game_source"],
});

export function validatePayload(payload, now = new Date()) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return failure("Payload must be an object");
  if (Object.keys(payload).some((key) => !["schemaVersion", "entries"].includes(key))) return failure("Unknown payload field");
  if (payload.schemaVersion !== schemaVersion) return failure("Unsupported schema version");
  if (!Array.isArray(payload.entries) || payload.entries.length < 1 || payload.entries.length > 64) {
    return failure("Entries must contain between 1 and 64 aggregates");
  }

  const earliest = new Date(now);
  earliest.setUTCDate(earliest.getUTCDate() - 45);
  const latest = new Date(now);
  latest.setUTCDate(latest.getUTCDate() + 2);
  const seen = new Set();

  for (const entry of payload.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return failure("Entry must be an object");
    if (Object.keys(entry).some((key) => !entryKeys.has(key))) return failure("Unknown entry field");
    if (requiredKeys.some((key) => !(key in entry))) return failure("Missing required entry field");
    if (!uuidPattern.test(entry.entry_id) || seen.has(entry.entry_id)) return failure("Invalid or repeated entry id");
    seen.add(entry.entry_id);
    if (!dayPattern.test(entry.day)) return failure("Invalid day");
    const day = new Date(`${entry.day}T00:00:00Z`);
    if (Number.isNaN(day.valueOf()) || day < startOfUTCDay(earliest) || day > startOfUTCDay(latest)) return failure("Day outside retention window");
    if (!versionPattern.test(entry.app_version)) return failure("Invalid app version");
    if (!releaseChannels.has(entry.release_channel)) return failure("Invalid release channel");
    if (!Number.isSafeInteger(entry.count) || entry.count < 1 || entry.count > 1000) return failure("Invalid aggregate count");

    for (const [key, values] of Object.entries(allowedValues)) {
      if (entry[key] !== undefined && !values.includes(entry[key])) return failure(`Invalid ${key}`);
    }
    const expectedCategory = reliabilityEvents.has(entry.event) ? "reliability" : "product";
    if (entry.category !== expectedCategory) return failure("Event category mismatch");
    const allowedDimensions = new Set(dimensionsByEvent[entry.event] ?? []);
    for (const key of optionalKeys) {
      if (entry[key] !== undefined && !allowedDimensions.has(key)) return failure(`Unexpected ${key}`);
    }
    for (const key of requiredDimensionsByEvent[entry.event] ?? []) {
      if (entry[key] === undefined) return failure(`Missing ${key}`);
    }
  }
  return { ok: true, entries: payload.entries };
}

function startOfUTCDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function failure(error) { return { ok: false, error }; }
