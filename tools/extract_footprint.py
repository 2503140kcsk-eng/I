#!/usr/bin/env python3
"""Extract a condition-cube footprint from a verified CFE mate certificate."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cfe_footprint import extract_footprint


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root-sfen", required=True)
    ap.add_argument("--certificate", required=True, type=Path)
    ap.add_argument("--output", type=Path)
    ap.add_argument("--board-squares", nargs="*", help="only constrain these USI squares; default is all 81")
    ap.add_argument("--hand-counts", nargs="*", help="only constrain tokens such as bP or wR; default is all 14")
    ap.add_argument("--omit-side", action="store_true")
    ns = ap.parse_args()
    try:
        cert = json.loads(ns.certificate.read_text(encoding="utf-8"))
        footprint = extract_footprint(
            cert,
            ns.root_sfen,
            board_squares=ns.board_squares,
            hand_counts=ns.hand_counts,
            include_side=not ns.omit_side,
        )
        encoded = json.dumps(footprint, ensure_ascii=True, sort_keys=True, indent=2) + "\n"
        if ns.output:
            ns.output.parent.mkdir(parents=True, exist_ok=True)
            ns.output.write_text(encoded, encoding="utf-8")
        else:
            sys.stdout.write(encoded)
        return 0
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=True, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
