import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const sourceURL = new URL("../community/catalog-contract-v1.json", import.meta.url);
const destinationURL = new URL("../functions/api/community/v1/generated-contract.js", import.meta.url);
const source = JSON.parse(await readFile(sourceURL, "utf8"));
const generated = `// Generated from community/catalog-contract-v1.json. Run scripts/generate-community-contract.mjs.
export const communityContract = Object.freeze({
  schemaVersion: ${source.schemaVersion},
  catalog: Object.freeze({
    maximumEntries: ${source.catalog.maximumEntries},
    maximumBytes: ${source.catalog.maximumBytes},
    selectionSources: Object.freeze(${JSON.stringify(source.catalog.selectionSources)}),
  }),
  package: Object.freeze({
    schemaVersion: ${source.package.schemaVersion},
    contractProtocolVersion: ${source.package.contractProtocolVersion},
    canonicalTopology: ${JSON.stringify(source.package.canonicalTopology)},
    carrierTopologies: Object.freeze(${JSON.stringify(source.package.carrierTopologies)}),
    authorship: ${JSON.stringify(source.package.authorship)},
    maximumTitleCharacters: ${source.package.maximumTitleCharacters},
    maximumSubtitleCharacters: ${source.package.maximumSubtitleCharacters},
  }),
});
`;

if (process.argv.includes("--check")) {
  assert.equal(await readFile(destinationURL, "utf8"), generated, "Generated community contract is stale");
} else {
  await writeFile(destinationURL, generated);
}
