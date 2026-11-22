import { canonicalJson, cloneCanonical } from "./canonical.mjs";
import {
  CERTIFICATE_SCHEMA,
  CERTIFICATE_VERSION,
  computeNodeId,
  verifyCertificate
} from "./verifier.mjs";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/**
 * Converts an untrusted labelled solver DAG to a content-addressed certificate.
 * The caller must pin the intended search root; the solver's root is not trusted.
 */
export async function extractCertificate(candidate, rules, options = {}) {
  try {
    if (!isRecord(candidate) || !isRecord(candidate.nodes) ||
        typeof candidate.root !== "string" || !Object.hasOwn(candidate.nodes, candidate.root)) {
      fail("INVALID_CANDIDATE", "Candidate must contain a root key and a node table");
    }
    if (!isRecord(options) || !Object.hasOwn(options, "expectedRootState") ||
        !isRecord(options.expectedRootState)) {
      fail("ROOT_BINDING_REQUIRED", "expectedRootState is mandatory for extraction");
    }
    if (candidate.rulesetId !== rules.rulesetId) {
      fail("RULESET_MISMATCH", "Candidate ruleset differs from the verifier ruleset");
    }
    if (candidate.attackerSide !== "b" && candidate.attackerSide !== "w") {
      fail("INVALID_ATTACKER_SIDE", "Candidate attackerSide must be b or w");
    }

    const maxNodes = options.maxNodes === undefined ? 50000 : options.maxNodes;
    const maxDepth = options.maxDepth === undefined ? 512 : options.maxDepth;
    if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 1000000) {
      fail("INVALID_LIMIT", "maxNodes must be a positive safe integer no greater than 1000000");
    }
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 1024) {
      fail("INVALID_LIMIT", "maxDepth must be a positive safe integer no greater than 1024");
    }

    const inputIds = Object.keys(candidate.nodes);
    if (inputIds.length === 0 || inputIds.length > maxNodes) {
      fail("NODE_LIMIT", "Candidate node count is zero or exceeds the configured limit");
    }
    const active = new Set();
    const completed = new Map();
    const outputNodes = Object.create(null);

    const build = async function (inputId, depth) {
      if (depth > maxDepth) fail("DEPTH_LIMIT", "Candidate exceeds the extraction depth limit");
      if (active.has(inputId)) fail("CYCLE_DETECTED", "Candidate proof contains a cycle");
      if (completed.has(inputId)) return completed.get(inputId);

      const raw = candidate.nodes[inputId];
      if (!isRecord(raw) || !Array.isArray(raw.edges)) {
        fail("INVALID_CANDIDATE_NODE", "Candidate node " + inputId + " is malformed");
      }
      const position = await rules.decodeState(raw.state);
      const state = await rules.canonicalState(position);
      if (canonicalJson(state) !== canonicalJson(raw.state)) {
        fail("NON_CANONICAL_STATE", "Candidate node " + inputId + " is not canonical");
      }

      active.add(inputId);
      const edges = [];
      for (const edge of raw.edges) {
        if (!isRecord(edge) || typeof edge.move !== "string" ||
            typeof edge.to !== "string" || !Object.hasOwn(candidate.nodes, edge.to)) {
          fail("INVALID_CANDIDATE_EDGE", "Candidate node " + inputId + " has an invalid edge");
        }
        const childId = await build(edge.to, depth + 1);
        edges.push({ move: edge.move, to: childId });
      }
      edges.sort(function (a, b) {
        return a.move < b.move ? -1 : a.move > b.move ? 1 : 0;
      });
      for (let i = 1; i < edges.length; i += 1) {
        if (edges[i - 1].move === edges[i].move) fail("DUPLICATE_MOVE", "Candidate node repeats a move");
      }

      const node = { state: cloneCanonical(state), kind: raw.kind, edges: edges };
      const id = await computeNodeId(candidate.rulesetId, candidate.attackerSide, node);
      const existing = outputNodes[id];
      if (existing && canonicalJson(existing) !== canonicalJson(node)) {
        fail("HASH_COLLISION", "Two different proof nodes produced the same digest");
      }
      outputNodes[id] = node;
      active.delete(inputId);
      completed.set(inputId, id);
      return id;
    };

    const root = await build(candidate.root, 0);
    if (completed.size !== inputIds.length) {
      fail("UNREACHABLE_INPUT_NODES", "Candidate contains nodes not reachable from its root");
    }

    const certificate = {
      schema: CERTIFICATE_SCHEMA,
      version: CERTIFICATE_VERSION,
      objective: "tsume-mate",
      rulesetId: candidate.rulesetId,
      verifierAbi: rules.verifierAbi,
      attackerSide: candidate.attackerSide,
      root: root,
      nodes: Object.fromEntries(Object.entries(outputNodes).sort(function (a, b) {
        return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
      })),
      provenance: candidate.provenance ? cloneCanonical(candidate.provenance) : { generator: "unspecified" }
    };

    const verification = await verifyCertificate(certificate, rules, options);
    if (!verification.ok) return { ok: false, code: verification.code, reason: verification.reason };
    return { ok: true, certificate: certificate, verification: verification };
  } catch (error) {
    return {
      ok: false,
      code: error.code || "EXTRACTION_ERROR",
      reason: error.message || String(error)
    };
  }
}
