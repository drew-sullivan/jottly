CREATE TABLE IF NOT EXISTS loved_game_candidates (
  submission_id TEXT PRIMARY KEY,
  definition_digest TEXT NOT NULL,
  contract_json TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS loved_game_candidates_digest ON loved_game_candidates(definition_digest);
