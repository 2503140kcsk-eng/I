# CFE Shogi Validation Core

Independent SFEN normalization, standard-shogi move legality checks, and an
engine-neutral conformance corpus for the CFE (Certificate / Footprint) layer.

> **Scope:** standard 9x9 shogi, four-field SFEN, USI move notation. This is a
> structural position validator and move-legality core, **not** a proof that an
> arbitrary SFEN is reachable from the initial position. Repetition adjudication,
> entering-king declarations, clocks, handicap variants, and variant rules are
> outside this first validation boundary.

## Implemented boundary

- Strict four-field SFEN parsing: nine ranks, exact rank widths, ASCII piece
  alphabet, promotion markers, side to move, positive u16-compatible move
  number, well-formed hands, exactly one king per side, duplicate-hand-entry
  rejection, and physical piece-inventory upper bounds.
- Deterministic SFEN serializer. Empty runs are normalized; hands use `R B G S
  N L P` order, black before white. The move number is retained in canonical
  SFEN.
- Engine-independent state identity: SHA-256 over
  `CFE-SHOGI-STATE-V1\0` plus canonical board/side/hands. The move number is
  intentionally excluded. `state_identity()` returns both the digest and the
  exact canonical state so a verifier can compare bytes rather than rely on
  the collision resistance of a digest alone.
- Legal move validation for piece movement and sliding blockers, friendly
  occupancy, capture/hand transfer (including demotion of captured promoted
  pieces), promotion zones, optional and mandatory promotion, drops, hand
  counts, nifu, dead-rank restrictions, own-king safety, and uchifuzume
  (pawn-drop mate).
- Exhaustive legal-move enumeration and perft for reference testing.
- Portable JSON position envelope (`cfe.shogi.position.v1`) for consumers on
  iPhone, Web, GPU hosts, and other runtimes. It is a state snapshot, not a
  search-proof certificate or history-reachability proof.
- Independent finite forced-mate certificate verifier
  (`cfe.shogi.mate-certificate.v1`): attacker nodes are OR nodes with exactly
  one legal move, defender nodes are AND nodes covering every legal reply,
  and leaves must be checkmate. Every node carries exact canonical state and
  a versioned CFE state key.
- Shared JSONL corpus and separate process/API adapters for cshogi,
  shogi-rs, and YaneuraOu. The CFE core itself has no third-party runtime
  dependencies.

## Quick start

Python 3.11+; the core uses only the standard library.

```sh
python -m unittest discover -s tests -v
python cfe_shogi.py --sfen 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1' --canonical --key --moves --perft 3
python cfe_shogi.py --sfen 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1' --envelope
python cfe_shogi.py --sfen 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1' --move 7g7f
```

The checked-in core tests cover the move families and rule boundaries, including every unpromoted piece family, promoted-piece movement, and a rotate-and-color-swap metamorphic test over the full corpus. The opening-position
reference counts are 30 legal moves at depth 1, 900 nodes at depth 2, and
25,470 nodes at depth 3.

## Canonical identity contract

`canonical_sfen` retains all four SFEN fields, including the move number. In
contrast, `canonical_state` contains only board, side-to-move, and hands.
Consequently two otherwise identical positions with different move numbers
share a CFE state key. This is deliberate for transposition/state matching;
repetition adjudication must separately retain game history and check records.

The key's version is part of the hash preimage. A change in identity semantics
must introduce `V2`, not silently alter `V1`. Cross-engine adapters compare all
three of:

1. the exact canonical state string;
2. the versioned SHA-256 digest;
3. the complete legal USI move set, where the reference API exposes one.

This is stronger than comparing private engine Zobrist keys. Those keys are
engine-local implementation details and are not intended to be equal across
engines. A digest is not mathematically injective, which is why the full
canonical state is retained and compared as well.

## Independent forced-mate certificate verification

The certificate extractor and verifier are independent from
YaneuraOu, cshogi, and shogi-rs. The extractor accepts an engine-neutral raw
AND/OR proof tree, replays every edge from the caller-supplied root SFEN, and
attaches canonical position identities itself; it does not trust hashes
supplied by the search process. It then invokes the independent verifier
before emitting a certificate.

