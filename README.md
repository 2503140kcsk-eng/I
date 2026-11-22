# CFE Shogi

CFE Shogi is an open-source research prototype for **proof-carrying shogi search**.

The repository currently contains an executable reference core for the CFE
certificate pipeline. It is deliberately not presented as a complete shogi AI,
a production rules engine, or a tournament-strength engine.

## Implemented reference core

- **Certificate Extractor** — converts a labelled AND/OR proof DAG into
  content-addressed certificate nodes.
- **Footprint Matcher** — finds exact-state and feature-cube candidates.
  An abstract match is only a retrieval hint and never transfers proof validity.
- **Certificate Verifier** — checks finite proof DAG structure, legal checking
  moves, complete defender-evasion coverage, exact child states, terminal mate,
  history context, hashes and resource limits through a rules adapter.
- **Governor** — schedules proof verification against CPU, GPU, memory and
  thermal budgets. A schedule is not itself a verification result.
- **Tests** — synthetic game fixtures exercise valid proofs and fail-closed
  rejection paths.

## Current trust boundary

The rules adapter is currently a **synthetic test fixture**, not a complete
implementation of Japanese shogi. The repository does not yet contain a
production cshogi or Rust rules adapter, an actual DFPN proof exporter, a
YaneuraOu USI proxy, a mobile application, or a deployed online service.

No evaluation score, principal variation, DFPN number, neural output or
condition-cube hit may be treated as a proof. A real certificate can be
accepted only after an independent production rules verifier checks it.

## Development

Requirements: Node.js 22 or newer.

```sh
npm run check
npm test
```

The project uses Node's built-in test runner and has no npm runtime dependencies.

## Planned engine adapters

- **YaneuraOu** — primary USI search and NNUE engine; initially integrated
  through a process/protocol boundary, not by modifying its search core.
- **cshogi** — DFPN experiments, candidate export and Python differential
  testing.
- **DeepLearningShogi (dlshogi)** — self-play, training data and GPU
  policy/value inference. Neural outputs remain heuristic.
- **nozaq/shogi-rs** — independent Rust rules/verifier candidate, pending full
  conformance testing for repetition, perpetual check, pawn-drop mate and the
  selected ruleset.
- **mShogi** — optional experimental comparator after pinning its exact source
  revision, license and verified capabilities.
- **Fairy-Stockfish** — variant engine and differential test opponent.
- **lishogi / shogiground** — online-play and browser-board references; the UI
  does not own the trusted rules implementation.

## Planned deployment

The target is a shared, versioned certificate format with native iOS and
WebAssembly verifier builds. The native iOS path should use a small native
rules/verifier library; the browser path can use WebAssembly and workers.
Platform-specific engines and neural accelerators must not change certificate
semantics.

## License

GPL-3.0-only. See [LICENSE](LICENSE).
