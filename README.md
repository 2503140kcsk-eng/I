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

The checked-in core tests cover 24 focused cases, including every unpromoted piece family, promoted-piece movement, and a rotate-and-color-swap metamorphic test over the full corpus. The opening-position
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
also compares `go perft 1` with the CFE legal-move count. Perft checks the
count, **not** the exact move set; cshogi and shogi-rs provide exact legal-move
set checks. The pinned Material build avoids needing a separate NNUE evaluation
file for this protocol test.

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

- `core.yml` runs the 24 dependency-free core tests, compile and CLI checks,
  then both the 12-position edge corpus and the 73-position reachable corpus
  against cshogi, shogi-rs, and a pinned YaneuraOu Material build on a standard
  Ubuntu runner.
- Across 85 positions per engine, cshogi and shogi-rs match the exact legal
  move set, canonical state, and CFE key. YaneuraOu matches canonical state,
  CFE key, and perft-1 move count on all 85.

The repository is public. GitHub documents that standard GitHub-hosted runner
usage for public repositories is free; this workflow does not request larger
runners or paid external services. See GitHub's current
[billing documentation](https://docs.github.com/en/actions/concepts/billing-and-usage).

The repository is public. GitHub documents that standard GitHub-hosted runner
usage for public repositories is free; this workflow does not request larger
runners or paid external services. See GitHub's current
[billing documentation](https://docs.github.com/en/actions/concepts/billing-and-usage).

## CFE architecture handoff

`cfe_shogi.py` is the independent rule and identity boundary. Its versioned
position envelope provides the shared state input to the next CFE layers:

- **Certificate Extractor:** later consume search/proof evidence and emit
  condition cubes; this is not implemented in this change.
- **Footprint Matcher:** match exact canonical state and versioned keys, with
  condition-cube inclusion checks added in a later stage.
- **Certificate Verifier:** replay each certified USI move through the
  independent legality core; the single-move verifier is implemented here.
- **Governor:** later allocate expensive search/verification resources based
  on proven footprint reuse economics; not implemented in this change.

YaneuraOu remains the main search engine. cshogi DFPN/proof-piece work,
dlshogi self-play/training, and mShogi research remain separate services or
future integrations; none of their source is copied into this legality core.

## License status

The repository had no `LICENSE` file at audit time and GitHub reported no
repository license. This change intentionally does not invent one. See
[LICENSE-CHECK.md](LICENSE-CHECK.md) for the upstream license inventory and
separation policy. Before redistribution or linking, review the exact notices
and the full license obligations for every component in the final product.
