# Upstream engine and rules-library audit

**Audit date:** 2026-11-22  
**Repository under development:** `2503140kcsk-eng/I`  
**Purpose:** choose narrow, auditable roles for upstream projects; do not turn a
search result or a library's own mate claim into a CFE proof.

## Decision summary

| Project | Intended CFE role | Decision |
|---|---|---|
| YaneuraOu | Main standard-Shogi search, NNUE, USI, mate candidate generation | Adopt as the primary search process; keep behind a USI boundary |
| cshogi | DFPN experiments, ProofPieces / hand-dominance study, Python differential oracle | Use as a search research baseline and test oracle, not the independent certificate verifier |
| DeepLearningShogi | Self-play, training data, policy/value inference | Use for learning and move ordering; neural scores remain heuristic |
| nozaq/shogi-rs | Independent Rust move/rules implementation | Candidate only; SFEN history replay needs a regression test/fix before trust |
| mShogi | Independent Rust DF-PN and rules-comparison implementation | Use as an algorithmic comparator and source of edge-case tests; not a CFE DAG format |
| Fairy-Stockfish | Variant engine and differential opponent | Optional variant support; not the standard-Shogi rules authority |
| lishogi | Online-play/server and deployment reference | Study architecture only; do not import server code into this GPL-3.0-only core without a separate AGPL review |
| shogiground | Browser board interaction/rendering | UI layer only; never the rules or proof authority |

## Source-level findings

### YaneuraOu

The main engine is the standard-Shogi search process: USI, NNUE evaluation,
normal alpha-beta search and mate-search support. The current Tanuki mate
engine source identifies df-pn with TCA and still marks dominance,
ProofPieces and SNDA as TODOs. Therefore, the integration boundary should be
a USI process/protocol adapter. A returned `checkmate` line is a candidate PV,
not a complete AND/OR proof DAG.

