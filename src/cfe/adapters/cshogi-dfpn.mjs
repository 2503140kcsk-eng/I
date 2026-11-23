import { cloneCanonical } from "../canonical.mjs";

export const CSHOGI_DFPN_EXPORT_SCHEMA = "cfe.cshogi.dfpn-export";
export const CSHOGI_DFPN_EXPORT_VERSION = 1;
export const CSHOGI_AUDITED_COMMIT = "26889135717af0a08def9663bb73f1abe5263c66";
// Upstream dfpn.cpp: REPEAT = UINT_MAX - 1. This marks path/history- or
// horizon-dependent results and is never admissible as a finite proof node.
export const CSHOGI_REPEAT_SENTINEL = 4294967294;

const HAND_KEYS = ["P", "L", "N", "S", "G", "B", "R"];
const HAND_MAX = {
  P: 18,
  L: 4,
  N: 4,
  S: 4,
  G: 4,
  B: 2,
  R: 2
};

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, keys, label) {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== keys.slice().sort().join(",")) {
    fail("INVALID_CSHOGI_EXPORT", label + " has missing or unknown fields");
  }
}

function normalizeHand(hand, label) {
  exactKeys(hand, HAND_KEYS, label);
  const out = {};
  for (const key of HAND_KEYS) {
    const count = hand[key];
    if (!Number.isSafeInteger(count) || count < 0 || count > HAND_MAX[key]) {
      fail("INVALID_PROOF_PIECES", label + "." + key + " is outside the Shogi piece-count range");
    }
    out[key] = count;
  }
  return out;
}

function componentwiseAtLeast(left, right) {
  return HAND_KEYS.every((key) => left[key] >= right[key]);
}

function equalHands(left, right) {
  return HAND_KEYS.every((key) => left[key] === right[key]);
}

/**
 * Compares the hand-dominance directions used by cshogi's DFPN transposition
 * lookup. The result is only a search/retrieval candidate, never a proof.
 *
 * For a proved entry (pn === 0), cshogi reuses it when the requested hand is
 * equal or superior to the stored proof-piece bound.
 * For a disproved entry (dn === 0), cshogi reuses it when the stored
 * disproof-piece bound is equal or superior to the requested hand.
 */
export function compareCshogiHandDominance({ boundKind, stored, requested }) {
  if (!["proof", "disproof"].includes(boundKind)) {
    throw new TypeError("boundKind must be proof or disproof");
  }
  const storedHand = normalizeHand(stored, "stored");
  const requestedHand = normalizeHand(requested, "requested");
  const equal = equalHands(storedHand, requestedHand);

  const applies = boundKind === "proof"
    ? componentwiseAtLeast(requestedHand, storedHand)
    : componentwiseAtLeast(storedHand, requestedHand);

  return {
    boundKind: boundKind,
    relation: equal ? "EQUIVALENT" : applies ? "DOMINATES" : "INCOMPARABLE",
    reuseCandidate: applies,
    stored: storedHand,
    requested: requestedHand,
    proofTransferAllowed: false,
    requiresIndependentVerification: true
  };
}

/**
 * Imports a proposed instrumented-cshogi export into the generic CFE candidate
 * shape. Upstream cshogi does not currently expose this graph: get_pv() is a
 * linear move list. This adapter defines the input contract for a future
 * instrumented fork and deliberately preserves PN/DN/ProofPieces only as
 * diagnostic metadata.
 */
