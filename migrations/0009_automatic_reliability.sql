ALTER TABLE dev_reports ADD COLUMN automatic_summary TEXT;
CREATE TABLE IF NOT EXISTS automatic_report_receipts (
 id TEXT PRIMARY KEY, body_hash TEXT NOT NULL, group_id TEXT NOT NULL, incident_id TEXT,
 event TEXT NOT NULL, occurrences INTEGER NOT NULL, outcome TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL, metadata TEXT, title TEXT, description TEXT, app_version TEXT, build_number TEXT
);
CREATE INDEX IF NOT EXISTS automatic_report_receipts_time ON automatic_report_receipts(created_at_ms);
CREATE INDEX IF NOT EXISTS automatic_report_receipts_incident ON automatic_report_receipts(incident_id,event);
CREATE TRIGGER IF NOT EXISTS automatic_report_group_insert
AFTER INSERT ON automatic_report_receipts BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM dev_reports WHERE id = NEW.group_id AND automatic_summary IS NULL)
 THEN RAISE(ABORT,'Automatic group collides with manual report') END;
 INSERT OR IGNORE INTO dev_reports
 (id,kind,title,description,diagnostics,app_version,build_number,created_at_ms,updated_at_ms,status,automatic_summary)
 VALUES (NEW.group_id,'bug',NEW.title,NEW.description,NEW.metadata,NEW.app_version,NEW.build_number,
 NEW.created_at_ms,NEW.created_at_ms,'new',json_object('version',1,'fingerprint',json_extract(NEW.metadata,'$.fingerprint'),
 'operation',json_extract(NEW.metadata,'$.operation'),'signal',json_extract(NEW.metadata,'$.signal'),
 'reason',json_extract(NEW.metadata,'$.reason'),'thresholdMilliseconds',json_extract(NEW.metadata,'$.thresholdMilliseconds'),
 'occurrenceCount',0,'firstSeenMilliseconds',NEW.created_at_ms,'lastSeenMilliseconds',NEW.created_at_ms,'lastOutcome','pending'));
 UPDATE dev_reports SET
 status = CASE WHEN NEW.event != 'terminal' THEN CASE WHEN status = 'fixed' THEN 'new' ELSE status END ELSE status END,
 resolution = CASE WHEN NEW.event != 'terminal' AND status = 'fixed' THEN NULL ELSE resolution END,
 diagnostics = CASE WHEN status = 'fixed' AND NEW.event = 'terminal' THEN '' ELSE NEW.metadata END,
 updated_at_ms = NEW.created_at_ms,
 automatic_summary = json_set(automatic_summary,'$.lastSeenMilliseconds',NEW.created_at_ms,
 '$.occurrenceCount',MIN(1000000000,json_extract(automatic_summary,'$.occurrenceCount') + CASE
 WHEN NEW.event = 'terminal' THEN 0
 WHEN NEW.event = 'initial' AND EXISTS(SELECT 1 FROM automatic_report_receipts WHERE incident_id = NEW.incident_id AND event = 'initial' AND id != NEW.id) THEN 0
 ELSE NEW.occurrences END),
 '$.lastOutcome',COALESCE((SELECT outcome FROM automatic_report_receipts WHERE incident_id = NEW.incident_id AND event = 'terminal' ORDER BY created_at_ms DESC LIMIT 1),NEW.outcome))
 WHERE id = NEW.group_id;
END;
CREATE TRIGGER IF NOT EXISTS automatic_report_group_delete
AFTER DELETE ON dev_reports WHEN OLD.automatic_summary IS NOT NULL BEGIN
 UPDATE automatic_report_receipts SET metadata = NULL, incident_id = NULL, title = NULL,
 description = NULL, app_version = NULL, build_number = NULL WHERE group_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS automatic_report_group_fixed
AFTER UPDATE OF status ON dev_reports WHEN NEW.automatic_summary IS NOT NULL AND NEW.status = 'fixed' BEGIN
 UPDATE automatic_report_receipts SET metadata = NULL, incident_id = NULL, title = NULL,
 description = NULL, app_version = NULL, build_number = NULL WHERE group_id = NEW.id;
END;
