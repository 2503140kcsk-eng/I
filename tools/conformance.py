#!/usr/bin/env python3
"""Run optional cross-engine conformance checks over a shared JSONL corpus."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CORPUS = ROOT / "corpus" / "sfen-v1.jsonl"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", choices=["cshogi", "shogi-rs", "yaneuraou"], required=True)
    ap.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS, help="JSONL with id and sfen fields")
    ap.add_argument("--limit", type=int, default=0, help="0 means all corpus cases")
    ap.add_argument("--engine-path", help="required for --engine yaneuraou")
    ns = ap.parse_args()

    if ns.limit < 0:
        ap.error("--limit cannot be negative")
    if not ns.corpus.is_file():
        ap.error(f"corpus file does not exist: {ns.corpus}")
    rows = [json.loads(line) for line in ns.corpus.read_text(encoding="utf-8").splitlines() if line.strip()]
    if ns.limit:
        rows = rows[:ns.limit]
    if not rows:
        ap.error(f"corpus is empty: {ns.corpus}")

    if ns.engine == "yaneuraou":
        if not ns.engine_path:
            ap.error("--engine-path is required for --engine yaneuraou")
        cmd = [
            sys.executable, str(ROOT / "tools/compare_yaneuraou.py"),
            "--engine-path", ns.engine_path, "--corpus", str(ns.corpus),
        ]
        if ns.limit:
            cmd.extend(["--limit", str(ns.limit)])
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=ns.limit * 60 + 240 if ns.limit else 900,
        )
        if proc.stdout:
            print(proc.stdout, end="")
        if proc.stderr:
            print(proc.stderr, file=sys.stderr)
        return proc.returncode

    failures = 0
    for row in rows:
        if "id" not in row or "sfen" not in row:
            raise SystemExit("every corpus row must contain 'id' and 'sfen'")
        script = ROOT / "tools" / ("compare_cshogi.py" if ns.engine == "cshogi" else "compare_shogi_rs.py")
        proc = subprocess.run(
            [sys.executable, str(script), row["sfen"]],
            capture_output=True,
            text=True,
            timeout=240,
        )
        if proc.stdout:
            print(f"[{row['id']}] {proc.stdout.strip()}")
        if proc.returncode:
            failures += 1
            if proc.stderr:
                print(proc.stderr, file=sys.stderr)
    print(json.dumps({
        "engine": ns.engine,
        "corpus": str(ns.corpus),
        "cases": len(rows),
        "failures": failures,
    }, sort_keys=True))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
