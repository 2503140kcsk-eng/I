import { canonicalJson, hashCanonical } from "./canonical.mjs";

export const HISTORY_LEDGER_SCHEMA = "cfe.shogi.history-ledger";
export const HISTORY_LEDGER_VERSION = 1;
const SHA256_RE = /^[0-9a-f]{64}$/;
const LEDGER_FIELDS = "digest,events,initialSfen,rulesetId,schema,version";
const EVENT_FIELDS = "gaveCheck,move,mover,ply,resultingSfen";
const USI_MOVE_RE = /^(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])$/;
const MAX_HISTORY_EVENTS = 100000;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function parseSfenTurn(sfen, label) {
  if (typeof sfen !== "string" || sfen.length === 0 || sfen.length > 4096) {
    fail("INVALID_SFEN", label + " must be a non-empty SFEN string");
  }
  const fields = sfen.trim().split(/\s+/);
  if (fields.length !== 4 || !["b", "w"].includes(fields[1]) || !/^\d+$/.test(fields[3])) {
    fail("INVALID_SFEN", label + " must contain four standard SFEN fields");
  }
  return fields[1] === "b" ? "black" : "white";
}

function opposite(side) {
  return side === "black" ? "white" : "black";
}

function validateRulesetId(rulesetId) {
  if (typeof rulesetId !== "string" || rulesetId.length === 0 || rulesetId.length > 128) {
    fail("INVALID_RULESET_ID", "rulesetId must be a non-empty string of at most 128 characters");
  }
}

function genesisPayload(rulesetId, initialSfen) {
  return {
    schema: HISTORY_LEDGER_SCHEMA,
    version: HISTORY_LEDGER_VERSION,
    kind: "genesis",
    rulesetId: rulesetId,
    initialSfen: initialSfen
  };
}

function eventPayload(rulesetId, previousDigest, event) {
  return {
    schema: HISTORY_LEDGER_SCHEMA,
    version: HISTORY_LEDGER_VERSION,
    kind: "event",
    rulesetId: rulesetId,
    previousDigest: previousDigest,
    event: event
  };
}

/**
 * Creates an append-only hash-chain witness for the history used by a
 * repetition-sensitive proof state. Move legality is intentionally delegated
 * to a real shogi rules adapter.
 */
export async function createHistoryLedger({ rulesetId, initialSfen }) {
  validateRulesetId(rulesetId);
  parseSfenTurn(initialSfen, "initialSfen");
  return {
    schema: HISTORY_LEDGER_SCHEMA,
    version: HISTORY_LEDGER_VERSION,
    rulesetId: rulesetId,
    initialSfen: initialSfen,
    events: [],
    digest: await hashCanonical(genesisPayload(rulesetId, initialSfen))
  };
}

function validateEvent(event, expectedPly, expectedMover) {
  if (!isRecord(event) || Object.keys(event).sort().join(",") !== EVENT_FIELDS) {
    fail("INVALID_HISTORY_EVENT", "History event has missing or unknown fields");
  }
  if (event.ply !== expectedPly) fail("INVALID_HISTORY_PLY", "History event ply is not consecutive");
  if (event.mover !== expectedMover) fail("INVALID_HISTORY_MOVER", "History event mover does not match side to move");
  if (typeof event.move !== "string" || !USI_MOVE_RE.test(event.move)) {
    fail("INVALID_HISTORY_MOVE", "History event must contain one standard USI move token");
  }
  if (typeof event.gaveCheck !== "boolean") fail("INVALID_HISTORY_CHECK_FLAG", "gaveCheck must be boolean");
  const resultingTurn = parseSfenTurn(event.resultingSfen, "resultingSfen");
  if (resultingTurn !== opposite(expectedMover)) {
    fail("INVALID_HISTORY_TURN", "resulting SFEN must switch side to move after the recorded ply");
  }
  return {
    ply: event.ply,
    mover: event.mover,
    move: event.move,
    gaveCheck: event.gaveCheck,
    resultingSfen: event.resultingSfen
  };
}

export async function appendHistoryEvent(ledger, input) {
  if (!isRecord(input) || Object.keys(input).sort().join(",") !== "gaveCheck,move,mover,resultingSfen") {
    fail("INVALID_HISTORY_EVENT", "New history event has missing or unknown fields");
  }
  const before = await verifyHistoryLedger(ledger);
  if (!before.ok) fail("INVALID_HISTORY_LEDGER", before.reason);
  const event = validateEvent({
    ...input,
    ply: ledger.events.length + 1
  }, ledger.events.length + 1, before.sideToMove);
  const digest = await hashCanonical(eventPayload(ledger.rulesetId, ledger.digest, event));
  return {
    schema: ledger.schema,
    version: ledger.version,
    rulesetId: ledger.rulesetId,
    initialSfen: ledger.initialSfen,
    events: [...ledger.events, event],
    digest: digest
  };
}

export async function verifyHistoryLedger(ledger, options = {}) {
  try {
    if (!isRecord(options) || Object.keys(options).some((key) => key !== "maxEvents")) {
      fail("INVALID_OPTIONS", "History verification options may contain only maxEvents");
    }
    if (!isRecord(ledger) ||
        Object.keys(ledger).sort().join(",") !== LEDGER_FIELDS ||
        ledger.schema !== HISTORY_LEDGER_SCHEMA ||
        ledger.version !== HISTORY_LEDGER_VERSION) {
      fail("UNSUPPORTED_HISTORY_LEDGER", "Unsupported history ledger schema or version");
    }
    validateRulesetId(ledger.rulesetId);
    let sideToMove = parseSfenTurn(ledger.initialSfen, "initialSfen");
    if (!Array.isArray(ledger.events)) fail("INVALID_HISTORY_EVENTS", "events must be an array");
    const maxEvents = options.maxEvents === undefined ? 10000 : options.maxEvents;
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 0 || maxEvents > MAX_HISTORY_EVENTS) {
      fail("INVALID_LIMIT", "maxEvents must be an integer between 0 and " + MAX_HISTORY_EVENTS);
    }
    if (ledger.events.length > maxEvents) fail("HISTORY_LIMIT", "History exceeds the event limit");

    let digest = await hashCanonical(genesisPayload(ledger.rulesetId, ledger.initialSfen));
    for (let i = 0; i < ledger.events.length; i += 1) {
      const event = validateEvent(ledger.events[i], i + 1, sideToMove);
      digest = await hashCanonical(eventPayload(ledger.rulesetId, digest, event));
      sideToMove = opposite(sideToMove);
    }
    if (typeof ledger.digest !== "string" || !SHA256_RE.test(ledger.digest) ||
        digest !== ledger.digest) {
      fail("HISTORY_DIGEST_MISMATCH", "History hash chain does not match its contents");
    }
    return {
      ok: true,
      digest: digest,
      ply: ledger.events.length,
      sideToMove: sideToMove
    };
  } catch (error) {
    return {
      ok: false,
      code: error.code || "HISTORY_VERIFICATION_ERROR",
      reason: error.message || String(error)
    };
  }
}

export async function historyPositionKey({ rulesetId, sfen, historyDigest }) {
  validateRulesetId(rulesetId);
  parseSfenTurn(sfen, "sfen");
  if (typeof historyDigest !== "string" || !SHA256_RE.test(historyDigest)) {
    fail("INVALID_HISTORY_COMMITMENT", "historyDigest must be a lowercase SHA-256 digest");
  }
  return hashCanonical({
    schema: "cfe.shogi.history-position-key",
    version: 1,
    rulesetId: rulesetId,
    sfen: sfen,
    historyDigest: historyDigest
  });
}
