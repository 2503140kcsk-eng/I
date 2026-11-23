# CFE Shogi

CFE Shogi is an open-source research prototype for **proof-carrying shogi search**.
It separates heuristic move selection from independently checkable mate evidence.

## Implemented reference core

- **Canonical certificate format** — deterministic JSON, SHA-256 content
  addressing, version/ruleset/verifier-ABI gates and absolute attacker color.
- **Certificate Extractor** — converts an untrusted, labelled finite AND/OR DAG
  into a content-addressed certificate; the target root must be supplied
  separately and the candidate must pass verification before it is returned.
- **Certificate Verifier** — checks proof-DAG hashes and structure, attacker
  checking moves, complete defender-evasion coverage, exact child states,
  terminal status, history commitments, cycle freedom and resource limits
  through a rules adapter.
- **Footprint Matcher** — exact matches remain verification candidates;
  non-empty feature-cube hits on different states are retrieval hints only.
  An empty cube never matches every position.
- **Governor** — prioritizes verification against CPU/GPU/memory/thermal
  budgets. Scheduling never authorizes proof acceptance.
- **History ledger** — hash-chains the initial SFEN and each recorded ply, and
  binds cache identity to ruleset + SFEN + history digest. Every production
  proof state carries its ledger; the verifier recomputes the chain and calls
  the rules adapter's `replayHistory(ledger)` for independent legal replay.
- **USI observer** — parses common position/go commands and labels a
  YaneuraOu checkmate PV as `ENGINE_CLAIM_ONLY`, never as a certificate.

## Current trust boundary

The rules adapter is currently a **synthetic test fixture**, not a complete
implementation of Japanese shogi. The history ledger provides tamper-evident
commitments, not proof that each move was legal. A production verifier must
replay the committed game history, independently recompute every successor
position/check flag, and adjudicate repetition, perpetual check, pawn-drop mate
and the chosen ruleset's other terminal conditions.

Production adapters must implement `replayHistory(ledger)` and return the
canonical position reached by replay. `allowOpaqueHistory: true` is reserved
for synthetic test adapters and must never be enabled in production.

The repository does not yet contain a production Shogi rules verifier, an
actual DFPN proof-DAG exporter, a YaneuraOu process supervisor, a native mobile
application, a WebAssembly verifier build, or a deployed online service.

No evaluation score, principal variation, DFPN proof/disproof number, neural
output or condition-cube hit may be treated as a proof. A real certificate may
be accepted only after an independent production rules verifier checks it
against the exact requested root position and its history.

## Verification

- Latest completed push and PR CI on commit `f22fe6aa05e49ee91ca8f0ce0a633aca2761792c`: **33/33 Node.js tests passed** on Node.js 22.
- The separate pinned `shogi-rs 0.12.2` audit: **2/2 Rust tests passed**, reproducing the SFEN bulk-history truncation described below.
- The CFE proof tests use synthetic rules adapters and fail-closed history checks; they do not establish conformance with actual Japanese Shogi.

Run the reference core locally with Node.js 22 or newer:

```sh
npm run check
npm test
```

A separate Rust audit probe pins `shogi-rs 0.12.2` and checks its SFEN
history-replay behavior:

```sh
cargo test --manifest-path tools/shogi-rs-audit/Cargo.toml
```

The CFE JavaScript core has no npm runtime dependencies and uses Node's
built-in test runner. The Rust crate is an audit-only development tool, not
a production CFE dependency.

## Planned engine and rules adapters

- **[YaneuraOu](https://github.com/yaneurao/YaneuraOu)** — primary USI/NNUE
  search engine and mate-search candidate generator. The current Tanuki mate
  implementation uses df-pn with TCA; its source still lists dominance,
  ProofPieces and SNDA as TODOs. Its USI mate output is not a full proof DAG.
- **[cshogi](https://github.com/TadaoYamaoka/cshogi)** — DFPN baseline,
  hand-dominance / proof-piece experiments, move-generation oracle and
  differential tests. Its Python binding currently returns search results,
  first move, PV and searched-node count; a complete CFE DAG exporter remains
  to be implemented.
- **[DeepLearningShogi (dlshogi)](https://github.com/TadaoYamaoka/DeepLearningShogi)**
  — self-play, training data and GPU policy/value inference. Neural outputs
  remain heuristic and cannot certify mate.
- **[nozaq/shogi-rs](https://github.com/nozaq/shogi-rs)** — independent Rust
  rules candidate. Its pinned 0.12.2 SFEN history-replay behavior is covered by
  an audit probe; do not use `set_sfen(... moves ...)` as a trusted verifier
  history loader until the upstream issue is resolved or bypassed safely.
- **[mShogi](https://github.com/jweathers777/mShogi)** — Rust DF-PN comparator
  and native Shogi proof-helper reference. It is useful for testing algorithms
  and edge cases, but its current mate result is not a CFE proof DAG.
- **[Fairy-Stockfish](https://github.com/fairy-stockfish/Fairy-Stockfish)** —
  variant engine and differential opponent, not the authoritative rules
  verifier for standard Shogi.
- **[lishogi](https://github.com/WandererXII/lishogi)** and
  **[shogiground](https://github.com/WandererXII/shogiground)** — online-play
  and board-UI references. The UI must never become the trusted rules layer.

## Portable target

The intended architecture is a shared, versioned certificate format with
independent native and WebAssembly verifiers. The first production target is a
native rules/verifier adapter; browser and iPhone builds should consume exactly
the same certificate semantics. GPU/neural acceleration may guide search and
move ordering but must not change proof validity.

## Licensing

This repository is GPL-3.0-only. Before copying or linking code from other
projects, pin revisions and review their licences and transitive dependencies.
See [LICENSE](LICENSE).


## Shared proof-format contract

The language-neutral certificate, history-ledger and canonical-hashing rules
are documented in docs/cfe-certificate-v1.md. Cross-runtime canonicalization
test vectors are in spec/canonical-v1-vectors.json. After successful
certificate verification, the Extractor also emits a proof summary and an
exact-root footprint; adapters can opt into versioned root-feature cubes for
retrieval only.
