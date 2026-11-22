import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalJson,
  extractCertificate,
  createFootprint,
  matchFootprint,
  planTasks,
  verifyCertificate,
  VERIFIER_ABI,
  createHistoryLedger,
  appendHistoryEvent,
  verifyHistoryLedger,
  historyPositionKey
} from "../src/cfe/index.mjs";
import { parsePositionCommand, parseGoCommand, UsiProxyObserver } from "../src/cfe/usi-observer.mjs";

const historyDigest = function (digit) { return String(digit).repeat(64); };

function makeRules() {
  const transitions = new Map([
    ["root|A", "defender"],
    ["defender|e1", "attacker-1"],
    ["defender|e2", "attacker-2"],
    ["attacker-1|m1", "mate-1"],
    ["attacker-2|m2", "mate-2"]
  ]);
  const states = new Map([
    ["root", { sfen: "root position", historyDigest: historyDigest(1), turn: "b" }],
    ["defender", { sfen: "defender position", historyDigest: historyDigest(2), turn: "w" }],
    ["attacker-1", { sfen: "attacker branch 1", historyDigest: historyDigest(3), turn: "b" }],
    ["attacker-2", { sfen: "attacker branch 2", historyDigest: historyDigest(4), turn: "b" }],
    ["mate-1", { sfen: "mate position 1", historyDigest: historyDigest(5), turn: "w" }],
    ["mate-2", { sfen: "mate position 2", historyDigest: historyDigest(6), turn: "w" }]
  ]);

  const rules = {
    rulesetId: "test-tsume-v1",
    verifierAbi: VERIFIER_ABI,
    allowOpaqueHistory: true,
    decodeState: function (envelope) {
      const state = Array.from(states.values()).find(function (value) {
        return canonicalJson(value) === canonicalJson(envelope);
      });
      if (state) return state;
      if (envelope && envelope.sfen === "root position") return { ...envelope };
      throw new Error("Unknown test position");
    },
    canonicalState: function (state) { return { ...state }; },
    sideToMove: function (state) { return state.turn; },
    legalCheckingMoves: function (state) {
      if (state.sfen === "root position") return ["A", "unused-check"];
      if (state.sfen === "attacker branch 1") return ["m1"];
      if (state.sfen === "attacker branch 2") return ["m2"];
      return [];
    },
    legalEvasions: function (state) {
      return state.sfen === "defender position" ? ["e1", "e2"] : [];
    },
    applyMove: function (state, move) {
      let source = "unknown";
      if (state.sfen === "root position") source = "root";
      else if (state.sfen === "defender position") source = "defender";
      else if (state.sfen === "attacker branch 1") source = "attacker-1";
      else if (state.sfen === "attacker branch 2") source = "attacker-2";
      const next = transitions.get(source + "|" + move);
      if (!next) throw new Error("Illegal test move");
      return states.get(next);
    },
    terminalStatus: function (state) {
      return state.sfen.startsWith("mate position") ? "checkmate" : "ongoing";
    }
  };
  return { rules: rules, states: states };
}

function candidateFrom(states) {
  return {
    rulesetId: "test-tsume-v1",
    attackerSide: "b",
    root: "r",
    provenance: { generator: "test-fixture", search: "dfpn" },
    nodes: {
      r: { state: states.get("root"), kind: "OR", edges: [{ move: "A", to: "d" }] },
      d: {
        state: states.get("defender"),
        kind: "AND",
        edges: [{ move: "e1", to: "a1" }, { move: "e2", to: "a2" }]
      },
      a1: { state: states.get("attacker-1"), kind: "OR", edges: [{ move: "m1", to: "t1" }] },
      a2: { state: states.get("attacker-2"), kind: "OR", edges: [{ move: "m2", to: "t2" }] },
      t1: { state: states.get("mate-1"), kind: "TERMINAL_MATE", edges: [] },
      t2: { state: states.get("mate-2"), kind: "TERMINAL_MATE", edges: [] }
    }
  };
}




