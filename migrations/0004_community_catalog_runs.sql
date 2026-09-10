CREATE TABLE IF NOT EXISTS community_catalog_runs (
  operation_id TEXT PRIMARY KEY,
  scheduled_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'succeeded', 'failed')),
  summary_json TEXT,
  error_code TEXT
);
