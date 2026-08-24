export const analyticsSchemaSQL = `
CREATE TABLE IF NOT EXISTS anonymous_analytics_events (
  entry_id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  category TEXT NOT NULL,
  event TEXT NOT NULL,
  app_version TEXT NOT NULL,
  release_channel TEXT NOT NULL,
  mode TEXT,
  game_source TEXT,
  share_source TEXT,
  share_channel TEXT,
  turn_bucket TEXT,
  duration_bucket TEXT,
  outcome TEXT,
  performance_bucket TEXT,
  reliability_reason TEXT,
  aggregate_count INTEGER NOT NULL CHECK (aggregate_count BETWEEN 1 AND 1000)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS analytics_day_event ON anonymous_analytics_events(day, event);
`;

const schemaPromises = new WeakMap();

export async function ensureAnalyticsSchema(db) {
  let promise = schemaPromises.get(db);
  if (!promise) {
    promise = db.exec(analyticsSchemaSQL);
    schemaPromises.set(db, promise);
    promise.catch(() => {
      if (schemaPromises.get(db) === promise) schemaPromises.delete(db);
    });
  }
  await promise;
}