At an attacker-to-move node, exactly one legal move is required (OR proof).
At a defender-to-move node, the child move list must equal the complete sorted
legal-move set (AND proof). A terminal leaf is accepted only if the defender is
in check and has no legal move. Every certified node includes exact canonical
state and versioned SHA-256 identity. Repeated states on a branch are rejected
so v1 does not silently assume repetition adjudication away.

Extract and verify the checked-in one-ply example:

```sh
python tools/extract_certificate.py \
  --root-sfen '4k4/9/2NGKGN2/9/9/9/9/9/9 b - 1' \
  --proof-tree examples/mate-in-1.proof.json \
  --output /tmp/mate.certificate.json
python tools/verify_certificate.py \
  --root-sfen '4k4/9/2NGKGN2/9/9/9/9/9/9 b - 1' \
  --certificate /tmp/mate.certificate.json
```

The extractor and verifier enforce node-count and depth limits. Certificate
v1 is a finite standard-shogi checkmate proof tree; it does not yet cover
repetition, perpetual-check adjudication, entering-king declarations, clocks,
variants, or DAG node sharing. It is not a generic proof for every engine
score or evaluation claim. The certified structure is specified in
`schemas/mate-certificate-v1.schema.json`; the raw input structure is
`schemas/raw-mate-proof-v1.schema.json`.

## Condition-cube footprints and safe proof reuse

A footprint is a conjunction of partial equalities over the board, side to
move, and hand counts. The default extractor emits all fields; callers can
omit irrelevant squares or hand counters to create a broader candidate filter.
Cube implication is ordered explicitly: a stronger (narrower) cube implies a
weaker (broader) cube when it contains every equality of the weaker cube.

```sh
python tools/extract_footprint.py \
  --root-sfen '4k4/9/2NGKGN2/9/9/9/9/9/9 b - 1' \
  --certificate examples/mate-in-1.certificate.json \
  --board-squares 5a 5b 4c 6c 5c 3c 7c \
  --output /tmp/mate.footprint.json

python tools/match_footprint.py \
  --target-sfen '4k4/9/2NGKGN2/9/9/9/9/9/8P b - 1' \
  --certificate examples/mate-in-1.certificate.json \
  --footprint /tmp/mate.footprint.json
```

A footprint hit is only a candidate. The matcher replays the whole proof tree
against the target SFEN using the verifier's replay policy. It recomputes all
legal defender replies and all terminal checkmates. Stored node identities
must be internally consistent, but may differ from the target replay state.
Therefore an over-broad cube can cause extra verification work, but cannot by
itself make an invalid proof reusable. Schema:
`schemas/footprint-v1.schema.json`.

## Shared cross-engine corpus

The corpus is `corpus/sfen-v1.jsonl`. It currently includes the initial
position, optional and mandatory promotion, nifu/dead-rank drops, a pinned
piece, king safety, uchifuzume, capture-to-hand demotion, check interposition, and promoted bishop/rook movement.

The optional reference implementations remain external: no upstream source is
vendored or copied into this repository.

### cshogi (exact legal-move-set check)

```sh
python -m pip install --only-binary=:all: --require-hashes -r requirements/cshogi-conformance.txt
python tools/conformance.py --engine cshogi
```

The comparator launches `tools/cshogi_probe.py` in a separate Python process;
that isolated process reads the canonical SFEN with `cshogi.Board`, obtains the
complete `legal_moves` collection, and emits a JSON observation. The CFE process
compares the exact move set, canonical state, and CFE state key. The optional
probe is pinned to PyPI `cshogi==1.1.1` and the CPython 3.11 Linux x86-64 wheel
hash so the external oracle does not drift silently.

### shogi-rs (exact legal-move-set check)

```sh
cargo run --manifest-path integrations/shogi-rs-probe/Cargo.toml -- \
  'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1'
python tools/conformance.py --engine shogi-rs
```

The small Rust probe pins `nozaq/shogi-rs` to a specific upstream commit and
uses only its public API. Since that API provides checked `Position::make_move`
rather than an exposed complete legal-move list, the probe enumerates the
finite candidate move alphabet and asks a fresh parsed position to validate
each candidate. Friendly captures and king capture are excluded at the
adapter boundary. It then compares exact legal move sets, canonical state, and
CFE key.

### YaneuraOu (USI process-level check)

