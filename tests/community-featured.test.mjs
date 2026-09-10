import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { communityAllowlist } from "../community/allowlist-v1.js";
import { featuredCommunityPackages } from "../community/featured-games-v1.js";
import {
  buildFeaturedCommunityAllowlist,
  buildFeaturedCommunityPackages,
  featuredCommunityGameSpecs,
} from "../scripts/featured-community-game-generator.mjs";
import {
  validateCommunityAllowlist,
  validateFeaturedPackages,
} from "../functions/api/community/v1/contract.js";
import { onRequestGet as getCommunityCatalog } from "../functions/api/community/v1/catalog.js";
import { publishCommunityCatalog } from "../functions/api/community/v1/schema.js";
import { runCommunitySweep } from "../functions/api/community/v1/sweep.js";

const featuredCatalogArtifactDigest = "91472e6d14a12ae72cbec7f01f9e9f1cde86fee46b49781a4d568fbe79d2e9fd";

test("the app and website consume the same featured catalog artifact", async () => {
  const fixture = await readFile(
    new URL("./fixtures/featured-community-packages-v1.json", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(fixture).digest("hex"),
    featuredCatalogArtifactDigest,
  );
});

test("checked-in JotBot originals exactly match the deterministic generator", async () => {
  const generated = buildFeaturedCommunityPackages();
  const fixture = JSON.parse(await readFile(
    new URL("./fixtures/featured-community-packages-v1.json", import.meta.url),
    "utf8",
  ));

  assert.deepEqual(featuredCommunityPackages, generated);
  assert.deepEqual(communityAllowlist, buildFeaturedCommunityAllowlist(generated));
  assert.deepEqual(fixture, generated);
});

test("the five reviewed originals are valid, allowlisted, unique, and attributed to JotBot", () => {
  const allowlist = validateCommunityAllowlist(communityAllowlist);
  assert.equal(allowlist.ok, true);
  assert.equal(validateFeaturedPackages(
    featuredCommunityPackages,
    allowlist.values,
    5,
  ).ok, true);
  assert.deepEqual(
    featuredCommunityPackages.map(({ presentation }) => presentation.title),
    ["Pocket Vowels", "Double Take", "Common Ground", "X-Ray", "Chain of Evidence"],
  );
  assert.equal(new Set(featuredCommunityPackages.map(({ id }) => id)).size, 5);
  assert.equal(new Set(featuredCommunityPackages.map(({ revisionDigest }) => revisionDigest)).size, 5);
  assert.equal(new Set(communityAllowlist.map(({ canonicalDefinitionDigest }) => canonicalDefinitionDigest)).size, 5);
  for (const sourcePackage of featuredCommunityPackages) {
    assert.equal(sourcePackage.presentation.creator.displayName, "JotBot");
    assert.match(sourcePackage.presentation.subtitle, /\([^)]+-min\. game\)$/);
    assert.equal(sourcePackage.presentation.glyph.fallback.artwork.startsWith("glyph_"), true);
    assert.equal(sourcePackage.contract.definition.match.kind, "solo");
    assert.deepEqual(
      sourcePackage.requirements.lexicon,
      sourcePackage.contract.definition.word.lexicon,
    );
  }
});

test("each original carries the reviewed config rather than a title-driven mode", () => {
  const byTitle = new Map(featuredCommunityGameSpecs.map((spec) => [spec.title, spec.definition]));
  for (const sourcePackage of featuredCommunityPackages) {
    const canonical = sourcePackage.presentation.sharedProvenance.canonicalEnvelope;
    assert.deepEqual(canonical.definition, byTitle.get(sourcePackage.presentation.title));
    assert.deepEqual(sourcePackage.contract, canonical);
  }

  const doubleTake = byTitle.get("Double Take");
  assert.equal(doubleTake.word.length, 5);
  assert.equal(doubleTake.guessTransformations[0].configuration.pattern, "required");
  const pocketVowels = byTitle.get("Pocket Vowels");
  assert.equal(pocketVowels.word.length, 4);
  assert.equal(pocketVowels.word.allowsDuplicates, true);
  assert.equal(pocketVowels.word.lexicon.id, "com.icedmatchalabs.jottly.pocket-vowels");
  assert.equal(pocketVowels.termination.find(({ typeID }) => typeID.endsWith("guess-limit")).configuration.count, 8);
  assert.deepEqual(
    pocketVowels.feedback.map((rule) => rule.configuration.disclosure),
    ["aggregate", "aggregate"],
  );
  assert.equal(pocketVowels.guessTransformations[0].configuration.letters, "aeiouy");
  const commonGround = byTitle.get("Common Ground");
  assert.equal(commonGround.guessTransformations[0].configuration.word, "game");
  const xRay = byTitle.get("X-Ray");
  assert.deepEqual(xRay.feedback.map((rule) => rule.configuration.disclosure), ["aggregate", "perLetter"]);
  const chain = byTitle.get("Chain of Evidence");
  assert.deepEqual(
    chain.guessTransformations.map(({ typeID }) => typeID.split(".").at(-1)),
    ["word-chain", "clue-boost"],
  );
});

