import { canonicalJson, hashCanonical } from "./canonical.mjs";
import { verifyHistoryLedger } from "./history.mjs";

export const CERTIFICATE_SCHEMA = "cfe.shogi.certificate";
export const CERTIFICATE_VERSION = 1;
export const NODE_SCHEMA = "cfe.shogi.proof-node";
export const VERIFIER_ABI = "cfe-verifier/1";

const HASH_RE = /^[0-9a-f]{64}$/;
const SIDE_VALUES = new Set(["b", "w"]);
const TERMINAL_STATUSES = new Set(["ongoing", "checkmate", "non-mate-terminal"]);
const TOP_LEVEL_FIELDS = "attackerSide,nodes,objective,provenance,root,rulesetId,schema,verifierAbi,version";

function reject(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertStateEnvelope(state, label, rules) {
  if (!isRecord(state)) reject("INVALID_STATE", label + " must be an object");
  if (typeof state.sfen !== "string" || state.sfen.length === 0) {
    reject("INVALID_STATE", label + ".sfen must be a non-empty string");
  }
  if (typeof state.historyDigest !== "string" || !HASH_RE.test(state.historyDigest)) {
    reject("MISSING_HISTORY_CONTEXT", label + ".historyDigest must be a lowercase SHA-256 digest");
  }
  if (!SIDE_VALUES.has(state.turn)) {
    reject("INVALID_STATE", label + ".turn must be the absolute side to move: b or w");
  }
}

async function verifyStateHistory(state, rules, label) {
  if (!state.historyLedger) {
    if (rules.allowOpaqueHistory === true) return;
    reject("HISTORY_WITNESS_REQUIRED", label + " has no replayable history ledger");
  }
  if (state.historyLedger.rulesetId !== rules.rulesetId) {
    reject("HISTORY_RULESET_MISMATCH", label + " history ledger ruleset differs from the verifier ruleset");
  }
  const checked = await verifyHistoryLedger(state.historyLedger);
  if (!checked.ok) {
    reject("INVALID_HISTORY_WITNESS", label + " history ledger failed: " + checked.reason);
  }
  if (checked.digest !== state.historyDigest) {
    reject("HISTORY_COMMITMENT_MISMATCH", label + " history ledger does not match historyDigest");
  }
  const finalSfen = state.historyLedger.events.length === 0
    ? state.historyLedger.initialSfen
    : state.historyLedger.events[state.historyLedger.events.length - 1].resultingSfen;
  if (finalSfen !== state.sfen) {
    reject("HISTORY_FINAL_STATE_MISMATCH", label + " history does not end at the declared SFEN");
  }
  const expectedTurn = checked.sideToMove === "black" ? "b" : "w";
  if (state.turn !== expectedTurn) {
    reject("HISTORY_TURN_MISMATCH", label + " history side-to-move differs from the declared turn");
  }
  if (rules.allowOpaqueHistory !== true) {
    let replayed;
    try {
      replayed = await rules.replayHistory(state.historyLedger);
    } catch (error) {
      reject("HISTORY_REPLAY_FAILED", label + " history replay failed: " + (error.message || String(error)));
    }
    const replayedState = await rules.canonicalState(replayed);
    if (canonicalJson(replayedState) !== canonicalJson(state)) {
      reject("HISTORY_REPLAY_MISMATCH", label + " replayed history does not reproduce the complete canonical state");
    }
  }
}

function assertMoveList(value, label) {
  if (!Array.isArray(value)) reject("INVALID_RULES_ADAPTER", label + " must return an array");
  const moves = value.map(function (move) {
    if (typeof move !== "string" || move.length === 0 || move.length > 32) {
      reject("INVALID_RULES_ADAPTER", label + " returned an invalid move");
    }
    return move;
  }).sort();
  if (new Set(moves).size !== moves.length) {
    reject("INVALID_RULES_ADAPTER", label + " returned duplicate moves");
  }
  return moves;
}

function assertRulesAdapter(rules) {
  const methods = [
    "decodeState", "canonicalState", "sideToMove", "legalCheckingMoves",
    "legalEvasions", "applyMove", "terminalStatus"
  ];
  if (!isRecord(rules) || typeof rules.rulesetId !== "string" ||
      rules.rulesetId.length === 0 || typeof rules.verifierAbi !== "string" ||
      rules.verifierAbi.length === 0) {
    reject("INVALID_RULES_ADAPTER", "rulesetId and verifierAbi are required");
  }
  for (const method of methods) {
    if (typeof rules[method] !== "function") {
      reject("INVALID_RULES_ADAPTER", "Missing rules adapter method: " + method);
    }
  }
  if (rules.allowOpaqueHistory !== true && typeof rules.replayHistory !== "function") {
    reject("INVALID_RULES_ADAPTER", "Production rules adapters must implement replayHistory");
  }
}

function validateLimit(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    reject("INVALID_LIMIT", label + " must be a positive safe integer no greater than " + maximum);
  }
  return value;
}

export async function computeNodeId(rulesetId, attackerSide, node) {
  const edges = node.edges.slice().sort(function (a, b) {
    return a.move < b.move ? -1 : a.move > b.move ? 1 : 0;
  });
  return hashCanonical({
    schema: NODE_SCHEMA,
    version: 1,
    rulesetId: rulesetId,
    attackerSide: attackerSide,
    state: node.state,
    kind: node.kind,
    edges: edges
  });
}

