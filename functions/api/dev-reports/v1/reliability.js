// Strict v1 reliability vocabulary. Automatic payloads never accept the manual-report free-text log.
const operations = new Set(['home.ready','game.open','turn.submit','share.prepare','invitation.resolve','customGame.save','presented.error','data.integrity']);
const signals = new Set(['slow','stalled','error','integrity']);
const outcomes = new Set(['pending','succeeded','failed','cancelled']);
const phases = new Set(['started','preparing','resolving','persisting','routing','ready']);
const reasons = new Set(['none','malformedRecord','writeVerificationFailed','unreadableStorage','cloudKitGameRecord','cloudKitInvitationQuery',
  'invalidWord','duplicateGuess','ruleRequirement','syncUnavailable','remoteChangeConflict','gameUnavailable','invitationUnavailable',
  'invitationMismatch','ownInvitation','updateRequired','invalidGameRules','persistenceFailed','routingFailed','unexpected']);
const eventFields = {
  'gameLaunch.started': ['phase'], 'gameLaunch.phase.completed': ['phase','durationMs','budgetMs'],
  'gameLaunch.completed': ['durationMs','budgetMs'], 'gameLaunch.failed': ['errorCode'],
  'library.load.cache': ['durationMs','budgetMs'], 'network.changed': ['online','networkAvailable','cloudKitAvailable'],
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const numberVersion = /^(?:[0-9.]{1,40}|unknown)$/;
const plain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => plain(x) && Object.keys(x).sort().join('|') === [...keys].sort().join('|');
const integer = (x, min, max) => Number.isSafeInteger(x) && x >= min && x <= max;
const metadataKeys = ['version','incidentID','fingerprint','operation','signal','event','outcome','phase','reason',
  'elapsedMilliseconds','thresholdMilliseconds','occurrences','network','commit','channel','environment','os','device','context','truncated'];

export async function validateAutomaticReport(body) {
  if (!exact(body,['schemaVersion','id','kind','title','description','diagnostics','appVersion','buildNumber','automatic'])
      || body.schemaVersion !== 1 || !uuid.test(body.id) || body.kind !== 'bug'
      || body.diagnostics !== '' || !numberVersion.test(body.appVersion) || !numberVersion.test(body.buildNumber)
      || typeof body.title !== 'string' || typeof body.description !== 'string'
      || new TextEncoder().encode(JSON.stringify(body)).length > 32768) return false;
  const m = body.automatic;
  if (!exact(m,metadataKeys) || m.version !== 1 || !uuid.test(m.incidentID) || !hash.test(m.fingerprint)
      || !operations.has(m.operation) || !signals.has(m.signal) || !outcomes.has(m.outcome) || !phases.has(m.phase)
      || !reasons.has(m.reason) || !['initial','terminal','aggregate'].includes(m.event)
      || !integer(m.elapsedMilliseconds,0,86400000) || !integer(m.thresholdMilliseconds,0,15000)
      || !integer(m.occurrences,m.event === 'terminal' ? 0 : 1,m.event === 'terminal' ? 0 : m.event === 'initial' ? 1 : 1000000000)
      || !['online','offline','unknown'].includes(m.network)
      || !/^(?:[0-9a-f]{40}|unknown)$/.test(m.commit) || !['debug','testflight','appstore','unknown'].includes(m.channel)
      || !['production','development','unknown'].includes(m.environment) || !numberVersion.test(m.os)
      || !['iPhone','iPad','iPod touch','unknown'].includes(m.device) || typeof m.truncated !== 'boolean'
      || !Array.isArray(m.context) || m.context.length > 50) return false;
  for (const entry of m.context) {
    if (!exact(entry,['event','millisecondsAgo','fields']) || !Object.hasOwn(eventFields,entry.event)
        || !integer(entry.millisecondsAgo,0,30000) || !plain(entry.fields)) return false;
    for (const [key,value] of Object.entries(entry.fields)) {
      if (!eventFields[entry.event].includes(key) || typeof value !== 'string') return false;
      if (key === 'phase' ? !phases.has(value) : key === 'errorCode' ? !reasons.has(value)
        : ['online','networkAvailable','cloudKitAvailable'].includes(key) ? !['true','false'].includes(value)
          : !/^(?:0|[1-9][0-9]{0,7})$/.test(value) || Number(value) > 86400000) return false;
    }
  }
  const fingerprint = await sha256(['1',body.appVersion,body.buildNumber,m.commit,m.channel,m.environment,m.operation,m.signal,m.reason].join('|'));
  return fingerprint === m.fingerprint && body.title === automaticTitle(m) && body.description === automaticDescription(m);
}
const titles = {'home.ready':'Loading Home','game.open':'Opening a game','turn.submit':'Submitting a turn',
  'share.prepare':'Preparing a game share','invitation.resolve':'Opening an invitation','customGame.save':'Saving a custom game',
  'presented.error':'An on-screen action','data.integrity':'Reading or saving game data'};
export const automaticTitle = (m) => `Automatic ${m.signal}: ${titles[m.operation]}`;
export const automaticDescription = (m) => `Automatic reliability [${m.signal}]: ${titles[m.operation]}. Active wait: ${m.elapsedMilliseconds} ms; limit: ${m.thresholdMilliseconds} ms. Phase: ${m.phase}. Outcome: ${m.outcome}. Reason: ${m.reason}. Network: ${m.network}.`;
export async function sha256(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))), x => x.toString(16).padStart(2,'0')).join('');
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(k => [k,canonical(value[k])]));
  return value;
}
function groupID(fingerprint) {
  return `${fingerprint.slice(0,8)}-${fingerprint.slice(8,12)}-4${fingerprint.slice(13,16)}-8${fingerprint.slice(17,20)}-${fingerprint.slice(20,32)}`;
}