test("production requests exactly the five checked-in featured games", async () => {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const configuration = JSON.parse(source);

  assert.equal(Number(configuration.vars.COMMUNITY_CATALOG_SIZE), featuredCommunityPackages.length);
  assert.equal(featuredCommunityPackages.length, 5);
});

test("the scheduled sweep publishes the five originals as the empty-community bootstrap", async () => {
  let published;
  const result = await runCommunitySweep({
    env: {
      CLOUDKIT_CONTAINER: "iCloud.com.dsull.Jotto",
      CLOUDKIT_ENVIRONMENT: "production",
      CLOUDKIT_KEY_ID: "test-key",
      CLOUDKIT_PRIVATE_KEY_PKCS8_BASE64: "test-private-key",
      COMMUNITY_CATALOG_SIZE: "5",
      COMMUNITY_DB: {},
    },
    asOfMilliseconds: Date.parse("2026-09-09T12:00:00Z"),
    client: { queryGameStates: async () => ({ records: [], pageCount: 1 }) },
    publish: async (_db, snapshot) => {
      published = snapshot;
      return { published: true };
    },
  });

  assert.equal(result.status, "published");
  assert.equal(published.catalogKind, "mixed");
  assert.deepEqual(
    new Set(published.games.map(({ sourcePackage }) => sourcePackage.id)),
    new Set(featuredCommunityPackages.map(({ id }) => id)),
  );
  assert.ok(published.games.every(({ selectionSource }) => selectionSource === "featured"));
});

test("the five originals cross the scheduled sweep, D1 publication, and public GET boundary", async () => {
  const db = new FeaturedCatalogDB();
  const asOfMilliseconds = Date.parse("2026-09-09T12:00:00Z");
  const result = await runCommunitySweep({
    env: {
      CLOUDKIT_CONTAINER: "iCloud.com.dsull.Jotto",
      CLOUDKIT_ENVIRONMENT: "production",
      CLOUDKIT_KEY_ID: "test-key",
      CLOUDKIT_PRIVATE_KEY_PKCS8_BASE64: "test-private-key",
      COMMUNITY_CATALOG_SIZE: "5",
      COMMUNITY_DB: db,
    },
    asOfMilliseconds,
    client: { queryGameStates: async () => ({ records: [], pageCount: 1 }) },
    publish: publishCommunityCatalog,
  });

  assert.equal(result.status, "published");
  assert.equal(result.publishedEntryCount, 5);

  const response = await getCommunityCatalog({
    request: new Request("https://icedmatchalabs.com/api/community/v1/games"),
    env: { COMMUNITY_DB: db },
  });
  assert.equal(response.status, 200);
  assert.notEqual(response.headers.get("etag"), null);

  const catalog = await response.json();
  assert.equal(catalog.catalogKind, "mixed");
  assert.deepEqual(catalog.games.map(({ rank }) => rank), [1, 2, 3, 4, 5]);
  assert.deepEqual(
    catalog.games.map(({ selectionSource }) => selectionSource),
    ["featured", "featured", "featured", "featured", "featured"],
  );
  assert.deepEqual(
    new Set(catalog.games.map(({ sourcePackage }) => sourcePackage.id)),
    new Set(featuredCommunityPackages.map(({ id }) => id)),
  );
  assert.deepEqual(
    new Set(catalog.games.map(({ sourcePackage }) => sourcePackage.presentation.title)),
    new Set(featuredCommunityPackages.map(({ presentation }) => presentation.title)),
  );
});

class FeaturedCatalogDB {
  constructor() {
    this.row = null;
  }

  prepare() {
    return {
      run: async () => ({ meta: { changes: 0 } }),
      bind: (...values) => ({
        run: async () => {
          const [generatedAt, hash, payload] = values;
          if (this.row && generatedAt <= this.row.generated_at_ms) {
            return { meta: { changes: 0 } };
          }
          this.row = {
            generated_at_ms: generatedAt,
            payload_sha256: hash,
            payload_json: payload,
          };
          return { meta: { changes: 1 } };
        },
      }),
      first: async () => this.row,
    };
  }
}
