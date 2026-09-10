export async function notifyCommunityCatalogFailure(env, failure, fetcher = fetch) {
  const event = {
    event: "community_catalog_alert",
    status: "failed",
    operationID: failure.operationID,
    source: failure.source,
    errorCode: failure.errorCode,
    occurredAtUnixMilliseconds: failure.occurredAtUnixMilliseconds,
  };
  console.error(JSON.stringify(event));

  const url = env.COMMUNITY_ALERT_WEBHOOK_URL;
  if (typeof url !== "string" || url.length === 0) return { delivered: false };
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    return { delivered: response.ok };
  } catch {
    return { delivered: false };
  }
}
