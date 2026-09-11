// Generated from community/catalog-contract-v1.json. Run scripts/generate-community-contract.mjs.
export const communityContract = Object.freeze({
  schemaVersion: 1,
  catalog: Object.freeze({
    maximumEntries: 6,
    maximumBytes: 524288,
    selectionSources: Object.freeze(["weeklyPopular","recentlyPopular","featured"]),
  }),
  package: Object.freeze({
    schemaVersion: 1,
    contractProtocolVersion: 1,
    canonicalTopology: "solo",
    carrierTopologies: Object.freeze(["solo","headToHead"]),
    authorship: "player",
    maximumTitleCharacters: 80,
    maximumSubtitleCharacters: 240,
    maximumEstimatedDurationMinutes: 999,
  }),
});
