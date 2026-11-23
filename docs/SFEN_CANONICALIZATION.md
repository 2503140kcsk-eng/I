# CFE-SFEN-1: strict parse and canonical position identity

## 1. Scope

CFE-SFEN-1 defines a deterministic boundary format for ordinary 9×9 Shogi SFEN. It is designed for ingestion, cache keys, proof-certificate references and cross-runtime exchange. It is not a complete legal-move generator.

The implementation is an independent clean-room parser. Upstream projects were reviewed for behavior, format conventions and tests; their source code is not copied or linked as a dependency.

## 2. Accepted wire profile

An input consists of exactly four non-empty fields separated by exactly one ASCII space:

```text
<board> <side> <hands> <move-number>
```

- Input is printable ASCII only and at most 512 characters.
- Board: exactly nine slash-separated ranks. Each rank expands to exactly nine squares, encoded left-to-right as files 9 through 1. Empty runs use one digit `1` through `9`. Adjacent empty-run digits are rejected.
- Pieces: `K R B G S N L P` for sente and lowercase for gote. `+` may prefix only `R B S N L P`; kings and golds cannot be promoted.
- Side: exactly `b` (sente) or `w` (gote).
- Hands: `-` or hand-piece tokens. Input token order may vary, but a side cannot repeat a piece-kind token. Counts are positive decimal prefixes of at least 2; `1P`, `0P`, leading zeroes, kings and promoted pieces in hand are rejected.
- Move number: mandatory positive decimal, no sign or leading zero, limited to unsigned 32-bit range. Missing move number is rejected rather than silently defaulted.
- Exactly one king of each side must be on the board. Board-plus-hand inventory cannot exceed the physical standard set: K2, R2, B2, G4, S4, N4, L4, P18. Promoted pieces consume their original piece-kind inventory.

The original USI/SFEN draft describes four whitespace-separated fields and notes that the move-count field may be omitted by some producers. CFE-SFEN-1 deliberately tightens this: it requires all four fields so a missing counter is never guessed at a trust boundary. An adapter for a legacy producer may explicitly supply a counter before calling this parser.

## 3. Canonical serialization

`SfenPosition.toSfen()` emits:

1. the unique 9-rank board representation, merging every empty run;
2. side `b` or `w`;
3. sente hand pieces before gote hand pieces;
4. within each side, the fixed order `R B G S N L P`;
5. no count prefix for exactly one piece;
6. a canonical base-10 move number.

Thus two accepted inputs that differ only in hand-token order serialize identically. Invalid/ambiguous encodings are rejected; the parser does not try to repair malformed ranks, duplicate hand tokens or suspicious whitespace.

## 4. Two different identities

### Full SFEN

`toSfen()` keeps the move number because it is part of the four-field interchange record.

### Bare position identity

`positionKey()` is the exact canonical three-field string:

```text
<canonical-board> <side> <canonical-hands>
```

It deliberately excludes the move number. Consequently, two SFEN records with identical pieces, hands and side to move but different move counters have the same bare position key.

The key is the canonical string itself, not a lossy hash. A caller may hash this string for a table, but collision handling belongs to that table.

### Important CFE safety condition

A bare position key is **not** a full game-state key. Shogi repetition and perpetual-check adjudication depend on the path/history, not only the current board, turn and hands. A transposition table or proof DAG must therefore either:

- include a history/repetition-context fingerprint in its cache/certificate key; or
- refuse to merge nodes whose relevant history contexts are not proven equivalent.

Never treat equality of `positionKey()` as proof that two search nodes have identical repetition outcomes.

## 5. Structural validity versus local playability

`parseSfen()` validates the serialization, standard inventory and one-king-per-side structure. It intentionally permits a diagram that is structurally representable but locally unplayable, such as nifu or a dead-rank unpromoted piece.

`parsePlayableSfen()` adds two local constraints:

- no two unpromoted pawns of the same side on one file;
- an unpromoted pawn/lance cannot be on its final rank, and an unpromoted knight cannot be on either of its final two ranks.

