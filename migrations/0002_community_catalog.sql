CREATE TABLE IF NOT EXISTS community_catalog_current (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  generated_at_ms INTEGER NOT NULL,
  payload_sha256 TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
