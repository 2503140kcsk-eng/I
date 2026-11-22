import { canonicalJson, hashCanonical } from "./canonical.mjs";

export const CERTIFICATE_SCHEMA = "cfe.shogi.certificate";
export const CERTIFICATE_VERSION = 1;
export const NODE_SCHEMA = "cfe.shogi.proof-node";
export const VERIFIER_ABI = "cfe-verifier/1";

const HASH_RE = /^[0-9a-f]{64}$/;
const TURN_VALUES = new Set(["attacker", "defender"]);

function reject(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertStateEnvelope(state, label) {
  if (!isRecord(state)) reject("INVALID_STATE", label + " must be an object");
  if (typeof state.sfen !== "string" || state.sfen.length === 0) {
    reject("INVALID_STATE", label + ".sfen must be a non-empty string");
  }
  if (typeof state.historyDigest !== "string" || !HASH_RE.test(state.historyDigest)) {
    reject("INVALID_HISTORY_COMMITMENT", label + ".historyDigest must be a lowercase SHA-256 digest");
  }
  if (!TURN_VALUES.has(state.turn)) reject("INVALID_STATE", label + ".turn must be attacker or defender");
}

function assertMoveList(value, label) {
  if (!Array.isArray(value)) reject("INVALID_RULES_ADAPTER", label + " must return an array");
  const moves = value.map(function (move) {
    if (typeof move !== "string" || move.length === 0 || move.length > 32) {
      reject("INVALID_RULES_ADAPTER", label + " returned an invalid move");
    }
    return move;
  }).sort();
  if (new Set(moves).size !== moves.length) reject("INVALID_RULES_ADAPTER", label + " returned duplicate moves");
  return moves;
}

function assertRulesAdapter(rules) {
  const methods = [
    "decodeState", "canonicalState", "sideToMove", "legalCheckingMoves",
    "legalEvasions", "applyMove", "isCheckmate"
  ];
  if (!isRecord(rules) || typeof rules.rulesetId !== "string" ||
      typeof rules.verifierAbi !== "string") {
    reject("INVALID_RULES_ADAPTER", "rulesetId and verifierAbi are required");
  }
  for (const method of methods) {
    if (typeof rules[method] !== "function") {
      reject("INVALID_RULES_ADAPTER", "Missing rules adapter method: " + method);
    }
  }
}

export async function computeNodeId(rulesetId, node) {
  const edges = node.edges.slice().sort(function (a, b) {
    return a.move.localeCompare(b.move);
  });
  return hashCanonical({
    schema: NODE_SCHEMA,
    version: 1,
    rulesetId: rulesetId,
    state: node.state,
    kind: node.kind,
    edges: edges
  });
}

/**
 * Independently checks a finite AND/OR proof DAG for tsume-shogi mate.
 * Attacker nodes are OR nodes over legal checking moves. Defender nodes are
 * AND nodes over every legal evasion. Terminal nodes require independent mate
 * recognition by the rules adapter.
 */
export async function verifyCertificate(certificate, rules, options = {}) {
  try {
    assertRulesAdapter(rules);
    const maxNodes = options.maxNodes === undefined ? 50000 : options.maxNodes;
    const maxDepth = options.maxDepth === undefined ? 512 : options.maxDepth;
    const maxBytes = options.maxBytes === undefined ? 16 * 1024 * 1024 : options.maxBytes;
    const maxEdges = options.maxEdges === undefined ? 250000 : options.maxEdges;

    const serialized = canonicalJson(certificate);
    if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
      reject("CERTIFICATE_TOO_LARGE", "Certificate exceeds the byte limit");
    }
    if (!isRecord(certificate) ||
        certificate.schema !== CERTIFICATE_SCHEMA ||
        certificate.version !== CERTIFICATE_VERSION ||
        certificate.objective !== "tsume-mate") {
      reject("UNSUPPORTED_CERTIFICATE", "Unsupported certificate schema, version, or objective");
    }
    if (certificate.rulesetId !== rules.rulesetId) {
      reject("RULESET_MISMATCH", "Certificate and verifier ruleset IDs differ");
    }
    if (certificate.verifierAbi !== rules.verifierAbi) {
      reject("VERIFIER_ABI_MISMATCH", "Certificate requires a different verifier ABI");
    }
    if (!HASH_RE.test(certificate.root)) reject("INVALID_ROOT", "Root must be a lowercase SHA-256 digest");
    if (!isRecord(certificate.nodes)) reject("INVALID_NODE_TABLE", "nodes must be an object keyed by node digest");

    const nodeIds = Object.keys(certificate.nodes);
    if (nodeIds.length === 0 || nodeIds.length > maxNodes) {
      reject("NODE_LIMIT", "Certificate has no nodes or exceeds the node limit");
    }
    for (const id of nodeIds) {
      if (!HASH_RE.test(id)) reject("INVALID_NODE_ID", "Node table contains a malformed digest");
    }
    if (!Object.hasOwn(certificate.nodes, certificate.root)) reject("MISSING_ROOT", "Root node is absent");

    const active = new Set();
    const complete = new Set();
    let visitedCount = 0;
    let edgeCount = 0;

    const decodeState = async function (node, id) {
      assertStateEnvelope(node.state, "node " + id + " state");
      const position = await rules.decodeState(node.state);
      const canonical = await rules.canonicalState(position);
      if (canonicalJson(canonical) !== canonicalJson(node.state)) {
        reject("NON_CANONICAL_STATE", "Node " + id + " is not in canonical state form");
      }
      const side = await rules.sideToMove(position);
      if (side !== node.state.turn || !TURN_VALUES.has(side)) {
        reject("TURN_MISMATCH", "Node " + id + " turn does not match the rules adapter");
      }
      return position;
    };

    const visit = async function (id, depth) {
      if (depth > maxDepth) reject("DEPTH_LIMIT", "Proof DAG exceeds the depth limit");
      if (active.has(id)) reject("CYCLE_DETECTED", "A proof cycle cannot establish finite mate");
      if (complete.has(id)) return;

      const node = certificate.nodes[id];
      if (!isRecord(node)) reject("INVALID_NODE", "Node " + id + " must be an object");
      if (Object.keys(node).sort().join(",") !== "edges,kind,state") {
        reject("INVALID_NODE", "Node " + id + " has missing or unknown fields");
      }
      if (!Array.isArray(node.edges)) reject("INVALID_EDGES", "Node " + id + " edges must be an array");
      edgeCount += node.edges.length;
      if (edgeCount > maxEdges) reject("EDGE_LIMIT", "Certificate exceeds the edge limit");

      let previousMove = null;
      for (const edge of node.edges) {
        if (!isRecord(edge) || Object.keys(edge).sort().join(",") !== "move,to") {
          reject("INVALID_EDGE", "Node " + id + " contains an invalid edge");
        }
        if (typeof edge.move !== "string" || edge.move.length === 0 || !HASH_RE.test(edge.to)) {
          reject("INVALID_EDGE", "Node " + id + " contains a malformed edge");
        }
        if (previousMove !== null && previousMove >= edge.move) {
          reject("NON_CANONICAL_EDGES", "Node " + id + " edges must be sorted and unique");
        }
        previousMove = edge.move;
      }

      if (await computeNodeId(certificate.rulesetId, node) !== id) {
        reject("NODE_HASH_MISMATCH", "Node " + id + " content hash is invalid");
      }

      active.add(id);
      visitedCount += 1;
      const position = await decodeState(node, id);
      const turn = node.state.turn;
      const checkmate = Boolean(await rules.isCheckmate(position));

      if (node.kind === "TERMINAL_MATE") {
        if (turn !== "defender" || !checkmate || node.edges.length !== 0) {
          reject("INVALID_TERMINAL", "Node " + id + " is not a terminal defender checkmate");
        }
      } else if (node.kind === "OR") {
        if (turn !== "attacker" || checkmate) reject("INVALID_OR_NODE", "Node " + id + " is not a live attacker node");
        if (node.edges.length === 0) reject("EMPTY_OR_NODE", "Node " + id + " has no proving move");
        const legal = assertMoveList(await rules.legalCheckingMoves(position), "legalCheckingMoves");
        for (const edge of node.edges) {
          if (!legal.includes(edge.move)) {
            reject("ILLEGAL_CHECKING_MOVE", "Move " + edge.move + " is not a legal check at node " + id);
          }
        }
      } else if (node.kind === "AND") {
        if (turn !== "defender" || checkmate) reject("INVALID_AND_NODE", "Node " + id + " is not a live defender node");
        const legal = assertMoveList(await rules.legalEvasions(position), "legalEvasions");
        if (legal.length === 0) reject("UNCLASSIFIED_TERMINAL", "Node " + id + " has no legal evasion but is not terminal mate");
        const certified = node.edges.map(function (edge) { return edge.move; });
        if (canonicalJson(legal) !== canonicalJson(certified)) {
          reject("INCOMPLETE_DEFENDER_COVERAGE", "Node " + id + " does not cover every legal defender evasion");
        }
      } else {
        reject("INVALID_NODE_KIND", "Node " + id + " has an unknown kind");
      }

      for (const edge of node.edges) {
        const child = certificate.nodes[edge.to];
        if (!child) reject("MISSING_CHILD", "Node " + id + " references absent child " + edge.to);
        const nextPosition = await rules.applyMove(position, edge.move);
        const nextState = await rules.canonicalState(nextPosition);
        if (canonicalJson(nextState) !== canonicalJson(child.state)) {
          reject("CHILD_STATE_MISMATCH", "Edge " + edge.move + " does not lead to child " + edge.to);
        }
        await visit(edge.to, depth + 1);
      }

      active.delete(id);
      complete.add(id);
    };

    const root = certificate.nodes[certificate.root];
    assertStateEnvelope(root.state, "root state");
    if (root.state.turn !== "attacker") reject("ROOT_TURN_INVALID", "A tsume-mate proof must start with the attacker to move");

    if (options.expectedRootState) {
      const expectedPosition = await rules.decodeState(options.expectedRootState);
      const expected = await rules.canonicalState(expectedPosition);
      if (canonicalJson(expected) !== canonicalJson(root.state)) {
        reject("ROOT_STATE_MISMATCH", "Certificate root does not match the requested position and history");
      }
    }

    await visit(certificate.root, 0);
    if (complete.size !== nodeIds.length || visitedCount !== nodeIds.length) {
      reject("UNREACHABLE_NODES", "Certificate contains nodes not reachable from its root");
    }
    return {
      ok: true,
      code: "VERIFIED_MATE",
      root: certificate.root,
      nodeCount: visitedCount,
      rulesetId: certificate.rulesetId,
      verifierAbi: certificate.verifierAbi
    };
  } catch (error) {
    return {
      ok: false,
      code: error.code || "VERIFICATION_ERROR",
      reason: error.message || String(error)
    };
  }
}
