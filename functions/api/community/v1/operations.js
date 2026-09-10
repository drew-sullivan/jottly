import { notifyCommunityCatalogFailure } from "./alerts.js";
import {
  beginCommunityCatalogRun,
  completeCommunityCatalogRun,
  failCommunityCatalogRun,
  readCommunityCatalogRun,
} from "./schema.js";
import { runCommunitySweep } from "./sweep.js";

export async function runTrackedCommunitySweep({
  env,
  operationID,
  scheduledAtMilliseconds,
  startedAtMilliseconds = Date.now(),
  source,
  sweep = runCommunitySweep,
  alert = notifyCommunityCatalogFailure,
}) {
  if (!env.COMMUNITY_DB) {
    const occurredAtUnixMilliseconds = Date.now();
    const errorCode = "community_db_unavailable";
    await alert(env, { operationID, source, errorCode, occurredAtUnixMilliseconds });
    return {
      replayed: false,
      row: {
        operation_id: operationID,
        scheduled_at_ms: scheduledAtMilliseconds,
        started_at_ms: startedAtMilliseconds,
        finished_at_ms: occurredAtUnixMilliseconds,
        status: "failed",
        summary_json: null,
        error_code: errorCode,
      },
    };
  }
  let created;
  try {
    created = await beginCommunityCatalogRun(env.COMMUNITY_DB, {
      operationID,
      scheduledAtMilliseconds,
      startedAtMilliseconds,
    });
  } catch (error) {
    const occurredAtUnixMilliseconds = Date.now();
    const errorCode = stableErrorCode(error);
    await alert(env, { operationID, source, errorCode, occurredAtUnixMilliseconds });
    return {
      replayed: false,
      row: {
        operation_id: operationID,
        scheduled_at_ms: scheduledAtMilliseconds,
        started_at_ms: startedAtMilliseconds,
        finished_at_ms: occurredAtUnixMilliseconds,
        status: "failed",
        summary_json: null,
        error_code: errorCode,
      },
    };
  }
  if (!created) {
    return { replayed: true, row: await readCommunityCatalogRun(env.COMMUNITY_DB, operationID) };
  }

  try {
    const summary = await sweep({ env, asOfMilliseconds: scheduledAtMilliseconds });
    await completeCommunityCatalogRun(env.COMMUNITY_DB, {
      operationID,
      finishedAtMilliseconds: Date.now(),
      summary,
    });
    return {
      replayed: false,
      row: await readCommunityCatalogRun(env.COMMUNITY_DB, operationID),
    };
  } catch (error) {
    const errorCode = stableErrorCode(error);
    const occurredAtUnixMilliseconds = Date.now();
    await failCommunityCatalogRun(env.COMMUNITY_DB, {
      operationID,
      finishedAtMilliseconds: occurredAtUnixMilliseconds,
      errorCode,
    });
    await alert(env, { operationID, source, errorCode, occurredAtUnixMilliseconds });
    return {
      replayed: false,
      row: await readCommunityCatalogRun(env.COMMUNITY_DB, operationID),
    };
  }
}

export function projectCommunityCatalogRun(row, { replayed = false } = {}) {
  if (!row) return null;
  const result = {
    operationID: row.operation_id,
    runStatus: row.status,
    scheduledAtUnixMilliseconds: row.scheduled_at_ms,
    startedAtUnixMilliseconds: row.started_at_ms,
    finishedAtUnixMilliseconds: row.finished_at_ms ?? null,
    replayed,
  };
  if (row.status === "succeeded") {
    try {
      return { ...result, ...JSON.parse(row.summary_json) };
    } catch {
      return { ...result, runStatus: "failed", errorCode: "invalid_stored_summary" };
    }
  }
  if (row.status === "failed") return { ...result, status: "failed", errorCode: row.error_code };
  return { ...result, status: "in_progress" };
}

function stableErrorCode(error) {
  const name = typeof error?.name === "string" ? error.name : "Error";
  return name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "Error";
}
