import assert from "node:assert/strict";
import test from "node:test";
import {
  projectCommunityCatalogRun,
  runTrackedCommunitySweep,
} from "../functions/api/community/v1/operations.js";

const scheduledAtMilliseconds = Date.parse("2026-09-10T04:00:00Z");

test("tracked sweeps persist failures, alert once, and replay without repeating side effects", async () => {
  const db = new RunDB();
  const alerts = [];
  let sweepCount = 0;
  const input = {
    env: { COMMUNITY_DB: db },
    operationID: `scheduled:${scheduledAtMilliseconds}`,
    scheduledAtMilliseconds,
    startedAtMilliseconds: scheduledAtMilliseconds + 5,
    source: "scheduled",
    sweep: async () => {
      sweepCount += 1;
      const error = new Error("CloudKit unavailable");
      error.name = "CloudKitUnavailable";
      throw error;
    },
    alert: async (_env, alert) => alerts.push(alert),
  };

  const first = await runTrackedCommunitySweep(input);
  const replay = await runTrackedCommunitySweep(input);

  assert.equal(sweepCount, 1);
  assert.equal(alerts.length, 1);
  assert.equal(first.replayed, false);
  assert.equal(first.row.status, "failed");
  assert.equal(first.row.error_code, "CloudKitUnavailable");
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.row, first.row);
  assert.deepEqual(projectCommunityCatalogRun(first.row), {
    operationID: input.operationID,
    runStatus: "failed",
    scheduledAtUnixMilliseconds: scheduledAtMilliseconds,
    startedAtUnixMilliseconds: scheduledAtMilliseconds + 5,
    finishedAtUnixMilliseconds: first.row.finished_at_ms,
    replayed: false,
    status: "failed",
    errorCode: "CloudKitUnavailable",
  });
});

test("a claimed in-progress operation is observable and cannot run twice", async () => {
  const db = new RunDB();
  const operationID = "manual:in-progress";
  await db.insertRun({
    operationID,
    scheduledAtMilliseconds,
    startedAtMilliseconds: scheduledAtMilliseconds + 10,
  });
  let sweepCount = 0;

  const result = await runTrackedCommunitySweep({
    env: { COMMUNITY_DB: db },
    operationID,
    scheduledAtMilliseconds,
    source: "manual",
    sweep: async () => {
      sweepCount += 1;
      return {};
    },
  });

  assert.equal(sweepCount, 0);
  assert.equal(result.replayed, true);
  assert.deepEqual(projectCommunityCatalogRun(result.row, { replayed: true }), {
    operationID,
    runStatus: "in_progress",
    scheduledAtUnixMilliseconds: scheduledAtMilliseconds,
    startedAtUnixMilliseconds: scheduledAtMilliseconds + 10,
    finishedAtUnixMilliseconds: null,
    replayed: true,
    status: "in_progress",
  });
});

test("a missing operations database fails closed and emits a structured alert", async () => {
  const alerts = [];
  const result = await runTrackedCommunitySweep({
    env: {},
    operationID: "scheduled:no-db",
    scheduledAtMilliseconds,
    source: "scheduled",
    alert: async (_env, alert) => alerts.push(alert),
  });

  assert.equal(result.row.status, "failed");
  assert.equal(result.row.error_code, "community_db_unavailable");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].errorCode, "community_db_unavailable");
});

class RunDB {
  constructor() {
    this.runs = new Map();
  }

  async insertRun({ operationID, scheduledAtMilliseconds, startedAtMilliseconds }) {
    this.runs.set(operationID, {
      operation_id: operationID,
      scheduled_at_ms: scheduledAtMilliseconds,
      started_at_ms: startedAtMilliseconds,
      finished_at_ms: null,
      status: "in_progress",
      summary_json: null,
      error_code: null,
    });
  }

  prepare(sql) {
    return {
      run: async () => ({ meta: { changes: 0 } }),
      bind: (...values) => ({
        run: async () => {
          if (sql.includes("INSERT OR IGNORE INTO community_catalog_runs")) {
            const [operationID, scheduledAt, startedAt] = values;
            if (this.runs.has(operationID)) return { meta: { changes: 0 } };
            await this.insertRun({
              operationID,
              scheduledAtMilliseconds: scheduledAt,
              startedAtMilliseconds: startedAt,
            });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("status = 'succeeded'")) {
            const [finishedAt, summary, operationID] = values;
            Object.assign(this.runs.get(operationID), {
              finished_at_ms: finishedAt,
              status: "succeeded",
              summary_json: summary,
              error_code: null,
            });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("status = 'failed'")) {
            const [finishedAt, errorCode, operationID] = values;
            Object.assign(this.runs.get(operationID), {
              finished_at_ms: finishedAt,
              status: "failed",
              error_code: errorCode,
            });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        first: async () => this.runs.get(values[0]) ?? null,
      }),
    };
  }
}
