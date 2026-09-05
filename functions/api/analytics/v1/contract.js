export const schemaVersion = 1;

export const allowedValues = Object.freeze({
  category: ["product", "reliability"],
  event: [
    "first_open", "active_install_day", "active_install_week", "first_picker_opened",
    "game_picker_opened", "mode_selected", "game_start_requested", "game_ready", "game_start_failed",
    "game_created", "game_rule_created", "game_started", "game_rule_used", "game_rule_completed", "game_rule_left",
    "game_completed", "game_left", "game_terminated", "guess_submission_attempted",
    "move_submission_completed", "move_submission_failed", "invalid_word_rejected",
    "suggestions_shown", "suggestions_unavailable", "suggested_word_used", "suggested_word_submitted", "suggested_word_rejected",
    "rules_shown", "rules_dismissed", "rules_reopened", "rule_symbol_opened",
    "secret_word_warning_shown", "secret_word_warning_proceeded",
    "notification_permission_prompt_shown", "notification_permission_accepted", "notification_permission_declined",
    "notification_permission_failed", "notification_registration_succeeded", "notification_registration_failed",
    "notification_opened", "notification_route_succeeded", "notification_route_failed",
    "share_sheet_opened", "share_completed", "share_cancelled",
    "invite_created", "invite_opened", "invite_accepted", "invite_joined", "invite_visible",
    "invite_first_move_submitted", "invite_game_completed", "invite_failed",
    "remix_opened", "remix_template_selected", "remix_rule_edited", "remix_randomized",
    "remix_playtest_started", "remix_playtest_stopped", "remix_playtest_completed", "remix_kept",
    "shared_game_opened", "shared_game_saved", "shared_game_started", "shared_game_remixed", "shared_game_reshared",
    "offline_fallback_entered", "sync_operation_queued", "sync_recovered", "outbox_drained",
    "sync_ultimately_failed", "home_cache_painted", "home_reconciled",
    "first_game_started", "first_valid_guess_submitted", "first_game_completed",
    "second_game_started", "first_friend_invited", "first_friend_game_completed",
    "first_rematch_started", "returned_next_day", "returned_next_week",
    "local_events_dropped",
  ],
  mode: ["lightning", "cowpoke", "classic", "shapeshifter", "mystery", "custom"],
  game_source: ["solo", "friend", "daily", "invitation", "rematch"],
  game_kind: ["catalog", "remixed", "unlisted"],
  word_length: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "other"],
  rule_id: [
    "fixed_target", "shapeshifting_target", "membership_feedback", "position_feedback",
    "known_letter_hint", "known_position_hint", "guess_limit", "exact_word_wins",
    "shared_opener", "buy_hint", "last_chance_clue", "delayed_feedback", "clue_boost",
    "guaranteed_letter", "excluded_letters", "repeated_letters", "word_chain",
    "zero_match_strikes", "other",
  ],
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
  context: [
    "game_picker", "opening_suggestion", "nudge_suggestion", "secret_word_suggestion",
    "initial_rules", "rules_button", "score_symbol", "remix_editor", "remix_playtest",
    "shared_game", "invitation", "game_routing", "notification_permission",
    "notification_registration", "move", "identity", "analytics",
  ],
  reason: [
    "validation", "unsupported_contract", "network", "cloudkit", "routing", "registration",
    "user_cancelled", "user_left", "expired", "replaced", "invalidated", "local_removed", "conflict",
    "unavailable", "unknown",
  ],
});

