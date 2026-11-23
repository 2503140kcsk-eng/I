#!/usr/bin/env python3
"""Generate a deterministic corpus of reachable positions by seeded legal playouts.

This is differential-test input generation, not a second rules implementation:
every transition is selected from CFE's own legal move list and then checked by
the independent cshogi, shogi-rs, and YaneuraOu adapters.
"""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cfe_shogi import (
    _apply_unchecked,
    canonical_state,
    is_legal_move,
    legal_moves,
    parse_move,
    parse_sfen,
    to_sfen,
)

START_SFEN = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1"


def generate(games: int, plies: int, sample_every: int, seed: int) -> list[dict[str, str]]:
    if games < 1 or plies < 0 or sample_every < 1:
        raise ValueError("games and sample_every must be positive; plies must be non-negative")

    seen: dict[str, dict[str, str]] = {}
    for game in range(games):
        rng = random.Random(seed + game * 1_000_003)
        pos = parse_sfen(START_SFEN)
        for ply in range(plies + 1):
            if ply == 0 or ply % sample_every == 0:
                sfen = to_sfen(pos)
                state = canonical_state(pos)
                if state not in seen:
                    seen[state] = {
                        "id": f"random-g{game:02d}-ply{ply:03d}",
                        "category": "seeded-reachable-random-walk",
                        "sfen": sfen,
                    }

            moves = legal_moves(pos)
            if not moves:
                break
            usi = rng.choice(moves)
            move = parse_move(usi)
            if not is_legal_move(pos, move):
                raise AssertionError(f"legal move list contained an illegal move: {usi} in {to_sfen(pos)}")
            pos = _apply_unchecked(pos, move)
            # Assert every generated state stays inside the parser's declared
            # structural domain. This catches state-transition corruption
            # before delegating it to the external engine oracles.
            parse_sfen(to_sfen(pos))

    return list(seen.values())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--games", type=int, default=4)
    parser.add_argument("--plies", type=int, default=96)
    parser.add_argument("--sample-every", type=int, default=4)
    parser.add_argument("--seed", type=int, default=20261123)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    rows = generate(args.games, args.plies, args.sample_every, args.seed)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        "".join(json.dumps(row, ensure_ascii=True, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )
    print(json.dumps({
        "seed": args.seed,
        "games": args.games,
        "ply_limit": args.plies,
        "sample_every": args.sample_every,
        "positions": len(rows),
        "output": str(args.output),
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
