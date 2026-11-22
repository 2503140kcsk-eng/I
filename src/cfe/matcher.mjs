import { canonicalJson, cloneCanonical } from "./canonical.mjs";

export const FOOTPRINT_SCHEMA = "cfe.shogi.footprint";
export const FOOTPRINT_VERSION = 2;
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_FEATURES = 256;
const MAX_FEATURE_KEY_LENGTH = 128;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isScalar(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function validateFeatureAbi(value) {
  if (value !== null && (typeof value !== "string" || value.length === 0 || value.length > 128)) {
    throw new TypeError("featureAbi must be null or a non-empty string of at most 128 characters");
  }
  return value;
}

function normalizeCube(features) {
  if (features === undefined) return [];
  if (!isRecord(features)) throw new TypeError("Footprint features must be a flat object");
  const keys = Object.keys(features).sort();
  if (keys.length > MAX_FEATURES) throw new TypeError("Footprint exceeds the feature-count limit");

  return keys.map(function (key) {
    if (!key || key.length > MAX_FEATURE_KEY_LENGTH) {
      throw new TypeError("Feature keys must contain 1 to 128 characters");
    }
    canonicalJson(key);
    const value = cloneCanonical(features[key]);
    if (!isScalar(value)) throw new TypeError("Feature " + key + " must have a scalar JSON value");
    return { key: key, value: value };
  });
}

function cubeEntries(cube) {
  if (!Array.isArray(cube) || cube.length > MAX_FEATURES) {
    throw new TypeError("Condition cube must be an array with at most 256 literals");
  }
  const seen = new Set();
  const entries = [];
  for (const item of cube) {
    if (!isRecord(item) || Object.keys(item).sort().join(",") !== "key,value" ||
        typeof item.key !== "string" || item.key.length === 0 ||
        item.key.length > MAX_FEATURE_KEY_LENGTH || !isScalar(item.value)) {
      throw new TypeError("Condition cube contains an invalid literal");
    }
    canonicalJson(item.key);
    canonicalJson(item.value);
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

function validateProofSummary(summary) {
  if (summary === null) return null;
  const fields = [
    "andNodeCount",
    "edgeCount",
    "maxAttackerChoices",
    "maxDefenderEvasions",
    "maxDepth",
    "nodeCount",
    "orNodeCount",
    "schema",
    "terminalMateCount",
    "version"
  ];
  if (!isRecord(summary) || Object.keys(summary).sort().join(",") !== fields.sort().join(",") ||
      summary.schema !== "cfe.shogi.proof-summary" || summary.version !== 1) {
    throw new TypeError("Invalid proof summary schema");
  }
  for (const key of [
    "andNodeCount", "edgeCount", "maxAttackerChoices", "maxDefenderEvasions",
    "maxDepth", "nodeCount", "orNodeCount", "terminalMateCount"
  ]) {
    if (!Number.isSafeInteger(summary[key]) || summary[key] < 0) {
      throw new TypeError("Invalid proof summary metric: " + key);
    }
  }
  if (summary.nodeCount < 1 ||
      summary.orNodeCount + summary.andNodeCount + summary.terminalMateCount !== summary.nodeCount ||
      summary.maxDepth > 1024) {
    throw new TypeError("Inconsistent proof summary metrics");
  }
  return cloneCanonical(summary);
}

/**
 * Summarizes an already verified finite proof DAG.
 *
 * This is metadata for indexing and Governor heuristics. It never establishes
 * proof validity; call it only after verifyCertificate returned VERIFIED_MATE.
 */
export function summarizeProofDag(certificate) {
  if (!isRecord(certificate) || certificate.schema !== "cfe.shogi.certificate" ||
      certificate.version !== 1 || !isRecord(certificate.nodes) ||
      typeof certificate.root !== "string" || !Object.hasOwn(certificate.nodes, certificate.root)) {
    throw new TypeError("A CFE certificate with a root node is required");
  }

  const ids = Object.keys(certificate.nodes);
  if (ids.length === 0 || ids.length > 1_000_000) {
    throw new TypeError("Proof DAG has an invalid node count");
  }

  let edgeCount = 0;
  let orNodeCount = 0;
  let andNodeCount = 0;
  let terminalMateCount = 0;
  let maxAttackerChoices = 0;
  let maxDefenderEvasions = 0;

  for (const id of ids) {
    const node = certificate.nodes[id];
    if (!isRecord(node) || !Array.isArray(node.edges)) {
      throw new TypeError("Malformed proof node " + id);
    }
    if (node.kind === "OR") {
      orNodeCount += 1;
      maxAttackerChoices = Math.max(maxAttackerChoices, node.edges.length);
    } else if (node.kind === "AND") {
      andNodeCount += 1;
      maxDefenderEvasions = Math.max(maxDefenderEvasions, node.edges.length);
    } else if (node.kind === "TERMINAL_MATE") {
      terminalMateCount += 1;
    } else {
      throw new TypeError("Unknown proof node kind at " + id);
    }
    edgeCount += node.edges.length;
    for (const edge of node.edges) {
      if (!isRecord(edge) || typeof edge.to !== "string" ||
          !Object.hasOwn(certificate.nodes, edge.to)) {
        throw new TypeError("Proof node " + id + " references an invalid child");
      }
    }
  }

  // Iterative DFS post-order avoids depending on JavaScript call-stack depth.
  const active = new Set();
  const complete = new Set();
  const depthById = new Map();
  const stack = [{ id: certificate.root, expanded: false }];

  while (stack.length > 0) {
    const frame = stack.pop();
    const node = certificate.nodes[frame.id];
    if (frame.expanded) {
      let depth = 0;
      for (const edge of node.edges) {
        depth = Math.max(depth, 1 + depthById.get(edge.to));
      }
      depthById.set(frame.id, depth);
      active.delete(frame.id);
      complete.add(frame.id);
      continue;
    }
    if (complete.has(frame.id)) continue;
    if (active.has(frame.id)) throw new TypeError("Cycle detected while summarizing proof DAG");
    active.add(frame.id);
    stack.push({ id: frame.id, expanded: true });
    for (let i = node.edges.length - 1; i >= 0; i -= 1) {
      const childId = node.edges[i].to;
      if (active.has(childId)) throw new TypeError("Cycle detected while summarizing proof DAG");
      if (!complete.has(childId)) stack.push({ id: childId, expanded: false });
    }
  }

  if (complete.size !== ids.length) {
    throw new TypeError("Proof DAG contains unreachable nodes");
  }

  return {
    schema: "cfe.shogi.proof-summary",
    version: 1,
    nodeCount: ids.length,
    edgeCount: edgeCount,
    orNodeCount: orNodeCount,
    andNodeCount: andNodeCount,
    terminalMateCount: terminalMateCount,
    maxDepth: depthById.get(certificate.root),
    maxAttackerChoices: maxAttackerChoices,
    maxDefenderEvasions: maxDefenderEvasions
  };
}

/**
 * A cube is a conjunction of feature equalities.
 *
 * LEFT_STRONGER means every assignment satisfying the left cube also satisfies
 * the right cube. RIGHT_STRONGER is the converse. INCOMPARABLE cubes overlap
 * unless a conflicting literal makes them DISJOINT.
 */
export function compareConditionCubes(left, right) {
  const a = cubeEntries(Array.isArray(left) ? left : normalizeCube(left));
  const b = cubeEntries(Array.isArray(right) ? right : normalizeCube(right));

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
  const fields = [
    "attackerSide", "cube", "featureAbi", "proofSummary",
    "rootNodeId", "rootState", "rulesetId", "schema", "verifierAbi", "version"
  ];
  if (!isRecord(footprint) || Object.keys(footprint).sort().join(",") !== fields.sort().join(",") ||
      footprint.schema !== FOOTPRINT_SCHEMA ||
      footprint.version !== FOOTPRINT_VERSION ||
      typeof footprint.rulesetId !== "string" || footprint.rulesetId.length === 0 ||
      typeof footprint.verifierAbi !== "string" || footprint.verifierAbi.length === 0 ||
      !["b", "w"].includes(footprint.attackerSide) ||
      typeof footprint.rootNodeId !== "string" || !HASH_RE.test(footprint.rootNodeId) ||
      !isRecord(footprint.rootState) ||
      !Array.isArray(footprint.cube)) {
    throw new TypeError("Invalid CFE footprint envelope");
  }
  validateFeatureAbi(footprint.featureAbi);
  const cube = cubeEntries(footprint.cube);
  if (cube.size > 0 && footprint.featureAbi === null) {
    throw new TypeError("A non-empty cube requires a feature ABI");
  }
  validateProofSummary(footprint.proofSummary);
}

export function compareFootprints(left, right) {
  try {
    assertFootprint(left);
    assertFootprint(right);
    if (left.rulesetId !== right.rulesetId ||
        left.verifierAbi !== right.verifierAbi ||
        left.attackerSide !== right.attackerSide ||
        left.featureAbi !== right.featureAbi) {
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
      proofSummary: left.proofSummary,
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

export function createFootprint(certificate, features = {}, options = {}) {
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
  if (!isRecord(options) ||
      Object.keys(options).some((key) => !["featureAbi", "proofSummary"].includes(key))) {
    throw new TypeError("Footprint options may contain only featureAbi and proofSummary");
  }
  const cube = normalizeCube(features);
  const featureAbi = validateFeatureAbi(options.featureAbi === undefined ? null : options.featureAbi);
  if (cube.length > 0 && featureAbi === null) {
    throw new TypeError("A non-empty cube requires a versioned featureAbi");
  }
  const proofSummary = validateProofSummary(options.proofSummary === undefined ? null : options.proofSummary);
  const root = certificate.nodes[certificate.root];
  return {
    schema: FOOTPRINT_SCHEMA,
    version: FOOTPRINT_VERSION,
    rulesetId: certificate.rulesetId,
    verifierAbi: certificate.verifierAbi,
    attackerSide: certificate.attackerSide,
    rootNodeId: certificate.root,
    rootState: cloneCanonical(root.state),
    featureAbi: featureAbi,
    cube: cube,
    proofSummary: proofSummary
  };
}

/**
 * A footprint hit is never proof acceptance. Exact root state/history matches
 * are candidates for independent verification. Abstract cube hits are index
 * retrieval hints only and require the exact feature ABI.
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

    if (!footprint.featureAbi || query.featureAbi !== footprint.featureAbi) {
      return {
        decision: "MISS",
        requiresVerification: true,
        reason: "feature-abi-mismatch"
      };
    }
    const featureMap = cubeEntries(normalizeCube(query.features || {}));
    const cubeMatches = footprint.cube.length > 0 &&
      footprint.cube.every(function (item) {
        return featureMap.has(item.key) && sameValue(featureMap.get(item.key), item.value);
      });
    if (cubeMatches) {
      return {
        decision: "ABSTRACT_CANDIDATE",
        requiresVerification: true,
        canAcceptAsProof: false,
        rootNodeId: footprint.rootNodeId,
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