/**
 * Independently checks a finite AND/OR proof DAG for tsume-shogi mate.
 *
 * State.turn is the absolute SFEN side-to-move ("b" or "w"). The certificate
 * binds attackerSide; node roles are derived from those two values. A caller
 * MUST supply expectedRootState, so a valid proof for another position cannot
 * accidentally be accepted as proof for the current search root.
 *
 * The rules adapter must replay/validate history and return terminalStatus:
 * "ongoing", "checkmate", or "non-mate-terminal". Repetition, perpetual-check
 * adjudication, impasse, and other rule-decided outcomes belong in the last
 * category and cannot be used as a mate leaf.
 */
export async function verifyCertificate(certificate, rules, options = {}) {
  try {
    assertRulesAdapter(rules);
    if (!isRecord(options)) reject("INVALID_OPTIONS", "options must be a plain object");
    if (!Object.hasOwn(options, "expectedRootState") || !isRecord(options.expectedRootState)) {
      reject("ROOT_BINDING_REQUIRED", "expectedRootState is mandatory for proof acceptance");
    }

    const maxNodes = validateLimit(options.maxNodes === undefined ? 50000 : options.maxNodes, "maxNodes", 1000000);
    const maxDepth = validateLimit(options.maxDepth === undefined ? 512 : options.maxDepth, "maxDepth", 1024);
    const maxBytes = validateLimit(options.maxBytes === undefined ? 16 * 1024 * 1024 : options.maxBytes, "maxBytes", 64 * 1024 * 1024);
    const maxEdges = validateLimit(options.maxEdges === undefined ? 250000 : options.maxEdges, "maxEdges", 4000000);

    const serialized = canonicalJson(certificate);
    if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
      reject("CERTIFICATE_TOO_LARGE", "Certificate exceeds the byte limit");
    }
    if (!isRecord(certificate) ||
        Object.keys(certificate).sort().join(",") !== TOP_LEVEL_FIELDS ||
        certificate.schema !== CERTIFICATE_SCHEMA ||
        certificate.version !== CERTIFICATE_VERSION ||
        certificate.objective !== "tsume-mate") {
      reject("UNSUPPORTED_CERTIFICATE", "Unsupported certificate schema, version, objective, or top-level fields");
    }
    if (certificate.rulesetId !== rules.rulesetId) {
      reject("RULESET_MISMATCH", "Certificate and verifier ruleset IDs differ");
    }
    if (certificate.verifierAbi !== rules.verifierAbi) {
      reject("VERIFIER_ABI_MISMATCH", "Certificate requires a different verifier ABI");
    }
    if (!SIDE_VALUES.has(certificate.attackerSide)) {
      reject("INVALID_ATTACKER_SIDE", "attackerSide must be b or w");
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

    const decodeState = async function (state, label) {
      assertStateEnvelope(state, label, rules);
      await verifyStateHistory(state, rules, label);
      const position = await rules.decodeState(state);
      const canonical = await rules.canonicalState(position);
      if (canonicalJson(canonical) !== canonicalJson(state)) {
        reject("NON_CANONICAL_STATE", label + " is not in canonical state form");
      }
      const side = await rules.sideToMove(position);
      if (side !== state.turn || !SIDE_VALUES.has(side)) {
        reject("TURN_MISMATCH", label + " side-to-move does not match the rules adapter");
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

      if (await computeNodeId(certificate.rulesetId, certificate.attackerSide, node) !== id) {
        reject("NODE_HASH_MISMATCH", "Node " + id + " content hash is invalid");
      }

      active.add(id);
      visitedCount += 1;
      const position = await decodeState(node.state, "node " + id + " state");
      const side = node.state.turn;
      const role = side === certificate.attackerSide ? "attacker" : "defender";
      const terminal = await rules.terminalStatus(position);
      if (!TERMINAL_STATUSES.has(terminal)) {
        reject("INVALID_RULES_ADAPTER", "terminalStatus must return ongoing, checkmate, or non-mate-terminal");
      }

      if (node.kind === "TERMINAL_MATE") {
        if (role !== "defender" || terminal !== "checkmate" || node.edges.length !== 0) {
          reject("INVALID_TERMINAL", "Node " + id + " is not a terminal defender checkmate");
        }
      } else if (node.kind === "OR") {
        if (role !== "attacker" || terminal !== "ongoing") {
          reject("INVALID_OR_NODE", "Node " + id + " is not an ongoing attacker node");
        }
        if (node.edges.length === 0) reject("EMPTY_OR_NODE", "Node " + id + " has no proving move");
        const legal = assertMoveList(await rules.legalCheckingMoves(position), "legalCheckingMoves");
        for (const edge of node.edges) {
          if (!legal.includes(edge.move)) {
            reject("ILLEGAL_CHECKING_MOVE", "Move " + edge.move + " is not a legal check at node " + id);
          }
        }
      } else if (node.kind === "AND") {
        if (role !== "defender" || terminal !== "ongoing") {
          reject("INVALID_AND_NODE", "Node " + id + " is not an ongoing defender node");
        }
        const legal = assertMoveList(await rules.legalEvasions(position), "legalEvasions");
        if (legal.length === 0) {
          reject("UNCLASSIFIED_TERMINAL", "Node " + id + " has no legal evasion but is not terminal");
        }
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
    if (!root || !isRecord(root)) reject("MISSING_ROOT", "Root node is absent or malformed");
    assertStateEnvelope(root.state, "root state", rules);
    await verifyStateHistory(root.state, rules, "root state");
    if (root.state.turn !== certificate.attackerSide) {
      reject("ROOT_TURN_INVALID", "The attacker must be the side to move at the tsume root");
    }

    const expectedPosition = await decodeState(options.expectedRootState, "expected root state");
    const expected = await rules.canonicalState(expectedPosition);
    if (canonicalJson(expected) !== canonicalJson(root.state)) {
      reject("ROOT_STATE_MISMATCH", "Certificate root does not match the requested position and history");
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
      attackerSide: certificate.attackerSide,
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
