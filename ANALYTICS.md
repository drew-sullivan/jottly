# Anonymous product analytics

Jottly sends small, first-party aggregate counters to `/api/analytics/v1/events`. The contract rejects
unknown fields and has no player, device, game, opponent, word, name, or exact timestamp dimension.
Retry IDs deduplicate a durable client batch; they are random per aggregate row, not installation IDs.

## Cloudflare setup

1. Create a D1 database named `jottly-anonymous-analytics`.
2. Run `migrations/0001_anonymous_analytics.sql` against it.
3. Add a Pages D1 binding named `ANALYTICS_DB` for Preview and Production.
4. Add an encrypted Pages secret named `ANALYTICS_REPORT_TOKEN`.
5. Redeploy the Pages project.
6. Run `node --test tests/analytics-contract.test.mjs` locally.
7. POST a valid payload with `X-Jottly-Validate-Only: 1` to verify the deployed contract without writing.

Reports are available at `/api/analytics/v1/report?days=30` only with
`Authorization: Bearer <ANALYTICS_REPORT_TOKEN>`. The endpoint returns 404 without the secret.
