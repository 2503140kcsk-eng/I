#!/usr/bin/env python3
"""Run optional cross-engine conformance checks over the shared JSONL corpus."""
from __future__ import annotations
import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / "corpus" / "sfen-v1.jsonl"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", choices=["cshogi", "shogi-rs", "yaneuraou"], required=True)
    ap.add_argument("--limit", type=int, default=0, help="0 means all corpus cases")
    ap.add_argument("--engine-path", help="required for --engine yaneuraou")
    ns = ap.parse_args()
    rows = [json.loads(line) for line in CORPUS.read_text().splitlines() if line.strip()]
    if ns.limit:
        rows = rows[:ns.limit]
    if ns.engine == "yaneuraou":
        if not ns.engine_path:
            ap.error("--engine-path is required for --engine yaneuraou")
        proc = subprocess.run(
            [sys.executable, str(ROOT / "tools/compare_yaneuraou.py"),
             "--engine-path", ns.engine_path, "--limit", str(ns.limit)],
            capture_output=True, text=True, timeout=ns.limit * 60 + 240 if ns.limit else 600,
        )
        if proc.stdout:
            print(proc.stdout, end="")
        if proc.stderr:
            print(proc.stderr, file=sys.stderr)
        return proc.returncode

    failures = 0
    for row in rows:
        script = ROOT / "tools" / ("compare_cshogi.py" if ns.engine == "cshogi" else "compare_shogi_rs.py")
        cmd = [sys.executable, str(script), row["sfen"]]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.stdout:
            print(f"[{row['id']}] {proc.stdout.strip()}")
        if proc.returncode:
            failures += 1
            if proc.stderr:
                print(proc.stderr, file=sys.stderr)
    print(json.dumps({"engine": ns.engine, "cases": len(rows), "failures": failures}, sort_keys=True))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
