export function communityPackage(index, { topology = "headToHead", title = `Game ${index}` } = {}) {
  const suffix = String(index).padStart(12, "0");
  const savedGameID = `00000000-0000-4000-8000-${suffix}`;
  const canonicalDigest = index.toString(16).padStart(64, "0");
  const carriedDigest = (index + 100).toString(16).padStart(64, "0");
  return {
    schemaVersion: 1,
    id: `authored.${savedGameID}`,
    revisionDigest: (index + 200).toString(16).padStart(64, "0"),
    contract: {
      protocolVersion: 1,
      definition: { word: { length: 5 }, match: { kind: topology } },
      definitionDigest: topology === "solo" ? canonicalDigest : carriedDigest,
    },
    presentation: {
      title,
      subtitle: "A reviewed community game",
      glyph: { kind: "letterTile", value: "J" },
      authorship: "player",
      creator: { displayName: "Builder" },
      sharedProvenance: {
        schemaVersion: 1,
        savedGameID,
        canonicalEnvelope: {
          protocolVersion: 1,
          definition: { word: { length: 5 }, match: { kind: "solo" } },
          definitionDigest: canonicalDigest,
        },
        remixLineage: { ancestors: [] },
      },
    },
    requirements: {},
    capabilities: { canSaveToLibrary: true },
  };
}

export function allowlistFor(packages) {
  return packages.map((sourcePackage) => ({
    packageID: sourcePackage.id,
    canonicalDefinitionDigest: sourcePackage.presentation.sharedProvenance.canonicalEnvelope.definitionDigest,
  }));
}

export function completionRecord(sourcePackage, {
  timestamp,
  inviterID = "player-a",
  inviteeID = "player-b",
  phase = "definitionComplete",
  outcome = { winner: { playerID: inviterID } },
} = {}) {
  const state = {
    phase,
    game: {
      inviter: { id: inviterID, secretWord: "never-published" },
      invitee: { id: inviteeID, secretWord: "never-published" },
      turns: [{ guess: { word: "never-published" } }],
      outcome,
      gamePackage: sourcePackage,
    },
  };
  return {
    modified: { timestamp },
    fields: { stateData: { type: "BYTES", value: bytesToBase64(new TextEncoder().encode(JSON.stringify(state))) } },
  };
}

export function featuredPool(count = 6, start = 100) {
  return Array.from({ length: count }, (_, offset) => communityPackage(start + offset, { topology: "solo" }));
}

export function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