This is not a reachability proof and does not check all attack, self-check, king-safety or historical constraints. Those belong to the independent rules verifier (`nozaq/shogi-rs` / CFE rules boundary), not the SFEN tokenizer.

## 6. Error contract

`SfenError.code` is a stable machine-readable discriminator. Current codes include `INVALID_TYPE`, `INPUT_TOO_LONG`, `NON_ASCII`, `FIELD_COUNT`, `RANK_COUNT`, `BOARD_SYNTAX`, `BOARD_WIDTH`, `INVALID_PROMOTION`, `SIDE_TO_MOVE`, `HAND_SYNTAX`, `HAND_COUNT`, `DUPLICATE_HAND_KIND`, `MATERIAL_OVERFLOW`, `KING_COUNT`, `MOVE_NUMBER`, `NIFU` and `DEAD_RANK_PIECE`.

The parser is atomic: it builds a new immutable position and either returns it fully validated or throws. It never mutates an existing position object.

## 7. Performance and portability

- Time: O(81 + number of hand-token characters); the board has a fixed 81-square upper bound.
- Space: O(81), also fixed.
- Runtime dependencies: zero.
- Output alphabet: printable ASCII, suitable for byte-identical serialization across Node.js, browsers, WebAssembly hosts and native adapters.
- The implementation performs no filesystem, network, clock, locale or random-number access.

## 8. Upstream behavior / license audit

Audit date: 2026-11-23. The license labels below were read from the linked repositories' license files; individual files may have additional notices or exceptions.

| Project | License observed | Use in this implementation |
|---|---|---|
| [YaneuraOu](https://github.com/yaneurao/YaneuraOu) | GNU GPL-3.0 | Reviewed SFEN / Zobrist boundary; no source copied, no dependency added. |
| [cshogi](https://github.com/TadaoYamaoka/cshogi) | GNU GPL-3.0 | Reviewed invalid-SFEN behavior and tests; no source copied, no dependency added. |
| [DeepLearningShogi](https://github.com/TadaoYamaoka/DeepLearningShogi) | GNU GPL-3.0 | License checked; not used by this parser. |
| [shogi-rs](https://github.com/nozaq/shogi-rs) | MIT | Independent rules engine candidate; not used as a parser dependency. |
| [mShogi](https://github.com/jweathers777/mShogi) | BSD 3-Clause | Reviewed strict parser and conformance-test ideas; no source copied, no dependency added. |
| [Fairy-Stockfish](https://github.com/fairy-stockfish/Fairy-Stockfish) | GNU GPL-3.0 | License checked; not used by this parser. |
| [lishogi](https://github.com/WandererXII/lishogi) | GNU AGPL-3.0-or-later | Reviewed its `ValidSfen` boundary; no source copied, no dependency added. |
| [shogiground](https://github.com/WandererXII/shogiground) | GNU GPL-3.0 | Reviewed board conversion/serialization; no source copied, no dependency added. |

The target repository `2503140kcsk-eng/I` had no `LICENSE` file at audit time. This change does not choose or add a project-wide license on the owner's behalf. Absence of a license is not a grant of permissive reuse rights; decide the repository's own license separately before distributing it as an open-source library.

## 9. References

- [USI draft: SFEN's four fields and piece notation](https://hgm.nubati.net/usi.html)
- [YaneuraOu position interface / SFEN methods](https://github.com/yaneurao/YaneuraOu/blob/master/source/position.h)
- [cshogi SFEN tests](https://github.com/TadaoYamaoka/cshogi/blob/master/test/test_board_sfen.py)
- [mShogi strict SFEN parser](https://github.com/jweathers777/mShogi/blob/main/crates/mshogi-core/src/shogi/sfen.rs)
- [lishogi valid-SFEN boundary](https://github.com/WandererXII/lishogi/blob/master/modules/setup/src/main/ValidSfen.scala)
- [shogiground SFEN board conversion](https://github.com/WandererXII/shogiground/blob/master/src/sfen.ts)