export function importCshogiDfpnExport(source) {
  try {
    exactKeys(
      source,
      ["schema", "version", "engine", "rulesetId", "attackerSide", "root", "search", "nodes"],
      "export"
    );
    if (source.schema !== CSHOGI_DFPN_EXPORT_SCHEMA ||
        source.version !== CSHOGI_DFPN_EXPORT_VERSION) {
      fail("UNSUPPORTED_CSHOGI_EXPORT", "Unsupported cshogi DFPN export schema or version");
    }
    exactKeys(source.engine, ["name", "commit"], "engine");
    if (source.engine.name !== "cshogi" ||
        typeof source.engine.commit !== "string" ||
        !/^[0-9a-f]{40}$/.test(source.engine.commit)) {
      fail("INVALID_CSHOGI_ENGINE", "Engine identity must include cshogi and a full Git commit SHA");
    }
    if (typeof source.rulesetId !== "string" || source.rulesetId.length === 0 ||
        !["b", "w"].includes(source.attackerSide) ||
        typeof source.root !== "string" || !source.root ||
        !isRecord(source.nodes)) {
      fail("INVALID_CSHOGI_EXPORT", "Missing ruleset, attacker side, root or node table");
    }
    exactKeys(source.search, ["maxDepth", "maxSearchNodes", "searchedNodes"], "search");
    for (const key of ["maxDepth", "maxSearchNodes", "searchedNodes"]) {
      if (!Number.isSafeInteger(source.search[key]) || source.search[key] < 0) {
        fail("INVALID_CSHOGI_EXPORT", "search." + key + " must be a non-negative safe integer");
      }
    }

    const labels = Object.keys(source.nodes);
    if (labels.length === 0 || labels.length > 50000 || !Object.hasOwn(source.nodes, source.root)) {
      fail("INVALID_CSHOGI_EXPORT", "Node table is empty, too large, or missing the root");
    }

    const nodes = Object.create(null);
    const diagnostics = Object.create(null);
    for (const label of labels) {
      const raw = source.nodes[label];
      exactKeys(
        raw,
        ["state", "kind", "pn", "dn", "gamePly", "numSearched", "proofPieces", "edges"],
        "node " + label
      );
      if (!isRecord(raw.state) ||
          typeof raw.state.sfen !== "string" ||
          typeof raw.state.historyDigest !== "string" ||
          !["b", "w"].includes(raw.state.turn)) {
        fail("INVALID_CSHOGI_STATE", "node " + label + " has an invalid CFE state envelope");
      }
      if (!["OR", "AND", "TERMINAL_MATE"].includes(raw.kind)) {
        fail("INVALID_CSHOGI_NODE", "node " + label + " has an unsupported proof role");
      }
      if (!Number.isSafeInteger(raw.pn) || raw.pn < 0 ||
          !Number.isSafeInteger(raw.dn) || raw.dn < 0 ||
          !Number.isSafeInteger(raw.gamePly) || raw.gamePly < 0 ||
          !Number.isSafeInteger(raw.numSearched) || raw.numSearched < 0) {
        fail("INVALID_CSHOGI_NODE", "node " + label + " has an invalid DFPN metric");
      }
      if (raw.pn !== 0 || raw.dn === 0) {
        fail("UNPROVEN_CSHOGI_NODE", "node " + label + " is not recorded as a solved proof node (pn=0, dn>0)");
      }
      if (raw.numSearched === CSHOGI_REPEAT_SENTINEL) {
        fail(
          "PATH_DEPENDENT_CSHOGI_NODE",
          "node " + label + " carries cshogi's REPEAT sentinel and cannot support a finite mate certificate"
        );
      }
      if (!Array.isArray(raw.edges)) {
        fail("INVALID_CSHOGI_NODE", "node " + label + " edges must be an array");
      }
      const edges = raw.edges.map((edge, index) => {
        exactKeys(edge, ["move", "to"], "node " + label + " edge " + index);
        if (typeof edge.move !== "string" || edge.move.length === 0 || edge.move.length > 16 ||
            typeof edge.to !== "string" || !Object.hasOwn(source.nodes, edge.to)) {
          fail("INVALID_CSHOGI_EDGE", "node " + label + " has an invalid edge");
        }
        return { move: edge.move, to: edge.to };
      });
      edges.sort((a, b) => a.move < b.move ? -1 : a.move > b.move ? 1 : 0);
      for (let i = 1; i < edges.length; i += 1) {
        if (edges[i - 1].move === edges[i].move) {
          fail("DUPLICATE_CSHOGI_EDGE", "node " + label + " repeats a move");
        }
      }

      nodes[label] = {
        state: cloneCanonical(raw.state),
        kind: raw.kind,
        edges: edges
      };
      diagnostics[label] = {
        pn: raw.pn,
        dn: raw.dn,
        gamePly: raw.gamePly,
        numSearched: raw.numSearched,
        proofPieces: normalizeHand(raw.proofPieces, "node " + label + ".proofPieces")
      };
    }

    const candidate = {
      rulesetId: source.rulesetId,
      attackerSide: source.attackerSide,
      root: source.root,
      nodes: nodes,
      provenance: {
        generator: "cshogi-dfpn-export/1",
        engine: cloneCanonical(source.engine),
        search: cloneCanonical(source.search),
        proofNumberSemantics: "diagnostic-only",
        proofPiecesSemantics: "diagnostic-only"
      }
    };
    return {
      ok: true,
      candidate: candidate,
      diagnostics: {
        schema: "cfe.cshogi.dfpn-diagnostics",
        version: 1,
        engineCommit: source.engine.commit,
        search: cloneCanonical(source.search),
        nodes: diagnostics
      }
    };
  } catch (error) {
    return {
      ok: false,
      code: error.code || "CSHOGI_IMPORT_ERROR",
      reason: error.message || String(error)
    };
  }
}


// Backward-compatible name retained for existing experiments. The function
// compares only the seven-component hand partial order; it is not a complete
// transposition-table reuse predicate.
export const compareCshogiProofPieces = compareCshogiHandDominance;