test("production verifier mode rejects an opaque digest without a history witness", async function () {
  const fixture = makeRules();
  const rules = { ...fixture.rules, allowOpaqueHistory: false };
  const result = await extractCertificate(candidateFrom(fixture.states), rules);
  assert.equal(result.ok, false);
  assert.equal(result.code, "HISTORY_WITNESS_REQUIRED");
});

test("production verifier mode rejects a history ledger with a mismatched root commitment", async function () {
  const initialSfen = "4k4/9/9/9/9/9/9/9/4K4 b - 1";
  const ledger = await createHistoryLedger({
    rulesetId: "test-real-history-v1",
    initialSfen: initialSfen
  });
  const fixture = makeRules();
  const state = {
    sfen: initialSfen,
    turn: "attacker",
    historyDigest: "0".repeat(64),
    historyLedger: ledger
  };
  const candidate = {
    rulesetId: fixture.rules.rulesetId,
    root: "r",
    nodes: { r: { state, kind: "OR", edges: [] } }
  };
  const rules = { ...fixture.rules, allowOpaqueHistory: false };
  const result = await extractCertificate(candidate, rules);
  assert.equal(result.ok, false);
  assert.equal(result.code, "HISTORY_COMMITMENT_MISMATCH");
});

test("history ledger commits to every move and resulting SFEN", async function () {
  const initialSfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
  let ledger = await createHistoryLedger({
    rulesetId: "standard-shogi-tsume-v1",
    initialSfen: initialSfen
  });
  ledger = await appendHistoryEvent(ledger, {
    move: "7g7f",
    mover: "black",
    gaveCheck: false,
    resultingSfen: "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL w - 2"
  });
  ledger = await appendHistoryEvent(ledger, {
    move: "3c3d",
    mover: "white",
    gaveCheck: false,
    resultingSfen: "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 3"
  });
  const verified = await verifyHistoryLedger(ledger);
  assert.equal(verified.ok, true);
  assert.equal(verified.ply, 2);
  assert.equal(verified.sideToMove, "black");
  assert.equal(verified.digest, ledger.digest);
});

test("history ledger rejects tampering and wrong mover order", async function () {
  const initialSfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
  const ledger = await createHistoryLedger({ rulesetId: "standard-shogi-v1", initialSfen });
  const valid = await appendHistoryEvent(ledger, {
    move: "7g7f",
    mover: "black",
    gaveCheck: false,
    resultingSfen: "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL w - 2"
  });
  const tampered = structuredClone(valid);
  tampered.events[0].move = "2g2f";
  assert.equal((await verifyHistoryLedger(tampered)).ok, false);
  await assert.rejects(appendHistoryEvent(ledger, {
    move: "3c3d",
    mover: "white",
    gaveCheck: false,
    resultingSfen: "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 3"
  }), /mover/);
});

