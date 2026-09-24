export const devReportSchemaSQL = `CREATE TABLE IF NOT EXISTS dev_reports (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('bug', 'feature')),
  description TEXT NOT NULL,
  diagnostics TEXT NOT NULL,
  app_version TEXT NOT NULL,
  build_number TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('new', 'in_progress', 'needs_info', 'fixed')),
  resolution TEXT
);`;

export const clearFixedDiagnosticsSQL = `UPDATE dev_reports SET diagnostics = ''
WHERE status = 'fixed' AND diagnostics != '';`;

export const addTitleSQL = `ALTER TABLE dev_reports ADD COLUMN title TEXT;`;

export const backfillTitleSQL = `UPDATE dev_reports
SET title = CASE
  WHEN length(trim(description)) <= 120 THEN trim(description)
  ELSE substr(trim(description), 1, 119) || '…'
END
WHERE title IS NULL OR trim(title) = '';`;

const schemaPromises = new WeakMap();

export async function ensureDevReportSchema(db) {
  let promise = schemaPromises.get(db);
  if (!promise) {
    promise = (async () => {
      await db.prepare(devReportSchemaSQL).run();
      const columns = await db.prepare("PRAGMA table_info(dev_reports)").all();
      if (!(columns.results ?? []).some((column) => column.name === "title")) {
        try {
          await db.prepare(addTitleSQL).run();
        } catch (error) {
          const refreshed = await db.prepare("PRAGMA table_info(dev_reports)").all();
          if (!(refreshed.results ?? []).some((column) => column.name === "title")) throw error;
        }
      }
      await db.prepare(backfillTitleSQL).run();
      await db.prepare(clearFixedDiagnosticsSQL).run();
    })();
    schemaPromises.set(db, promise);
    promise.catch(() => {
      if (schemaPromises.get(db) === promise) schemaPromises.delete(db);
    });
  }
  await promise;
}
