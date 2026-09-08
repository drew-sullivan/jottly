# Popular Community Games Operations

The public catalog is a daily, last-known-good projection of reviewed game packages completed in
human-versus-human CloudKit games. It never stores match records, player identifiers, guesses, or
secret words in D1.

## Production Enablement

1. Create a dedicated D1 database and attach it as `COMMUNITY_DB`.
2. Apply `migrations/0002_community_catalog.sql` to `COMMUNITY_DB` and
   `migrations/0003_community_analytics.sql` to `ANALYTICS_DB`.
3. Verify the production `JottoGameState` system field `___modTime` is queryable and sortable. The
   Web Services request addresses that index as `systemFieldName: "modifiedTimestamp"`.
4. Add `CLOUDKIT_KEY_ID` and `CLOUDKIT_PRIVATE_KEY_PKCS8_BASE64` with `wrangler secret put`.
5. Commit at least six reviewed packages to `community/featured-games-v1.js`.
6. Add every featured or organically eligible package ID and canonical Solo digest to
   `community/allowlist-v1.js`.
7. Exercise the scheduled handler against development CloudKit, then perform a production dry run.
8. Verify `GET /api/community/v1/games`, its ETag/304 behavior, and the TestFlight cache before
   enabling the production cron.

## Runtime Controls and SLOs

- `COMMUNITY_CATALOG_ENABLED=false` is the immediate kill switch. Clients remove the public
  snapshot and continue showing built-in and saved games.
- `COMMUNITY_CATALOG_ROLLOUT_PERCENTAGE` accepts `0...100`. The app sends a stable anonymous
  install bucket, so rollout membership does not flap across launches.
- `GET /api/community/v1/health` returns `200` only while a valid snapshot is newer than
  `COMMUNITY_CATALOG_STALE_AFTER_HOURS` (36 by default). Alert on any non-200 response, a failed
  scheduled sweep, fewer than six published entries, or two consecutive stale snapshots.
- Roll forward in stages (10, 25, 50, 100 percent). Roll back by setting the percentage to zero;
  reserve the kill switch for disabling and clearing the feature outright.

The sweep logs named rejection counts and aggregate pipeline metrics only. It never logs player
identifiers, words, guesses, or full package payloads.

## Contract Evolution

`community/catalog-contract-v1.json` is the machine-readable source of truth for the public DTO.
Run `node scripts/generate-community-contract.mjs` after editing it; the ordinary contract tests fail
if the generated module drifts. A Swift-authored golden package is decoded by both repositories so
changes in Codable shape cannot silently break publication.

The current CloudKit reader decodes the bounded `stateData` blob for backwards compatibility. The
next schema migration should add a minimal versioned completion projection containing only package
identity, canonical digest, result eligibility, anonymous pair key material, and completion time.
The Worker must dual-read and compare both projections before switching queries to the new fields.

The ordinary web suite uses only deterministic fakes. Two opt-in checks exercise deployment seams:

```bash
RUN_LIVE_COMMUNITY_ENDPOINT_TESTS=1 node --test tests/community-live.test.mjs
RUN_LIVE_COMMUNITY_CLOUDKIT_TESTS=1 \
COMMUNITY_DEV_CLOUDKIT_ENVIRONMENT=development \
COMMUNITY_DEV_CLOUDKIT_KEY_ID=... \
COMMUNITY_DEV_CLOUDKIT_PRIVATE_KEY_PKCS8_BASE64=... \
node --test tests/community-live.test.mjs

RUN_LIVE_COMMUNITY_E2E_TESTS=1 \
COMMUNITY_DEV_CLOUDKIT_ENVIRONMENT=development \
COMMUNITY_DEV_CLOUDKIT_KEY_ID=... \
COMMUNITY_DEV_CLOUDKIT_PRIVATE_KEY_PKCS8_BASE64=... \
COMMUNITY_DEV_E2E_PACKAGE_BASE64=... \
node --test tests/community-live.test.mjs
```

The signed CloudKit check refuses to run against production and queries only the final minute of the
development database.
The end-to-end variant additionally requires the exact Swift-encoded package from a reviewed,
completed development game. It performs the real signed query, projects that completion, builds a
snapshot in memory, and validates the same DTO consumed by iOS. It cannot publish to production D1.

Until the reviewed featured pool and exact allowlist are populated, scheduled sweeps fail closed and
the endpoint returns `503` rather than inventing community content.

## Key Rotation

Install and test the replacement CloudKit server key in development, update both Worker secrets in
one deployment, verify a signed query, and only then revoke the prior key in CloudKit Console. Never
commit either private key or log signature material.
