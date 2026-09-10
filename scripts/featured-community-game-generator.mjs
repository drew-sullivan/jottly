import { createHash } from "node:crypto";

const lexicon = Object.freeze({
  id: "com.icedmatchalabs.jottly.remix.words",
  version: 5,
  contentDigest: "922ef9098cd1562cedccda8822963ca5d81800e38b787333c7ad5d97e87771d9",
});

const pocketVowelsLexicon = Object.freeze({
  id: "com.icedmatchalabs.jottly.pocket-vowels",
  version: 1,
  contentDigest: "e31a8097fbe6c4c0ccf3863aca81e0f3ac891f1c7b4ce13581cfcaa93de55232",
});

const component = Object.freeze({
  fixedSecret: "com.icedmatchalabs.jottly.target.fixed-secret",
  membership: "com.icedmatchalabs.jottly.feedback.membership",
  exactPosition: "com.icedmatchalabs.jottly.feedback.exact-position",
  exactWordWins: "com.icedmatchalabs.jottly.termination.exact-word-wins",
  guessLimit: "com.icedmatchalabs.jottly.termination.guess-limit",
  duplicatePattern: "com.icedmatchalabs.jottly.modifier.duplicate-pattern",
  sharedOpeningGuess: "com.icedmatchalabs.jottly.modifier.shared-opening-guess",
  clueBoost: "com.icedmatchalabs.jottly.modifier.clue-boost",
  wordChain: "com.icedmatchalabs.jottly.modifier.word-chain",
  availableLetters: "com.icedmatchalabs.jottly.modifier.available-letters",
});

export const featuredCommunityGameSpecs = Object.freeze([
  Object.freeze({
    id: "51000000-0000-4000-8000-000000000001",
    title: "Pocket Vowels",
    subtitle: "Crack a four-letter vowel code using exact and misplaced clues (3-min. game)",
    glyph: "glyph_lightning_alt_3",
    fallbackLetter: "L",
    definition: definition({
      wordLength: 4,
      allowsDuplicates: true,
      lexicon: pocketVowelsLexicon,
      feedback: exactAndPresentFeedback(),
      guessLimit: 8,
      modifiers: [rule(component.availableLetters, { letters: "aeiouy" })],
    }),
  }),
  Object.freeze({
    id: "51000000-0000-4000-8000-000000000002",
    title: "Double Take",
    subtitle: "Every word repeats itself. Spot the pattern fast (2-min. game)",
    glyph: "glyph_eye",
    fallbackLetter: "E",
    definition: definition({
      wordLength: 5,
      allowsDuplicates: true,
      feedback: perLetterFeedback(),
      guessLimit: 5,
      modifiers: [rule(component.duplicatePattern, { pattern: "required" }, 2)],
    }),
  }),
  Object.freeze({
    id: "51000000-0000-4000-8000-000000000003",
    title: "Common Ground",
    subtitle: "Race from the same opening word and prove your deduction chops (3-min. game)",
    glyph: "glyph_puzzle_piece_3",
    fallbackLetter: "P",
    definition: definition({
      wordLength: 4,
      allowsDuplicates: false,
      feedback: exactAndPresentFeedback(),
      guessLimit: 5,
      modifiers: [rule(component.sharedOpeningGuess, { word: "game" })],
    }),
  }),
  Object.freeze({
    id: "51000000-0000-4000-8000-000000000004",
    title: "X-Ray",
    subtitle: "See which letters belong and count the ones perfectly placed (5-min. game)",
    glyph: "glyph_crystal_ball",
    fallbackLetter: "C",
    definition: definition({
      wordLength: 6,
      allowsDuplicates: true,
      feedback: xRayFeedback(),
      guessLimit: 11,
    }),
  }),
  Object.freeze({
    id: "51000000-0000-4000-8000-000000000005",
    title: "Chain of Evidence",
    subtitle: "Every guess must connect to the last. Build your case carefully (10-min. game)",
    glyph: "glyph_footprints",
    fallbackLetter: "F",
    definition: definition({
      wordLength: 6,
      allowsDuplicates: true,
      feedback: sharedLetterFeedback(),
      guessLimit: 14,
      modifiers: [
        rule(component.wordChain, { minimumSharedLetters: 2 }),
        rule(component.clueBoost, { maximumUses: 1 }, 4),
      ],
    }),
  }),
]);