The CI workflow fetches upstream YaneuraOu at the pinned commit
`1a74e5196e1a72f5e7b815826dc34001b07aa7e2` into the temporary runner directory,
builds the evaluation-file-free Material edition, and invokes it as an
independent USI process. To run against a local build instead:

```sh
python tools/conformance.py --engine yaneuraou --engine-path /path/to/YaneuraOu
```

The adapter completes `usi`/`isready`, sends `position sfen`, reads the SFEN
from the `d` diagnostic output, and checks the canonical state and CFE key. It
uses `go perft 1`'s root divide output (`USI: 1` per legal move) to reconstruct
and compare YaneuraOu's exact legal USI move set. It rejects duplicate move
lines, non-unit depth-one counts, malformed summaries, and a mismatch between
root-line count and the total node count. The pinned Material build avoids
needing a separate NNUE evaluation file for this protocol test.

A regression test suite covers normal moves, promotions, drops, empty move
sets, duplicate output, missing root lines, non-unit counts, and malformed
perft summaries.

### Deterministic reachable-position differential corpus

The CI also generates positions from six seeded legal random playouts:

```sh
python tools/generate_random_corpus.py --games 6 --plies 96 --sample-every 8 --seed 20261123 --output /tmp/cfe-random-sfen-v1.jsonl
python tools/conformance.py --engine cshogi --corpus /tmp/cfe-random-sfen-v1.jsonl
python tools/conformance.py --engine shogi-rs --corpus /tmp/cfe-random-sfen-v1.jsonl
python tools/conformance.py --engine yaneuraou --engine-path /path/to/YaneuraOu --corpus /tmp/cfe-random-sfen-v1.jsonl
```

The checked-in edge-case corpus has 12 positions. The fixed-seed playout
generator produced 73 additional unique reachable positions (six games, up to
96 plies each, sampled every eight plies; duplicate canonical states removed).
This tests a broad selection of ordinary game states in addition to hand-built
rule boundaries.

## CI and free-use policy

- `core.yml` runs the dependency-free core and adapter tests, compile and CLI
  checks, then both the 12-position edge corpus and the 73-position reachable
  corpus against cshogi, shogi-rs, and a pinned YaneuraOu Material build on a
  standard Ubuntu runner.
- Across 85 positions per engine, **all three engines match the exact legal
  move set**, canonical state, and CFE key. For YaneuraOu, the exact set is
  extracted from the per-root-move lines in perft depth one; the reported total
  count is also checked independently.

The repository is public. GitHub documents that standard GitHub-hosted runner
usage for public repositories is free; this workflow does not request larger
runners or paid external services. See GitHub's current
[billing documentation](https://docs.github.com/en/actions/concepts/billing-and-usage).

## CFE architecture handoff

`cfe_shogi.py` is the independent rule and identity boundary. Its versioned
position envelope provides the shared state input to the next CFE layers:

- **Certificate Extractor:** implemented for raw AND/OR proof trees.
  It replays edges, attaches identities derived from states, and only emits a
  certificate after the independent verifier accepts the result. Automatic
  conversion from each engine's native DFPN/search format and proof
  minimization remain to implement.
- **Footprint Matcher:** implemented as partial-equality condition cubes,
  implication/subsumption checks, and proof-gated candidate reuse. A cube hit
  is never accepted alone; every candidate proof is replay-verified on the
  target position. Indexed lookup and cache optimization remain future work.
- **Certificate Verifier:** implemented for finite forced-checkmate trees.
  It replays every edge through the independent legality core, checks exact
  node identities, requires one attacker move and every defender legal reply,
  and accepts leaves only at checkmate.
- **Governor:** still to implement; resource allocation and reuse economics
  must be driven by measured verification cost and expected proof reuse.

YaneuraOu remains the main search engine. cshogi DFPN/proof-piece work,
dlshogi self-play/training, and mShogi research remain separate services or
future integrations; none of their source is copied into this legality core.

## License status

The repository had no `LICENSE` file at audit time and GitHub reported no
repository license. This change intentionally does not invent one. See
[LICENSE-CHECK.md](LICENSE-CHECK.md) for the upstream license inventory and
separation policy. Before redistribution or linking, review the exact notices
and the full license obligations for every component in the final product.
