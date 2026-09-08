import { validateCommunitySourcePackage } from "./contract.js";

const completePhases = new Set([
  "complete",
  "definitionComplete",
  "cowpokeComplete",
  "lightningComplete",
  "mysteryComplete",
  "shapeshifterComplete",
]);

export const CommunityPublicationRejection = Object.freeze({
  outsideWindow: "outsideWindow",
  incomplete: "incomplete",
  forfeit: "forfeit",
  missingOutcome: "missingOutcome",
  invalidParticipants: "invalidParticipants",
  nonHuman: "nonHuman",
  invalidPackage: "invalidPackage",
  wrongTopology: "wrongTopology",
  unallowlisted: "unallowlisted",
});

export class CommunityPublicationPolicy {
  constructor(rules = communityPublicationRules) {
    this.rules = Object.freeze([...rules]);
  }

  evaluate(candidate) {
    for (const rule of this.rules) {
      const reason = rule.evaluate(candidate);
      if (reason) return { allowed: false, reason };
    }
    return { allowed: true };
  }
}

export const communityPublicationRules = Object.freeze([
  rule("completionWindow", ({ completedAtMilliseconds, fallbackStartMilliseconds, asOfMilliseconds }) => (
    completedAtMilliseconds < fallbackStartMilliseconds || completedAtMilliseconds >= asOfMilliseconds
      ? CommunityPublicationRejection.outsideWindow : null
  )),
  rule("completedHumanResult", ({ state }) => {
    if (!completePhases.has(state?.phase) || !state.game || typeof state.game !== "object") {
      return CommunityPublicationRejection.incomplete;
    }
    const outcome = state.game.outcome;
    if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
      return CommunityPublicationRejection.missingOutcome;
    }
    if (Object.hasOwn(outcome, "forfeit")) return CommunityPublicationRejection.forfeit;
    return Object.hasOwn(outcome, "winner") || Object.hasOwn(outcome, "tie")
      ? null : CommunityPublicationRejection.missingOutcome;
  }),
  rule("distinctHumanPair", ({ state }) => {
    const inviterID = state?.game?.inviter?.id;
    const inviteeID = state?.game?.invitee?.id;
    if (typeof inviterID !== "string" || typeof inviteeID !== "string" || !inviterID || !inviteeID) {
      return CommunityPublicationRejection.invalidParticipants;
    }
    if (inviterID === inviteeID || [inviterID, inviteeID].includes("computer-opponent")) {
      return CommunityPublicationRejection.nonHuman;
    }
    return null;
  }),
  rule("portablePackage", (candidate) => {
    const sourcePackage = candidate.state?.game?.gamePackage;
    const validation = validateCommunitySourcePackage(sourcePackage);
    if (!validation.ok) return CommunityPublicationRejection.invalidPackage;
    return sourcePackage.contract.definition?.match?.kind === "headToHead"
      ? null : CommunityPublicationRejection.wrongTopology;
  }),
  rule("reviewedPackage", ({ state, allowlist }) => {
    const sourcePackage = state.game.gamePackage;
    const validation = validateCommunitySourcePackage(sourcePackage);
    return allowlist.get(sourcePackage.id) === validation.canonicalDigest
      ? null : CommunityPublicationRejection.unallowlisted;
  }),
]);

function rule(id, evaluate) {
  return Object.freeze({ id, evaluate });
}