export function buildFeaturedCommunityPackages() {
  return featuredCommunityGameSpecs.map(buildPackage);
}

export function buildFeaturedCommunityAllowlist(packages = buildFeaturedCommunityPackages()) {
  return packages.map((sourcePackage) => ({
    packageID: sourcePackage.id,
    canonicalDefinitionDigest:
      sourcePackage.presentation.sharedProvenance.canonicalEnvelope.definitionDigest,
  }));
}

export function stableJSONStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSONStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJSONStringify(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function definition({
  wordLength,
  allowsDuplicates,
  feedback,
  guessLimit,
  modifiers = [],
  lexicon: selectedLexicon = lexicon,
}) {
  return {
    schemaVersion: 1,
    word: { length: wordLength, allowsDuplicates, lexicon: selectedLexicon },
    match: { kind: "solo", grantsFinalEqualizer: false },
    target: rule(component.fixedSecret),
    feedback: [...feedback].sort(compareRules),
    startingHints: [],
    guessTransformations: modifiers,
    termination: [
      rule(component.exactWordWins),
      rule(component.guessLimit, { count: guessLimit }),
    ].sort(compareRules),
  };
}

function perLetterFeedback() {
  return [
    rule(component.membership, {
      disclosure: "perLetter",
      includesExactPositions: false,
      scoring: "occurrenceLimited",
    }),
    rule(component.exactPosition, { disclosure: "perLetter" }),
  ];
}

function exactAndPresentFeedback() {
  return [
    rule(component.membership, {
      disclosure: "aggregate",
      includesExactPositions: false,
      scoring: "occurrenceLimited",
    }),
    rule(component.exactPosition, { disclosure: "aggregate" }),
  ];
}

function xRayFeedback() {
  return [
    rule(component.membership, {
      disclosure: "perLetter",
      includesExactPositions: true,
      scoring: "occurrenceLimited",
    }),
    rule(component.exactPosition, { disclosure: "aggregate" }),
  ];
}

function sharedLetterFeedback() {
  return [rule(component.membership, {
    disclosure: "aggregate",
    includesExactPositions: false,
    scoring: "uniqueLetters",
  })];
}

function rule(typeID, configuration = {}, version = 1) {
  return { typeID, version, configuration };
}

function compareRules(left, right) {
  return left.typeID.localeCompare(right.typeID)
    || left.version - right.version
    || stableJSONStringify(left.configuration).localeCompare(stableJSONStringify(right.configuration));
}

function buildPackage(spec) {
  const definitionDigest = sha256Hex(stableJSONStringify(spec.definition));
  const envelope = {
    protocolVersion: 1,
    definition: spec.definition,
    definitionDigest,
  };
  const savedGameID = spec.id.toUpperCase();
  const presentation = {
    title: spec.title,
    subtitle: spec.subtitle,
    glyph: {
      fallback: {
        letter: spec.fallbackLetter,
        shape: "tile",
        color: "coral",
        artwork: spec.glyph,
      },
      opticalScale: 1,
    },
    authorship: "player",
    creator: { displayName: "JotBot" },
    sharedProvenance: {
      schemaVersion: 1,
      savedGameID,
      canonicalEnvelope: envelope,
      remixLineage: {
        origin: {
          catalogID: "community.jotbot.original.v1",
          title: "JotBot Originals",
          definitionDigest,
        },
        remixDepth: 1,
        recentAncestors: [],
      },
    },
  };
  const capabilities = {
    canSaveToLibrary: true,
    showsRulesOnEntry: true,
    participatesInCatalogStatistics: false,
  };
  const requirements = {
    contractProtocolVersion: 1,
    definitionSchemaVersion: 1,
    lexicon: spec.definition.word.lexicon,
    components: [
      spec.definition.target,
      ...spec.definition.feedback,
      ...spec.definition.startingHints,
      ...spec.definition.guessTransformations,
      ...spec.definition.termination,
    ]
      .map(({ typeID, version }) => ({ typeID, version }))
      .sort((left, right) => left.typeID.localeCompare(right.typeID) || left.version - right.version),
  };
  const payload = {
    schemaVersion: 1,
    id: `authored.${spec.id}`,
    contract: envelope,
    presentation,
    requirements,
    capabilities,
  };
  return { ...payload, revisionDigest: sha256Hex(stableJSONStringify(payload)) };
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}
