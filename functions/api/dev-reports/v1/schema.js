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

export const addSubmissionFingerprintSQL = `ALTER TABLE dev_reports ADD COLUMN submission_fingerprint TEXT;`;

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
      await ensureColumn(db, "title", addTitleSQL);
      await ensureColumn(db, "submission_fingerprint", addSubmissionFingerprintSQL);
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

async function ensureColumn(db, name, statement) {
  const columns = await db.prepare("PRAGMA table_info(dev_reports)").all();
  if ((columns.results ?? []).some((column) => column.name === name)) return;
  try {
    await db.prepare(statement).run();
  } catch (error) {
    // Another worker can race the same additive migration. Only an observed column
    // proves that the migration succeeded; storage failures remain retriable errors.
    const refreshed = await db.prepare("PRAGMA table_info(dev_reports)").all();
    if (!(refreshed.results ?? []).some((column) => column.name === name)) throw error;
  }
}
