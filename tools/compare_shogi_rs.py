#!/usr/bin/env python3
"""Run the MIT-licensed shogi-rs helper and compare legal-move sets."""
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
    ap.add_argument("--manifest", default=str(ROOT / "integrations/shogi-rs-probe/Cargo.toml"))
    ns = ap.parse_args()
    pos = parse_sfen(ns.sfen)
    proc = subprocess.run(
        ["cargo", "run", "--quiet", "--manifest-path", ns.manifest, "--", to_sfen(pos)],
        check=False, capture_output=True, text=True, timeout=180,
    )
    if proc.returncode:
        sys.stderr.write(proc.stderr)
        return proc.returncode
    lines = proc.stdout.splitlines()
    sfen_line = next((line.split("\t", 1)[1] for line in lines if line.startswith("SFEN\t")), None)
    if sfen_line is None:
        raise SystemExit("shogi-rs probe did not return a canonical SFEN")
    theirs = {line.split("\t", 1)[1] for line in lines if line.startswith("MOVE\t")}
    ours = set(legal_moves(pos))
    expected_key = state_key(pos)
    native_key = state_key(sfen_line)
    native_state = canonical_state(sfen_line)
    expected_state = canonical_state(pos)
    result = {
        "engine": "shogi-rs",
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
