# Third-party license audit (2026-11-23)

## Repository I

At audit time the public repository had no `LICENSE` file and GitHub returned
`license: null`. A public GitHub repository is not automatically public-domain
or MIT-licensed. This change intentionally does not add a license or claim one
for the user's original CFE code. The repository owner must choose a license
before third parties may assume they can copy, modify, or redistribute it.

## Referenced projects

| Project | License evidence | Use in this change |
|---|---|---|
| `yaneurao/YaneuraOu` | Upstream `LICENSE` file begins GNU GPL, Version 3 | CI-only temporary clone of pinned commit `1a74e5196e1a72f5e7b815826dc34001b07aa7e2`, built as the evaluation-file-free Material edition under `/tmp`; queried through a separate USI process. No upstream source or binary is committed, vendored, or redistributed by this change. The probe compares `d` SFEN output, CFE key, and `go perft 1` count. |
| `TadaoYamaoka/cshogi` | Upstream `LICENSE` file begins GNU GPL, Version 3 | Optional isolated Python probe process, test-only. No cshogi code is imported in the CFE comparator/core process. Pinned PyPI version `1.1.1`; the CPython 3.11 manylinux x86-64 wheel SHA-256 is `91d32849f41b2979fdafae093578489a3615a7b06bd3fbf3ad4a2691629f5f19`. |
| `nozaq/shogi-rs` | Upstream `LICENSE` is MIT License | Rust conformance helper uses the public crate API; Git dependency pinned to commit `59677e96d4f6cc44411ff2ac0e84f88238c75be4`. No upstream source copied. Preserve MIT notice for the dependency if distributing. |
| `TadaoYamaoka/DeepLearningShogi` | Upstream `LICENSE` file begins GNU GPL, Version 3 | Not linked or imported in this phase. Training/self-play is a future, separately audited service. |
| `jweathers777/mShogi` | Upstream `BSD-LICENSE` contains the 3-clause BSD conditions | Research/test-design reference only. No source copied or dependency added. |
| `fairy-stockfish/Fairy-Stockfish` | GitHub repository metadata reported GPL-3.0; the attempted root `LICENSE` path returned 404 during this audit | Not used. The exact license-file path should be confirmed before any future use. |
| `WandererXII/lishogi` | Upstream `LICENSE` file begins GNU AGPL, Version 3 | No server code imported or linked. |
| `WandererXII/shogiground` | Upstream `LICENSE` file begins GNU GPL, Version 3 | No UI code imported or linked. |

## CI conformance evidence

The public GitHub Actions run builds the pinned YaneuraOu Material edition in
a temporary runner directory. The 12 SFEN corpus positions were successfully
checked against cshogi 1.1.1 and the pinned shogi-rs crate with exact sorted
legal-move-set equality, canonical state equality, and CFE key equality.
YaneuraOu's USI adapter checked canonical state, CFE key, and depth-1 perft
count for the same 12 positions; it does not expose the exact legal-move set
through this adapter.

## Separation and redistribution warning

The design keeps GPL/AGPL engines out of the CFE rule-core dependency graph.
YaneuraOu and cshogi are called through separate process boundaries. This is
an engineering boundary, **not a legal determination** that every possible
combined distribution is exempt from copyleft obligations. In particular,
review how scripts, binaries, deployment bundles, network services, notices,
and build flags are distributed before shipping a combined product.

The Rust probe links the MIT `shogi-rs` crate through Cargo; keep the upstream
MIT copyright and permission notice when redistributing the dependency. No
upstream engine or UI source has been copied into the CFE core.

## Source records

- https://github.com/yaneurao/YaneuraOu
- https://github.com/TadaoYamaoka/cshogi
- https://github.com/nozaq/shogi-rs
- https://github.com/TadaoYamaoka/DeepLearningShogi
- https://github.com/jweathers777/mShogi
- https://github.com/fairy-stockfish/Fairy-Stockfish
- https://github.com/WandererXII/lishogi
- https://github.com/WandererXII/shogiground
- https://pypi.org/project/cshogi/1.1.1/
