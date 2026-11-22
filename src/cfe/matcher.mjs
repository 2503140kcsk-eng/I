import { canonicalJson, cloneCanonical } from "./canonical.mjs";

export const FOOTPRINT_SCHEMA = "cfe.shogi.footprint";

function isScalar(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function normalizeCube(features) {
  if (features === undefined) return [];
  if (features === null || typeof features !== "object" || Array.isArray(features)) {
    throw new TypeError("Footprint features must be a flat object");
  }
  return Object.keys(features).sort().map(function (key) {
    const value = features[key];
    if (!key || !isScalar(value) || (typeof value === "number" && !Number.isFinite(value))) {
      throw new TypeError("Feature " + key + " must have a scalar JSON value");
    }
    return { key: key, value: Object.is(value, -0) ? 0 : value };
  });
}

export function createFootprint(certificate, features = {}) {
  if (!certificate || certificate.schema !== "cfe.shogi.certificate" ||
      certificate.version !== 1 ||
      (certificate.attackerSide !== "b" && certificate.attackerSide !== "w") ||
      !certificate.nodes || !certificate.nodes[certificate.root]) {
    throw new TypeError("A well-formed certificate is required");
  }
  const root = certificate.nodes[certificate.root];
  return {
    schema: FOOTPRINT_SCHEMA,
    version: 1,
    rulesetId: certificate.rulesetId,
    verifierAbi: certificate.verifierAbi,
    attackerSide: certificate.attackerSide,
    rootNodeId: certificate.root,
    rootState: cloneCanonical(root.state),
    cube: normalizeCube(features)
  };
}

/**
 * A footprint hit is never proof acceptance. Exact root state/history matches
 * are eligible for verification. Abstract cube hits are indexing hints only.
 */
export function matchFootprint(footprint, query) {
  if (!footprint || footprint.schema !== FOOTPRINT_SCHEMA || footprint.version !== 1 ||
      !query || typeof query !== "object") {
    return { decision: "MISS", requiresVerification: true, reason: "invalid-input" };
  }
  if (footprint.rulesetId !== query.rulesetId ||
      footprint.verifierAbi !== query.verifierAbi ||
      footprint.attackerSide !== query.attackerSide) {
    return { decision: "MISS", requiresVerification: true, reason: "ruleset-abi-or-attacker-mismatch" };
  }
  if (!query.state || typeof query.state !== "object") {
    return { decision: "MISS", requiresVerification: true, reason: "missing-query-state" };
  }
  if (canonicalJson(footprint.rootState) === canonicalJson(query.state)) {
    return {
      decision: "EXACT_CANDIDATE",
      requiresVerification: true,
      canAcceptAsProof: false,
      rootNodeId: footprint.rootNodeId
    };
  }

  let cubeMatches = false;
  try {
    const features = query.features || {};
    cubeMatches = footprint.cube.length > 0 && footprint.cube.every(function (item) {
      return Object.hasOwn(features, item.key) &&
        canonicalJson(features[item.key]) === canonicalJson(item.value);
    });
  } catch {
    cubeMatches = false;
  }
  if (cubeMatches) {
    return {
      decision: "ABSTRACT_CANDIDATE",
      requiresVerification: true,
      canAcceptAsProof: false,
      reason: "A cube hit does not imply the certificate root preconditions"
    };
  }
  return { decision: "MISS", requiresVerification: true, reason: "no-footprint-match" };
}
