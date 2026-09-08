CREATE TABLE IF NOT EXISTS anonymous_analytics_events_v5 (
  entry_id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  category TEXT NOT NULL,
  event TEXT NOT NULL,
  app_version TEXT NOT NULL,
  release_channel TEXT NOT NULL,
  mode TEXT,
  game_source TEXT,
  game_kind TEXT,
  word_length TEXT,
  rule_id TEXT,
  share_source TEXT,
  share_channel TEXT,
  turn_bucket TEXT,
  duration_bucket TEXT,
  outcome TEXT,
  performance_bucket TEXT,
  reliability_reason TEXT,
  community_selection_source TEXT,
  context TEXT,
  reason TEXT,
  install_cohort TEXT,
  aggregate_count INTEGER NOT NULL CHECK (aggregate_count BETWEEN 1 AND 1000)
) WITHOUT ROWID;

INSERT OR IGNORE INTO anonymous_analytics_events_v5 (
  entry_id, day, category, event, app_version, release_channel, mode, game_source,
  game_kind, word_length, rule_id, share_source, share_channel, turn_bucket,
  duration_bucket, outcome, performance_bucket, reliability_reason, context, reason,
  install_cohort, aggregate_count
)
SELECT entry_id, day, category, event, app_version, release_channel, mode, game_source,
       game_kind, word_length, rule_id, share_source, share_channel, turn_bucket,
       duration_bucket, outcome, performance_bucket, reliability_reason, context, reason,
       install_cohort, aggregate_count
FROM anonymous_analytics_events_v4;

CREATE INDEX IF NOT EXISTS analytics_v5_day_event ON anonymous_analytics_events_v5(day, event);
