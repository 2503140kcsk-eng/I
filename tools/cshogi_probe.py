#!/usr/bin/env python3
"""GPL-3.0 cshogi-side probe; kept in a separate Python process.

It uses only cshogi's public Python API and emits a JSON observation. It does
not import or execute the CFE core.
"""
from __future__ import annotations
import argparse
import json
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("sfen")
    ns = ap.parse_args()
    try:
        import cshogi
    except ImportError:
        print(json.dumps({"ok": False, "error": "cshogi is not installed"}))
        return 2
    try:
        board = cshogi.Board(ns.sfen)
        observation = {
            "ok": True,
            "sfen": board.sfen(),
            "legal_moves": sorted(cshogi.move_to_usi(move) for move in board.legal_moves),
        }
        print(json.dumps(observation, ensure_ascii=False, sort_keys=True))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
