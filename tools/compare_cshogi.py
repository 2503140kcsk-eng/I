#!/usr/bin/env python3
"""Compare CFE with a separate-process cshogi oracle.

The GPL-3.0 cshogi extension runs in its own Python process. This comparator
and the CFE core do not import cshogi into their process.
"""
from __future__ import annotations
import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from cfe_shogi import canonical_state, legal_moves, parse_sfen, state_key, to_sfen


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("sfen")
    ns = ap.parse_args()
    pos = parse_sfen(ns.sfen)
    proc = subprocess.run(
        [sys.executable, str(ROOT / "tools/cshogi_probe.py"), to_sfen(pos)],
        capture_output=True, text=True, timeout=90,
    )
    if proc.returncode:
        if proc.stdout:
            print(proc.stdout, end="")
        if proc.stderr:
            print(proc.stderr, file=sys.stderr)
        return proc.returncode
    try:
        observation = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"cshogi probe returned malformed JSON: {exc}: {proc.stdout!r}")
    if not observation.get("ok"):
        raise SystemExit(observation.get("error", "cshogi probe failed"))

    ours = set(legal_moves(pos))
    theirs = set(observation["legal_moves"])
    native_sfen = observation["sfen"]
    native_state = canonical_state(native_sfen)
    expected_state = canonical_state(pos)
    native_key = state_key(native_sfen)
    expected_key = state_key(pos)
    result = {
        "engine": "cshogi",
        "canonical_state": native_state,
        "canonical_state_equal": native_state == expected_state,
        "state_key": native_key,
        "expected_state_key": expected_key,
        "legal_moves_equal": ours == theirs,
        "missing_from_engine": sorted(ours - theirs),
        "extra_from_engine": sorted(theirs - ours),
        "legal_move_count": len(ours),
    }
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if ours == theirs and native_state == expected_state and native_key == expected_key else 1


if __name__ == "__main__":
    raise SystemExit(main())