export const reliabilityTableSQL = `CREATE TABLE IF NOT EXISTS automatic_report_receipts (
 id TEXT PRIMARY KEY, body_hash TEXT NOT NULL, group_id TEXT NOT NULL, incident_id TEXT,
 event TEXT NOT NULL, occurrences INTEGER NOT NULL, outcome TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL, metadata TEXT, title TEXT, description TEXT, app_version TEXT, build_number TEXT
);`;
export const reliabilityIndexSQL = `CREATE INDEX IF NOT EXISTS automatic_report_receipts_time ON automatic_report_receipts(created_at_ms);`;
export const reliabilityIncidentIndexSQL = `CREATE INDEX IF NOT EXISTS automatic_report_receipts_incident ON automatic_report_receipts(incident_id,event);`;
// SQLite triggers run in the INSERT's transaction. Duplicate submission IDs never run this trigger.
export const reliabilityTriggerSQL = `CREATE TRIGGER IF NOT EXISTS automatic_report_group_insert
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
END;`;

export async function receiveAutomatic(body, db, now) {
  const digest = await sha256(JSON.stringify(canonical(body)));
  const m = body.automatic;
  // A global admission ceiling protects the public endpoint without retaining client/IP identifiers.
  const inserted = await db.prepare(`INSERT OR IGNORE INTO automatic_report_receipts
    (id,body_hash,group_id,incident_id,event,occurrences,outcome,created_at_ms,metadata,title,description,app_version,build_number)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM automatic_report_receipts WHERE created_at_ms > ?) < 300`)
    .bind(body.id,digest,groupID(m.fingerprint),m.incidentID,m.event,m.occurrences,m.outcome,now,JSON.stringify(m),
      body.title,body.description,body.appVersion,body.buildNumber,now-60000).run();
  const receipt = await db.prepare('SELECT id,body_hash,group_id FROM automatic_report_receipts WHERE id = ?').bind(body.id).first();
  if (!receipt) return response({error:'Automatic report admission limit reached'},429,{'retry-after':'60'});
  if (receipt.body_hash !== digest) return response({error:'Report ID already belongs to a different submission'},409);
  const report = await db.prepare('SELECT status FROM dev_reports WHERE id = ?').bind(receipt.group_id).first();
  return response({id:body.id,status:report?.status ?? 'fixed',groupID:receipt.group_id},Number(inserted?.meta?.changes ?? 0) === 1 ? 201 : 200);
}

export async function expireAutomaticDiagnostics(db, now = Date.now()) {
  const before = now - 30*24*60*60*1000;
  await db.prepare(`UPDATE dev_reports SET diagnostics = '' WHERE automatic_summary IS NOT NULL
    AND (updated_at_ms <= ? OR status = 'fixed') AND diagnostics != ''`).bind(before).run();
  // Keep immutable digest receipts for idempotent late retries, but no incident/context detail.
  await db.prepare(`UPDATE automatic_report_receipts SET metadata = NULL, incident_id = NULL, title = NULL,
    description = NULL, app_version = NULL, build_number = NULL WHERE metadata IS NOT NULL AND (created_at_ms <= ? OR group_id IN
    (SELECT id FROM dev_reports WHERE status = 'fixed'))`).bind(before).run();
}
function response(body,status,extra={}) {
  return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...extra}});
}

export const reliabilityDeleteTriggerSQL = `CREATE TRIGGER IF NOT EXISTS automatic_report_group_delete
AFTER DELETE ON dev_reports WHEN OLD.automatic_summary IS NOT NULL BEGIN
 UPDATE automatic_report_receipts SET metadata = NULL, incident_id = NULL, title = NULL,
 description = NULL, app_version = NULL, build_number = NULL WHERE group_id = OLD.id;
END;`;

export const reliabilityFixedTriggerSQL = `CREATE TRIGGER IF NOT EXISTS automatic_report_group_fixed
AFTER UPDATE OF status ON dev_reports WHEN NEW.automatic_summary IS NOT NULL AND NEW.status = 'fixed' BEGIN
 UPDATE automatic_report_receipts SET metadata = NULL, incident_id = NULL, title = NULL,
 description = NULL, app_version = NULL, build_number = NULL WHERE group_id = NEW.id;
END;`;