Sources:
- [Repository](https://github.com/yaneurao/YaneuraOu)
- [Tanuki mate search source](https://github.com/yaneurao/YaneuraOu/blob/master/source/engine/tanuki-mate-engine/tanuki-mate-search.cpp)
- [GPL-3.0 license](https://github.com/yaneurao/YaneuraOu/blob/master/LICENSE)

### cshogi

The public Python package documents legal move generation, move application,
game-state/repetition queries, USI and teacher-data formats. Its Cython binding
exposes `DfPn` and `OslDfPn`, including search, first-move/PV and searched-node
access. The underlying DFPN source contains proof/disproof-piece state and
hand-superiority comparisons for solved transposition entries, making it a
useful reference for CFE dominance experiments.

However, a Python PV and node count are not a full proof DAG. The wrapper does
not expose a complete reusable certificate graph. Instrumenting the native
DFPN internals or writing a dedicated exporter remains future work.

Sources:
- [README and API examples](https://github.com/TadaoYamaoka/cshogi/blob/master/README.rst)
- [DFPN header](https://github.com/TadaoYamaoka/cshogi/blob/master/src/dfpn.h)
- [DFPN implementation](https://github.com/TadaoYamaoka/cshogi/blob/master/src/dfpn.cpp)
- [Cython DFPN bindings](https://github.com/TadaoYamaoka/cshogi/blob/master/cshogi/_cshogi.pyx)
- [GPL-3.0 license](https://github.com/TadaoYamaoka/cshogi/blob/master/LICENSE)

### DeepLearningShogi

This is the training/self-play/neural-evaluation branch of the architecture.
Its MCTS, training records and policy/value inference can improve move
ordering and candidate generation, especially on a GPU host. They cannot
establish mate validity. It is not an iPhone-native certificate verifier.

Sources:
- [Repository and build/training notes](https://github.com/TadaoYamaoka/DeepLearningShogi)
- [GPL-3.0 license](https://github.com/TadaoYamaoka/DeepLearningShogi/blob/master/LICENSE)

### nozaq/shogi-rs: audit blocker

The crate is MIT-licensed and provides `Position`, SFEN, move objects,
`move_candidates`, `make_move`, `unmake_move`, check detection and repetition
handling. It is attractive for a native Rust verifier, but the inspected
0.12.2 source has a history-replay control-flow issue that must be resolved
before using its SFEN-with-moves loader as trusted evidence:

1. `Position::make_move` calls its normal/drop move implementation. Those
   implementations update the position, append a position-history record and
   call repetition detection before returning the move record.
2. In `Position::set_sfen`, the `moves` loop calls `make_move`; after a
   successful return, the loop calls `log_position` again. This appears to
   append the same resulting position a second time during bulk replay.
3. If `make_move` returns a repetition/perpetual-check error, the `set_sfen`
   loop breaks and the function returns `Ok(())`. The move implementation
   updates the board/ply before repetition detection, while the move record is
   pushed only after successful return. This appears capable of leaving a
   mutated position with a truncated move-history list.

**Important distinction:** the control flow above is directly visible in the
source. The resulting premature fourfold-repetition behavior is a source-level
inference until reproduced against the pinned crate. The Rust audit test in
this repository compares direct `make_move` replay against `set_sfen` bulk
replay using a two-king shuttle with only three actual occurrences of the
initial position. It pins the observed 0.12.2 behavior so an upstream change
forces re-review. This is an audit finding, not a claim that the whole crate is
unusable: a carefully designed adapter could replay from the initial SFEN by
calling `make_move` directly and discard a branch after rule-terminal errors,
but that path still needs its own exhaustive tests.

The public API also does not provide one direct `legal_moves()` or
`is_checkmate()` call. A verifier adapter would need to enumerate board
moves/drops, test them through `make_move`, and determine terminal status
without assuming a pseudo-legal candidate list is complete.

Sources:
- [Cargo.toml (crate version and dependencies)](https://github.com/nozaq/shogi-rs/blob/main/Cargo.toml)
- [Position move application](https://github.com/nozaq/shogi-rs/blob/main/src/position.rs)
- [Repetition and SFEN history replay](https://github.com/nozaq/shogi-rs/blob/main/src/position.rs)
- [MIT license](https://github.com/nozaq/shogi-rs/blob/main/LICENSE)

### mShogi

mShogi contains a game-independent Rust DF-PN core and a Shogi-specific proof
helper. Its documentation describes a bounded proof line and history-sensitive
rule handling; it is a valuable independent comparator for DF-PN and edge-case
design. The public result is still a line / bounded proof helper, not a
content-addressed, full AND/OR DAG with a CFE verifier ABI. Its repository
conformance policy also cautions that agreement with another engine is not
itself a correctness proof.

Sources:
- [Repository](https://github.com/jweathers777/mShogi)
- [DF-PN mate core](https://github.com/jweathers777/mShogi/blob/main/crates/mshogi-search/src/alphabeta/mate.rs)
- [Shogi mate proof helper](https://github.com/jweathers777/mShogi/blob/main/crates/mshogi-runner/examples/support/shogi_mate_proof.rs)
- [Conformance policy](https://github.com/jweathers777/mShogi/blob/main/docs/testing/conformance-policy.md)
- [BSD-3-Clause license](https://github.com/jweathers777/mShogi/blob/main/BSD-LICENSE)

### Fairy-Stockfish, lishogi and shogiground

Fairy-Stockfish is useful for variant support and as a differential opponent;
do not delegate standard-Shogi CFE proof acceptance to it. Lishogi is the
online platform/server reference. Shogiground is a board UI: it should receive
validated state and legal actions from a separate rules service.

Sources:
- [Fairy-Stockfish](https://github.com/fairy-stockfish/Fairy-Stockfish) —
  [GPL-3.0 license](https://github.com/fairy-stockfish/Fairy-Stockfish/blob/master/Copying.txt)
- [Lishogi](https://github.com/WandererXII/lishogi) —
  [AGPL-3.0 copying policy](https://github.com/WandererXII/lishogi/blob/master/COPYING.md)
- [Shogiground](https://github.com/WandererXII/shogiground) —
  [GPL-3.0 license](https://github.com/WandererXII/shogiground/blob/master/LICENSE)

## Pinned Rust reproduction probe

The separate crate under `tools/shogi-rs-audit` pins `shogi = 0.12.2`. It
contains two tests:

- direct, incremental `make_move` replay of the two-king shuttle;
- the same eight moves supplied to `set_sfen(... moves ...)`, recording the
  bulk loader's reported move-history length.

The expected result is that direct replay records all eight plies, while the
bulk replay stops before the final move because the duplicated history log
triggers repetition early. This expected upstream behavior is deliberately
pinned only in the audit tool. Do not use this crate as a proof trust root.

## CFE integration decision

- Keep YaneuraOu as the independent primary search process.
- Keep cshogi and mShogi as search baselines / test oracles.
- Require a separate rules-verifier interface with an embedded, replayable
  history witness and exact root binding.
- Do not use PVs, PN/DN values, hand-dominance hits or abstract footprint hits
  as proof acceptance.
- Admit a Rust rules library only after a fixed corpus covers promotions,
  drops, nifu, mandatory promotion, pawn-drop mate, checkmate, repetition,
  perpetual check, and history-sensitive transpositions.
- Keep the certificate format and verification semantics common across native
  iPhone, WebAssembly and GPU-hosted search. GPU scores guide search; proof
  verification remains exact and fail-closed.