test("position cache key includes ruleset and history digest", async function () {
  const state = {
    sfen: "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
    historyDigest: historyDigest(1)
  };
  const a = await historyPositionKey({
    rulesetId: "standard-shogi-v1",
    sfen: state.sfen,
    historyDigest: state.historyDigest
  });
  const b = await historyPositionKey({
    rulesetId: "standard-shogi-v1",
    sfen: state.sfen,
    historyDigest: historyDigest(2)
  });
  const c = await historyPositionKey({
    rulesetId: "other-rules-v1",
    sfen: state.sfen,
    historyDigest: state.historyDigest
  });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test("USI position parser handles startpos with a move history", function () {
  const parsed = parsePositionCommand("position startpos moves 7g7f 3c3d 2g2f");
  assert.equal(parsed.kind, "startpos");
  assert.deepEqual(parsed.moves, ["7g7f", "3c3d", "2g2f"]);
});

test("USI position parser preserves SFEN fields and drops", function () {
  const parsed = parsePositionCommand(
    "position sfen lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1 moves 7g7f P*5e"
  );
  assert.equal(parsed.kind, "sfen");
  assert.equal(parsed.sfen, "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1");
  assert.deepEqual(parsed.moves, ["7g7f", "P*5e"]);
});

test("USI go parser distinguishes mate search from ordinary search", function () {
  assert.equal(parseGoCommand("go mate").mode, "mate");
  assert.equal(parseGoCommand("go mate 5").parameters.mate, 5);
  const go = parseGoCommand("go btime 10000 wtime 9000 byoyomi 500");
  assert.equal(go.mode, "normal");
  assert.equal(go.parameters.btime, 10000);
  assert.equal(go.parameters.wtime, 9000);
  assert.equal(go.parameters.byoyomi, 500);
});

test("USI observer passes commands through and tracks position/search state", function () {
  const observer = new UsiProxyObserver();
  const position = observer.acceptGuiLine("position startpos moves 7g7f");
  assert.equal(position.forward, true);
  assert.equal(observer.snapshot().position.moves.length, 1);
  observer.acceptGuiLine("go mate");
  assert.equal(observer.snapshot().searching, true);
  assert.equal(observer.snapshot().activeSearch.mode, "mate");
  observer.acceptEngineLine("checkmate 3c3d 7g7f");
  assert.equal(observer.snapshot().mateClaim.status, "ENGINE_CLAIM_ONLY");
  assert.equal(observer.snapshot().mateClaim.proofVerified, false);
  observer.acceptEngineLine("bestmove resign");
  assert.equal(observer.snapshot().searching, false);
});

test("USI observer treats timeout and nomate as engine reports, not certificates", function () {
  const observer = new UsiProxyObserver();
  observer.acceptGuiLine("go mate");
  observer.acceptEngineLine("checkmate timeout");
  assert.equal(observer.snapshot().mateClaim.status, "INCOMPLETE");
  assert.equal(observer.snapshot().mateClaim.proofVerified, false);
  observer.acceptEngineLine("checkmate nomate");
  assert.equal(observer.snapshot().mateClaim.status, "ENGINE_REPORT_NO_MATE");
  assert.equal(observer.snapshot().mateClaim.proofVerified, false);
});

test("canonical JSON ignores object insertion order and rejects unsafe values", function () {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.throws(function () { canonicalJson({ value: Number.NaN }); }, /Non-finite/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(function () { canonicalJson(cyclic); }, /Cycle/);
});

test("extractor builds and verifies a complete AND/OR mate DAG", async function () {
  const fixture = makeRules();
  const result = await extractCertificate(candidateFrom(fixture.states), fixture.rules, { expectedRootState: fixture.states.get("root") });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.verification.code, "VERIFIED_MATE");
  assert.equal(result.verification.nodeCount, 6);
});

test("verifier rejects an omitted defender evasion", async function () {
  const fixture = makeRules();
  const candidate = candidateFrom(fixture.states);
  candidate.nodes.d.edges.pop();
  delete candidate.nodes.a2;
  delete candidate.nodes.t2;
  const result = await extractCertificate(candidate, fixture.rules, { expectedRootState: fixture.states.get("root") });
  assert.equal(result.ok, false);
  assert.equal(result.code, "INCOMPLETE_DEFENDER_COVERAGE");
});

test("verifier rejects a wrong child state", async function () {
  const fixture = makeRules();
  const candidate = candidateFrom(fixture.states);
  candidate.nodes.r.edges[0].to = "a1";
  const result = await extractCertificate(candidate, fixture.rules, { expectedRootState: fixture.states.get("root") });
  assert.equal(result.ok, false);
});

test("verifier checks complete history context at the root", async function () {
  const fixture = makeRules();
  const extracted = await extractCertificate(candidateFrom(fixture.states), fixture.rules, { expectedRootState: fixture.states.get("root") });
  assert.equal(extracted.ok, true);
  const otherHistory = { ...fixture.states.get("root"), historyDigest: historyDigest("f") };
  const result = await verifyCertificate(extracted.certificate, fixture.rules, {
    expectedRootState: otherHistory
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "ROOT_STATE_MISMATCH");
});

test("extractor rejects cycles in the proof DAG", async function () {
  const fixture = makeRules();
  const candidate = candidateFrom(fixture.states);
  candidate.nodes.a1.edges[0] = { move: "m1", to: "r" };
  const result = await extractCertificate(candidate, fixture.rules, { expectedRootState: fixture.states.get("root") });
  assert.equal(result.ok, false);
  assert.equal(result.code, "CYCLE_DETECTED");
});

test("verifier rejects malformed terminal nodes", async function () {
  const fixture = makeRules();
  const candidate = candidateFrom(fixture.states);
  candidate.nodes.t1.kind = "OR";
  candidate.nodes.t1.edges = [{ move: "bogus", to: "t1" }];
  const result = await extractCertificate(candidate, fixture.rules, { expectedRootState: fixture.states.get("root") });
  assert.equal(result.ok, false);
});

test("exact footprint matches remain candidates and require verification", async function () {
  const fixture = makeRules();
  const result = await extractCertificate(candidateFrom(fixture.states), fixture.rules, { expectedRootState: fixture.states.get("root") });
  assert.equal(result.ok, true);
  const footprint = createFootprint(result.certificate, { materialClass: "fixture-A", phase: 1 });
  const exact = matchFootprint(footprint, {
    rulesetId: fixture.rules.rulesetId,
    verifierAbi: fixture.rules.verifierAbi,
    attackerSide: "b",
    state: fixture.states.get("root"),
    features: { materialClass: "fixture-A", phase: 1 }
  });
  assert.equal(exact.decision, "EXACT_CANDIDATE");
  assert.equal(exact.canAcceptAsProof, false);
  assert.equal(exact.requiresVerification, true);
});

test("condition-cube hits on a different state are retrieval hints only", async function () {
  const fixture = makeRules();
  const result = await extractCertificate(candidateFrom(fixture.states), fixture.rules, { expectedRootState: fixture.states.get("root") });
  const footprint = createFootprint(result.certificate, { materialClass: "fixture-A" });
  const abstract = matchFootprint(footprint, {
    rulesetId: fixture.rules.rulesetId,
    verifierAbi: fixture.rules.verifierAbi,
    attackerSide: "b",
    state: { sfen: "other position", historyDigest: historyDigest("e"), turn: "b" },
    features: { materialClass: "fixture-A" }
  });
  assert.equal(abstract.decision, "ABSTRACT_CANDIDATE");
  assert.equal(abstract.canAcceptAsProof, false);
});

test("footprint refuses reuse across rulesets", function () {
  const certificate = {
    schema: "cfe.shogi.certificate",
    version: 1,
    root: "root-id",
    rulesetId: "rules-v1",
    verifierAbi: VERIFIER_ABI,
    attackerSide: "b",
    nodes: {
      "root-id": { state: { sfen: "sfen", historyDigest: historyDigest("a"), turn: "b" } }
    }
  };
  const footprint = createFootprint(certificate);
  const result = matchFootprint(footprint, {
    rulesetId: "other-rules",
    verifierAbi: VERIFIER_ABI,
    state: footprint.rootState
  });
  assert.equal(result.decision, "MISS");
});


test("an empty condition cube is not a universal footprint hit", function () {
  const certificate = {
    schema: "cfe.shogi.certificate",
    version: 1,
    root: "root-id",
    rulesetId: "rules-v1",
    verifierAbi: VERIFIER_ABI,
    attackerSide: "b",
    nodes: {
      "root-id": { state: { sfen: "sfen", historyDigest: historyDigest("a"), turn: "b" } }
    }
  };
  const footprint = createFootprint(certificate);
  const result = matchFootprint(footprint, {
    rulesetId: "rules-v1",
    verifierAbi: VERIFIER_ABI,
    attackerSide: "b",
    state: { sfen: "different", historyDigest: "other", turn: "b" },
    features: {}
  });
  assert.equal(result.decision, "MISS");
});

test("Governor schedules verification ahead of lower-value search", function () {
  const result = planTasks([
    { id: "deep-search", kind: "normal_search", expectedValue: 0.9, confidence: 0.9,
      cpuMs: 80, gpuMs: 0, memoryBytes: 1024, heatDeltaC: 1 },
    { id: "verify", kind: "verify_certificate", expectedValue: 0.2, confidence: 1,
      cpuMs: 20, gpuMs: 0, memoryBytes: 1024, heatDeltaC: 0 }
  ], {
    cpuMs: 100, gpuMs: 0, memoryBytes: 4096,
    currentTemperatureC: 30, maxTemperatureC: 40
  });
  assert.equal(result.selected[0].id, "verify");
  assert.equal(result.verificationBlocked, false);
  assert.equal(result.verificationScheduled, true);
  assert.equal(result.proofAcceptanceAllowed, false);
});

test("Governor blocks proof acceptance when verification exceeds budget", function () {
  const result = planTasks([
    { id: "verify", kind: "verify_certificate", expectedValue: 1, confidence: 1,
      cpuMs: 40, gpuMs: 0, memoryBytes: 1024, heatDeltaC: 0 }
  ], {
    cpuMs: 10, gpuMs: 0, memoryBytes: 4096,
    currentTemperatureC: 30, maxTemperatureC: 40
  });
  assert.equal(result.verificationBlocked, true);
  assert.equal(result.verificationScheduled, false);
  assert.equal(result.proofAcceptanceAllowed, false);
  assert.equal(result.deferred[0].reason, "resource-budget");
});

test("Governor enforces thermal limits", function () {
  const result = planTasks([
    { id: "gpu", kind: "neural_inference", expectedValue: 0.8, confidence: 0.9,
      cpuMs: 1, gpuMs: 10, memoryBytes: 1000, heatDeltaC: 3 }
  ], {
    cpuMs: 100, gpuMs: 100, memoryBytes: 10000,
    currentTemperatureC: 39, maxTemperatureC: 40
  });
  assert.equal(result.selected.length, 0);
  assert.equal(result.deferred[0].reason, "thermal-budget");
});

test("extractor rejects unreachable candidate nodes", async function () {
  const fixture = makeRules();
  const candidate = candidateFrom(fixture.states);
  candidate.nodes.unused = { state: fixture.states.get("root"), kind: "OR", edges: [] };
  const result = await extractCertificate(candidate, fixture.rules, { expectedRootState: fixture.states.get("root") });
  assert.equal(result.ok, false);
  assert.equal(result.code, "UNREACHABLE_INPUT_NODES");
});

test("verifier requires an explicit target root before accepting a proof", async function () {
  const fixture = makeRules();
  const candidate = candidateFrom(fixture.states);
  const extracted = await extractCertificate(candidate, fixture.rules, {
    expectedRootState: fixture.states.get("root")
  });
  assert.equal(extracted.ok, true);
  const unbound = await verifyCertificate(extracted.certificate, fixture.rules);
  assert.equal(unbound.ok, false);
  assert.equal(unbound.code, "ROOT_BINDING_REQUIRED");
});

test("verifier rejects a root bound to the wrong attacker side", async function () {
  const fixture = makeRules();
  const candidate = candidateFrom(fixture.states);
  candidate.attackerSide = "w";
  const result = await extractCertificate(candidate, fixture.rules, {
    expectedRootState: fixture.states.get("root")
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "ROOT_TURN_INVALID");
});

test("verifier rejects a rule-decided repetition or draw as a mate leaf", async function () {
  const fixture = makeRules();
  const candidate = candidateFrom(fixture.states);
  const base = fixture.rules.terminalStatus;
  fixture.rules.terminalStatus = function (state) {
    if (state.sfen === "mate position 1") return "non-mate-terminal";
    return base(state);
  };
  const result = await extractCertificate(candidate, fixture.rules, {
    expectedRootState: fixture.states.get("root")
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_TERMINAL");
});

test("verifier rejects unknown terminal statuses from an adapter", async function () {
  const fixture = makeRules();
  const candidate = candidateFrom(fixture.states);
  fixture.rules.terminalStatus = function () { return "maybe-mate"; };
  const result = await extractCertificate(candidate, fixture.rules, {
    expectedRootState: fixture.states.get("root")
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_RULES_ADAPTER");
});
