import { onRequestPost as receiveAnalytics } from "./functions/api/analytics/v1/events.js";
import { onRequestGet as reportAnalytics } from "./functions/api/analytics/v1/report.js";
import { onRequestGet as readCommunityCatalog } from "./functions/api/community/v1/catalog.js";
import { onRequestGet as readCommunityHealth } from "./functions/api/community/v1/health.js";
import {
  onRequestGet as readCommunitySweepStatus,
  onRequestPost as runCommunitySweepNow,
} from "./functions/api/community/v1/admin.js";
import { projectCommunityCatalogRun, runTrackedCommunitySweep } from "./functions/api/community/v1/operations.js";

const eventsPath = "/api/analytics/v1/events";
const reportPath = "/api/analytics/v1/report";
const communityCatalogPath = "/api/community/v1/games";
const communityHealthPath = "/api/community/v1/health";
const communitySweepPath = "/api/community/v1/admin/sweep";

export default {
  async fetch(request, env, executionContext) {
    const path = new URL(request.url).pathname;

    if (path === eventsPath) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return receiveAnalytics({ request, env, executionContext });
    }

    if (path === reportPath) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return reportAnalytics({ request, env, executionContext });
    }

    if (path === communityCatalogPath) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return readCommunityCatalog({ request, env, executionContext });
    }

    if (path === communityHealthPath) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return readCommunityHealth({ request, env, executionContext });
    }

    if (path === communitySweepPath) {
      if (request.method === "GET") {
        return readCommunitySweepStatus({ request, env, executionContext });
      }
      if (request.method === "POST") {
        return runCommunitySweepNow({ request, env, executionContext });
      }
      return methodNotAllowed("GET, POST");
    }

    if (path.startsWith("/api/")) {
      return json({ error: "Not found" }, 404);
    }

    return env.ASSETS.fetch(request);
  },

  scheduled(controller, env, ctx) {
    const operationID = `scheduled:${controller.scheduledTime}`;
    ctx.waitUntil(runTrackedCommunitySweep({
      env,
      operationID,
      scheduledAtMilliseconds: controller.scheduledTime,
      source: "scheduled",
    }).then(({ row, replayed }) => {
      const result = projectCommunityCatalogRun(row, { replayed });
      console.log(JSON.stringify({ event: "community_catalog_sweep", ...result }));
      if (result.runStatus === "failed") throw new Error("Community catalog sweep failed");
    }));
  },
};

function methodNotAllowed(method) {
  return new Response("Method not allowed", {
    status: 405,
    headers: { allow: method, "cache-control": "no-store" },
  });
}

function json(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
