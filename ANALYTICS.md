# Anonymous product analytics

Jottly sends small, first-party aggregate counters to `/api/analytics/v1/events`. The contract rejects
unknown fields and has no player, device, game, opponent, word, name, or exact timestamp dimension.
Retry IDs deduplicate a durable client batch; they are random per aggregate row, not installation IDs.

## Cloudflare deployment

`wrangler.jsonc` is the deployment source of truth. Cloudflare Workers Builds deploys the static site,
routes only `/api/*` through `worker.js`, and automatically provisions the `ANALYTICS_DB` D1 binding.
The first authorized database request runs the idempotent schema in
`functions/api/analytics/v1/schema.js`; a source-guard test keeps it identical to the SQL migration.

Run `node --test tests/*.test.mjs` locally. Set `RUN_LIVE_ANALYTICS_TESTS=1` to prove production writes,
retry deduplication, identifying-field rejection, and report privacy after a deployment.

Reports are available at `/api/analytics/v1/report?days=30` only with
`Authorization: Bearer <ANALYTICS_REPORT_TOKEN>`. The endpoint returns 404 without the secret.
The write path does not require this secret; reports remain disabled until it is configured.