const requiredKeys = ["entry_id", "day", "category", "event", "app_version", "release_channel", "count"];
const optionalKeys = [
  ...Object.keys(allowedValues).filter((key) => !["category", "event"].includes(key)),
  "install_cohort",
];
const entryKeys = new Set([...requiredKeys, ...optionalKeys]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const versionPattern = /^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/;
const releaseChannels = new Set(["appstore", "testflight", "debug"]);
const installCohortPattern = /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/;
const reliabilityEvents = new Set([
  "offline_fallback_entered", "sync_operation_queued", "sync_recovered", "outbox_drained",
  "sync_ultimately_failed", "home_cache_painted", "home_reconciled",
  "notification_permission_failed", "notification_registration_failed", "notification_route_failed",
  "move_submission_failed",
  "local_events_dropped",
]);
const dimensionsByEvent = Object.freeze({
  first_open: ["install_cohort"],
  active_install_day: ["install_cohort"],
  active_install_week: ["install_cohort"],
  first_picker_opened: ["game_source", "context", "install_cohort"],
  game_picker_opened: ["game_source", "context"],
  mode_selected: ["mode", "game_source"],
  game_start_requested: ["mode", "game_source", "game_kind", "word_length"],
  game_ready: ["mode", "game_source", "game_kind", "word_length", "performance_bucket"],
  game_start_failed: ["mode", "game_source", "game_kind", "word_length", "performance_bucket", "reason"],
  game_created: ["mode", "game_kind", "word_length"],
  game_rule_created: ["mode", "game_kind", "word_length", "rule_id"],
  game_started: ["mode", "game_source", "game_kind", "word_length"],
  game_rule_used: ["mode", "game_source", "game_kind", "word_length", "rule_id"],
  game_rule_completed: ["mode", "game_source", "game_kind", "word_length", "rule_id"],
  game_rule_left: ["mode", "game_source", "game_kind", "word_length", "rule_id"],
  game_completed: ["mode", "game_source", "game_kind", "word_length", "turn_bucket", "duration_bucket", "outcome"],
  game_left: ["mode", "game_source", "game_kind", "word_length", "turn_bucket"],
  game_terminated: ["mode", "game_source", "game_kind", "word_length", "turn_bucket", "reason"],
  guess_submission_attempted: ["mode", "game_source", "game_kind", "word_length", "context"],
  move_submission_completed: ["mode", "game_source", "game_kind", "word_length", "context", "performance_bucket"],
  move_submission_failed: ["mode", "game_source", "game_kind", "word_length", "context", "performance_bucket", "reason"],
  invalid_word_rejected: ["mode", "game_source", "game_kind", "word_length", "context", "reason"],
  suggestions_shown: ["mode", "game_source", "game_kind", "word_length", "context"],
  suggestions_unavailable: ["mode", "game_source", "game_kind", "word_length", "context"],
  suggested_word_used: ["mode", "game_source", "game_kind", "word_length", "context"],
  suggested_word_submitted: ["mode", "game_source", "game_kind", "word_length", "context"],
  suggested_word_rejected: ["mode", "game_source", "game_kind", "word_length", "context", "reason"],
  rules_shown: ["mode", "game_source", "game_kind", "word_length", "context"],
  rules_dismissed: ["mode", "game_source", "game_kind", "word_length", "context"],
  rules_reopened: ["mode", "game_source", "game_kind", "word_length", "context"],
  rule_symbol_opened: ["mode", "game_source", "game_kind", "word_length", "context"],
  secret_word_warning_shown: ["mode", "game_source"],
  secret_word_warning_proceeded: ["mode", "game_source"],
  notification_permission_prompt_shown: ["context"],
  notification_permission_accepted: [],
  notification_permission_declined: [],
  notification_permission_failed: ["context", "reason"],
  notification_registration_succeeded: ["context"],
  notification_registration_failed: ["context", "reason"],
  notification_opened: ["context"],
  notification_route_succeeded: ["context"],
  notification_route_failed: ["context", "reason"],
  share_sheet_opened: ["share_source"],
  share_completed: ["share_source", "share_channel"],
  share_cancelled: ["share_source"],
  invite_created: ["mode", "game_source", "game_kind", "word_length", "context"],
  invite_opened: ["game_source"],
  invite_accepted: ["mode", "game_source", "game_kind", "word_length", "context"],
  invite_joined: ["mode", "game_source", "game_kind", "word_length", "context", "performance_bucket"],
  invite_visible: ["mode", "game_source", "game_kind", "word_length", "context"],
  invite_first_move_submitted: ["mode", "game_source", "game_kind", "word_length", "context"],
  invite_game_completed: ["mode", "game_source", "game_kind", "word_length", "context"],
  invite_failed: ["mode", "game_source", "game_kind", "word_length", "context", "reason"],
  remix_opened: ["context"],
  remix_template_selected: ["mode", "game_kind", "word_length", "context"],
  remix_rule_edited: ["mode", "game_kind", "word_length", "context"],
  remix_randomized: ["mode", "game_kind", "word_length", "context"],
  remix_playtest_started: ["mode", "game_kind", "word_length", "context"],
  remix_playtest_stopped: ["mode", "game_kind", "word_length", "context"],
  remix_playtest_completed: ["mode", "game_kind", "word_length", "context"],
  remix_kept: ["mode", "game_kind", "word_length", "context"],
  shared_game_opened: ["mode", "game_kind", "word_length", "context"],
  shared_game_saved: ["mode", "game_kind", "word_length", "context"],
  shared_game_started: ["mode", "game_kind", "word_length", "context"],
  shared_game_remixed: ["mode", "game_kind", "word_length", "context"],
  shared_game_reshared: ["mode", "game_kind", "word_length", "context"],
  offline_fallback_entered: ["reliability_reason"],
  sync_operation_queued: ["game_source", "reliability_reason", "context", "reason"],
  sync_recovered: ["reliability_reason", "reason"],
  outbox_drained: ["performance_bucket", "reliability_reason", "context"],
  sync_ultimately_failed: ["reliability_reason"],
  home_cache_painted: ["performance_bucket"],
  home_reconciled: ["performance_bucket"],
  first_game_started: ["install_cohort"],
  first_valid_guess_submitted: ["mode", "game_source", "game_kind", "word_length", "install_cohort"],
  first_game_completed: ["install_cohort"],
  second_game_started: ["install_cohort"],
  first_friend_invited: ["install_cohort"],
  first_friend_game_completed: ["mode", "game_source", "game_kind", "word_length", "install_cohort"],
  first_rematch_started: ["mode", "game_source", "game_kind", "word_length", "install_cohort"],
  returned_next_day: ["install_cohort"],
  returned_next_week: ["install_cohort"],
  local_events_dropped: [],
});
const requiredDimensionsByEvent = Object.freeze({
  first_open: ["install_cohort"],
  active_install_day: ["install_cohort"],
  active_install_week: ["install_cohort"],
  first_picker_opened: ["game_source", "context", "install_cohort"],
  game_picker_opened: ["game_source", "context"],
  mode_selected: ["mode", "game_source"],
  game_start_requested: ["mode", "game_source"],
  game_ready: ["mode", "game_source", "performance_bucket"],
  game_start_failed: ["mode", "game_source", "performance_bucket", "reason"],
  game_created: ["mode", "game_kind", "word_length"],
  game_rule_created: ["mode", "game_kind", "word_length", "rule_id"],
  game_started: ["mode", "game_source"],
  game_rule_used: ["mode", "game_source", "game_kind", "word_length", "rule_id"],
  game_rule_completed: ["mode", "game_source", "game_kind", "word_length", "rule_id"],
  game_rule_left: ["mode", "game_source", "game_kind", "word_length", "rule_id"],
  game_completed: ["mode", "game_source", "turn_bucket", "duration_bucket", "outcome"],
  game_left: ["mode", "game_source", "turn_bucket"],
  game_terminated: ["mode", "game_source", "turn_bucket", "reason"],
  guess_submission_attempted: ["mode", "game_source", "context"],
  move_submission_completed: ["mode", "game_source", "context", "performance_bucket"],
  move_submission_failed: ["mode", "game_source", "context", "performance_bucket", "reason"],
  invalid_word_rejected: ["mode", "game_source"],
  suggestions_shown: ["mode", "game_source", "context"],
  suggestions_unavailable: ["mode", "game_source", "context"],
  suggested_word_used: ["mode", "game_source", "context"],
  suggested_word_submitted: ["mode", "game_source", "context"],
  suggested_word_rejected: ["mode", "game_source", "context", "reason"],
  rules_shown: ["mode", "game_source", "context"],
  rules_dismissed: ["mode", "game_source", "context"],
  rules_reopened: ["mode", "game_source", "context"],
  rule_symbol_opened: ["mode", "game_source", "context"],
  secret_word_warning_shown: ["mode", "game_source"],
  secret_word_warning_proceeded: ["mode", "game_source"],
  notification_permission_prompt_shown: ["context"],
  notification_permission_failed: ["context", "reason"],
  notification_registration_succeeded: ["context"],
  notification_registration_failed: ["context", "reason"],
  notification_opened: ["context"],
  notification_route_succeeded: ["context"],
  notification_route_failed: ["context", "reason"],
  share_sheet_opened: ["share_source"],
  share_completed: ["share_source", "share_channel"],
  share_cancelled: ["share_source"],
  invite_opened: ["game_source"],
  invite_created: ["mode", "game_source", "context"],
  invite_accepted: ["context"],
  invite_joined: ["mode", "game_source", "context"],
  invite_visible: ["context"],
  invite_first_move_submitted: ["mode", "game_source", "context"],
  invite_game_completed: ["mode", "game_source", "context"],
  invite_failed: ["context", "reason"],
  remix_opened: ["context"],
  remix_template_selected: ["mode", "game_kind", "word_length", "context"],
  remix_rule_edited: ["mode", "game_kind", "word_length", "context"],
  remix_randomized: ["mode", "game_kind", "word_length", "context"],
  remix_playtest_started: ["mode", "game_kind", "word_length", "context"],
  remix_playtest_stopped: ["mode", "game_kind", "word_length", "context"],
  remix_playtest_completed: ["mode", "game_kind", "word_length", "context"],
  remix_kept: ["mode", "game_kind", "word_length", "context"],
  shared_game_opened: ["mode", "game_kind", "word_length", "context"],
  shared_game_saved: ["mode", "game_kind", "word_length", "context"],
  shared_game_started: ["mode", "game_kind", "word_length", "context"],
  shared_game_remixed: ["mode", "game_kind", "word_length", "context"],
  shared_game_reshared: ["mode", "game_kind", "word_length", "context"],
  offline_fallback_entered: ["reliability_reason"],
  sync_operation_queued: ["game_source", "reliability_reason", "context", "reason"],
  sync_recovered: ["reliability_reason", "reason"],
  outbox_drained: ["performance_bucket", "reliability_reason", "context"],
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
    if (entry.install_cohort !== undefined && !installCohortPattern.test(entry.install_cohort)) {
      return failure("Invalid install_cohort");
    }
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
