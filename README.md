# CFE SFEN Core

A dependency-free, deterministic SFEN boundary for the CFE Shogi AI.

## What is implemented

- Strict four-field ASCII SFEN parsing (`board side hands move-number`).
- Board validation: exactly 9 ranks × 9 squares, valid piece tokens and promotion markers.
- Structural validation: exactly one king per side, no king/promoted pieces in hand, no duplicate hand-kind token per side, and no piece inventory exceeding a standard 40-piece set.
- Canonical serialization: hand order is always `R B G S N L P`, sente before gote; a hand count of one is omitted.
- Position identity: the canonical key contains board, side to move and hands, but deliberately excludes move number.
- Optional local-playability checks for nifu (two unpromoted pawns on one file) and dead-rank pieces.
- No runtime dependencies; usable as an ES module in Node.js and modern browsers.

## Quick start

```js
import { parseSfen, canonicalizeSfen, getPositionKey } from 'cfe-sfen';

const sfen = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
const position = parseSfen(sfen);

console.log(position.toSfen());
console.log(position.positionKey());
console.log(canonicalizeSfen(sfen));
console.log(getPositionKey(sfen));
```

## Test

```sh
npm test
```

Node.js 20 or newer is required. The parser itself has no dependency on Node APIs and can be imported by a browser application.

## Contract and limitations

See [`docs/SFEN_CANONICALIZATION.md`](docs/SFEN_CANONICALIZATION.md) for the exact accepted grammar, identity rules, validation boundary and CFE history-safety notes.

This parser does **not** prove that a position is reachable from the initial position, validate king safety/check legality, or reconstruct move history. Use an independent rules engine for those questions.
