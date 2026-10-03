// Public intake uses byte bounds and short-lived, keyed network buckets. Never store raw IPs,
// caller-chosen device IDs, body text or the server secret in the admission ledger.
export const intakePolicy = Object.freeze({
  version: 1, windowSeconds: 60, ledgerWindowSeconds: 120,
  routes: {
    manual: { perSource: 30, global: 300, bodyBytes: 131072 },
    automatic: { perSource: 60, global: 300, bodyBytes: 131072 },
    analytics: { perSource: 120, global: 1000, bodyBytes: 65536 },
    contributions: { perSource: 20, global: 200, bodyBytes: 65536, daily: 1000 },
  },
});

export function intakeResponse(value, status, headers = {}) {
  return new Response(JSON.stringify(value), { status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

export async function readBoundedJSON(request, maximumBytes) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return intakeResponse({ error: 'Content-Type must be application/json' }, 415);
  }
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
    return intakeResponse({ error: 'Invalid Content-Length' }, 400);
  }
  if (Number(length) > maximumBytes) return intakeResponse({ error: 'Payload too large' }, 413);
  if (!request.body) return intakeResponse({ error: 'Invalid JSON' }, 400);
  const reader = request.body.getReader();
  const data = new Uint8Array(maximumBytes);
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maximumBytes - bytes) {
        try { await reader.cancel(); } catch {
          // Rejection remains valid even if the peer already closed the stream.
          console.warn(JSON.stringify({ event: 'intake.stream_cancel_failed' }));
        }
        return intakeResponse({ error: 'Payload too large' }, 413);
      }
      data.set(value, bytes);
      bytes += value.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, bytes)));
  } catch {
    return intakeResponse({ error: 'Invalid JSON or interrupted body' }, 400);
  } finally { reader.releaseLock(); }
}

const schemas = new WeakMap();
async function ensureIntakeSchema(db) {
  let promise = schemas.get(db);
  if (!promise) {
    promise = db.prepare(`CREATE TABLE IF NOT EXISTS intake_admissions (
      route TEXT NOT NULL, receipt TEXT NOT NULL, subject TEXT NOT NULL,
      bucket INTEGER NOT NULL, units INTEGER NOT NULL,
      PRIMARY KEY(route, bucket, receipt)
    )`).run();
    schemas.set(db, promise);
    promise.catch(() => { if (schemas.get(db) === promise) schemas.delete(db); });
  }
  await promise;
}

export async function expireIntake(db, now = Date.now()) {
  await ensureIntakeSchema(db);
  await db.prepare('DELETE FROM intake_admissions WHERE bucket < ?')
    .bind(Math.floor(now / 60000) - 1).run();
}

async function token(secret, value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const data = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(data), b => b.toString(16).padStart(2, '0')).join('');
}

export async function admitIntake({ request, env, db, route, receipt, units = 1, now = Date.now() }) {
  const policy = intakePolicy.routes[route];
  const secret = env.ANALYTICS_REPORT_TOKEN;
  if (!policy || typeof secret !== 'string' || !secret.trim() || !Number.isSafeInteger(now)
      || now < 0 || !Number.isSafeInteger(units) || units < 1 || typeof receipt !== 'string') {
    return intakeResponse({ error: 'Intake unavailable' }, 503, { 'retry-after': '60' });
  }
  try {
    const bucket = Math.floor(now / 60000);
    // CF-Connecting-IP is supplied by the trusted Cloudflare edge, never X-Forwarded-For.
    // Missing edge metadata shares a conservative bucket; it never disables admission limits.
    const source = request.headers.get('cf-connecting-ip') || 'unavailable';
    const subject = await token(secret, `intake-source-v1|${route}|${bucket}|${source}`);
    const key = await token(secret, `intake-receipt-v1|${route}|${bucket}|${receipt}`);
    await expireIntake(db, now);
    // SQLite executes this conditional insertion atomically. Duplicate receipts consume no units.
    await db.prepare(`INSERT OR IGNORE INTO intake_admissions(route, receipt, subject, bucket, units)
      SELECT ?, ?, ?, ?, ? WHERE
      (SELECT COALESCE(SUM(units),0) FROM intake_admissions WHERE route = ? AND bucket = ?) + ? <= ?
      AND (SELECT COALESCE(SUM(units),0) FROM intake_admissions WHERE route = ? AND bucket = ? AND subject = ?) + ? <= ?`)
      .bind(route, key, subject, bucket, units, route, bucket, units, policy.global,
        route, bucket, subject, units, policy.perSource).run();
    const admitted = await db.prepare('SELECT units FROM intake_admissions WHERE route = ? AND bucket = ? AND receipt = ?')
      .bind(route, bucket, key).first();
    if (admitted && Number(admitted.units) === units) return null;
    return intakeResponse({ error: 'Intake admission limit reached' }, 429,
      { 'retry-after': '60' });
  } catch {
    console.warn(JSON.stringify({ event: 'intake.storage_unavailable', route }));
    return intakeResponse({ error: 'Intake unavailable' }, 503, { 'retry-after': '60' });
  }
}
