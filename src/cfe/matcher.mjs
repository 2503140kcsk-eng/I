import { canonicalJson, cloneCanonical } from "./canonical.mjs";

export const FOOTPRINT_SCHEMA = "cfe.shogi.footprint";
const HASH_RE = /^[0-9a-f]{64}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isScalar(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function normalizeCube(features) {
  if (features === undefined) return [];
  if (!isRecord(features)) throw new TypeError("Footprint features must be a flat object");
  return Object.keys(features).sort().map(function (key) {
    const value = features[key];
    if (!key || !isScalar(value) || (typeof value === "number" && !Number.isFinite(value))) {
      throw new TypeError("Feature " + key + " must have a scalar JSON value");
    }
    return { key: key, value: Object.is(value, -0) ? 0 : value };
  });
}

function cubeEntries(cube) {
  const source = Array.isArray(cube) ? cube : normalizeCube(cube);
  const seen = new Set();
  const entries = [];
  for (const item of source) {
    if (!isRecord(item) || Object.keys(item).sort().join(",") !== "key,value" ||
        typeof item.key !== "string" || item.key.length === 0 ||
        !isScalar(item.value) ||
        (typeof item.value === "number" && !Number.isFinite(item.value))) {
      throw new TypeError("Condition cube contains an invalid literal");
    }
    if (seen.has(item.key)) throw new TypeError("Condition cube repeats feature " + item.key);
    seen.add(item.key);
    entries.push([item.key, Object.is(item.value, -0) ? 0 : item.value]);
  }
  entries.sort(function (a, b) {
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  return new Map(entries);
}

function sameValue(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * A cube is a conjunction of feature equalities.
 *
 * LEFT_STRONGER means every assignment satisfying the left cube also satisfies
 * the right cube. RIGHT_STRONGER is the converse. INCOMPARABLE cubes overlap
 * unless a conflicting literal makes them DISJOINT.
 */
export function compareConditionCubes(left, right) {
  const a = cubeEntries(left);
  const b = cubeEntries(right);

  for (const [key, value] of a) {
    if (b.has(key) && !sameValue(value, b.get(key))) {
      return {
        relation: "DISJOINT",
        leftImpliesRight: false,
        rightImpliesLeft: false
      };
    }
  }

  const leftImpliesRight = Array.from(b).every(function ([key, value]) {
    return a.has(key) && sameValue(a.get(key), value);
  });
  const rightImpliesLeft = Array.from(a).every(function ([key, value]) {
    return b.has(key) && sameValue(b.get(key), value);
  });

  let relation = "INCOMPARABLE";
  if (leftImpliesRight && rightImpliesLeft) relation = "EQUIVALENT";
  else if (leftImpliesRight) relation = "LEFT_STRONGER";
  else if (rightImpliesLeft) relation = "RIGHT_STRONGER";

  return {
    relation: relation,
    leftImpliesRight: leftImpliesRight,
    rightImpliesLeft: rightImpliesLeft
  };
}

function assertFootprint(footprint) {
  if (!isRecord(footprint) ||
      footprint.schema !== FOOTPRINT_SCHEMA ||
      footprint.version !== 1 ||
      typeof footprint.rulesetId !== "string" || footprint.rulesetId.length === 0 ||
      typeof footprint.verifierAbi !== "string" || footprint.verifierAbi.length === 0 ||
      !["b", "w"].includes(footprint.attackerSide) ||
      typeof footprint.rootNodeId !== "string" || !HASH_RE.test(footprint.rootNodeId) ||
      !isRecord(footprint.rootState) ||
      !Array.isArray(footprint.cube)) {
    throw new TypeError("Invalid CFE footprint envelope");
  }
  cubeEntries(footprint.cube);
}

export function compareFootprints(left, right) {
  try {
    assertFootprint(left);
    assertFootprint(right);
    if (left.rulesetId !== right.rulesetId ||
        left.verifierAbi !== right.verifierAbi ||
        left.attackerSide !== right.attackerSide) {
      return {
        compatible: false,
        relation: "INCOMPATIBLE",
        proofTransferAllowed: false
      };
    }
    const cubes = compareConditionCubes(left.cube, right.cube);
    return {
      compatible: true,
      relation: cubes.relation,
      leftImpliesRight: cubes.leftImpliesRight,
      rightImpliesLeft: cubes.rightImpliesLeft,
      sameRootState: sameValue(left.rootState, right.rootState),
      proofTransferAllowed: false
    };
  } catch (error) {
    return {
      compatible: false,
      relation: "INVALID",
      proofTransferAllowed: false,
      reason: error.message || String(error)
    };
  }
}

export function createFootprint(certificate, features = {}) {
  if (!isRecord(certificate) ||
      certificate.schema !== "cfe.shogi.certificate" ||
      certificate.version !== 1 ||
      (certificate.attackerSide !== "b" && certificate.attackerSide !== "w") ||
      typeof certificate.rulesetId !== "string" || certificate.rulesetId.length === 0 ||
      typeof certificate.verifierAbi !== "string" || certificate.verifierAbi.length === 0 ||
      !isRecord(certificate.nodes) ||
      typeof certificate.root !== "string" || !HASH_RE.test(certificate.root) ||
      !certificate.nodes[certificate.root] ||
      !isRecord(certificate.nodes[certificate.root].state)) {
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
 * are candidates for independent verification. Abstract cube hits are index
 * retrieval hints only.
 */
export function matchFootprint(footprint, query) {
  try {
    assertFootprint(footprint);
    if (!isRecord(query)) {
      return { decision: "MISS", requiresVerification: true, reason: "invalid-query" };
    }
    if (footprint.rulesetId !== query.rulesetId ||
        footprint.verifierAbi !== query.verifierAbi ||
        footprint.attackerSide !== query.attackerSide) {
      return { decision: "MISS", requiresVerification: true, reason: "ruleset-abi-or-attacker-mismatch" };
    }
    if (!isRecord(query.state)) {
      return { decision: "MISS", requiresVerification: true, reason: "missing-query-state" };
    }
    if (sameValue(footprint.rootState, query.state)) {
      return {
        decision: "EXACT_CANDIDATE",
        requiresVerification: true,
        canAcceptAsProof: false,
        rootNodeId: footprint.rootNodeId
      };
    }

    const featureMap = cubeEntries(query.features || {});
    const cubeMatches = footprint.cube.length > 0 &&
      footprint.cube.every(function (item) {
        return featureMap.has(item.key) && sameValue(featureMap.get(item.key), item.value);
      });
    if (cubeMatches) {
      return {
        decision: "ABSTRACT_CANDIDATE",
        requiresVerification: true,
        canAcceptAsProof: false,
        reason: "A cube hit does not imply the certificate root preconditions"
      };
    }
    return { decision: "MISS", requiresVerification: true, reason: "no-footprint-match" };
  } catch (error) {
    return {
      decision: "MISS",
      requiresVerification: true,
      reason: "invalid-footprint-or-query: " + (error.message || String(error))
    };
  }
}
