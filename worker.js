import { onRequestPost as receiveAnalytics } from "./functions/api/analytics/v1/events.js";
import { onRequestGet as reportAnalytics } from "./functions/api/analytics/v1/report.js";

const eventsPath = "/api/analytics/v1/events";
const reportPath = "/api/analytics/v1/report";

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

    if (path.startsWith("/api/")) {
      return json({ error: "Not found" }, 404);
    }

    return env.ASSETS.fetch(request);
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
