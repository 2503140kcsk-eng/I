#!/usr/bin/env python3
"""Run cshogi DF-PN in isolation, then build and verify a CFE mate certificate.

The GPL-3.0 cshogi module is imported only by cshogi_dfpn_probe.py in a child
process. This parent process consumes plain JSON and performs CFE extraction
and independent verification without importing cshogi.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cfe_certificate import (
    CertificateVerificationError,
    canonical_certificate,
    extract_mate_certificate,
    verify_mate_certificate,
)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root-sfen", required=True)
    ap.add_argument("--output", required=True, type=Path)
    ap.add_argument("--max-search-nodes", type=int, default=200_000)
    ap.add_argument("--max-tree-nodes", type=int, default=10_000)
    ap.add_argument("--max-depth", type=int, default=64)
    ap.add_argument("--draw-ply", type=int, default=2_147_483_646)
    ap.add_argument("--timeout-seconds", type=float, default=120.0)
    ns = ap.parse_args()

    if ns.timeout_seconds <= 0:
        ap.error("--timeout-seconds must be positive")
    command = [
        sys.executable, str(ROOT / "tools/cshogi_dfpn_probe.py"),
        "--sfen", ns.root_sfen,
        "--max-search-nodes", str(ns.max_search_nodes),
        "--max-tree-nodes", str(ns.max_tree_nodes),
        "--max-depth", str(ns.max_depth),
        "--draw-ply", str(ns.draw_ply),
    ]

    try:
        proc = subprocess.run(
            command, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=ns.timeout_seconds,
        )
    except subprocess.TimeoutExpired:
        print(json.dumps({
            "ok": False,
            "reason": "cshogi_dfpn_timeout",
            "timeout_seconds": ns.timeout_seconds,
        }, ensure_ascii=True, sort_keys=True))
        return 124

    try:
        observation = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        print(json.dumps({
            "ok": False,
            "reason": "cshogi_probe_invalid_json",
            "error": str(exc),
            "stdout_tail": proc.stdout[-2000:],
            "stderr_tail": proc.stderr[-2000:],
        }, ensure_ascii=True, sort_keys=True))
        return 2

    if proc.returncode != 0 or not observation.get("ok"):
        print(json.dumps({
            "ok": False,
            "reason": observation.get("reason", "cshogi_dfpn_failed"),
            "stats": observation.get("stats"),
            "stderr_tail": proc.stderr[-2000:],
        }, ensure_ascii=True, sort_keys=True))
        return 1

    try:
        certificate = extract_mate_certificate(
            observation["proof_tree"],
            ns.root_sfen,
            max_nodes=ns.max_tree_nodes,
            max_depth=ns.max_depth,
        )
        verification = verify_mate_certificate(
            certificate,
            ns.root_sfen,
            max_nodes=ns.max_tree_nodes,
            max_depth=ns.max_depth,
        )
    except (CertificateVerificationError, ValueError, KeyError) as exc:
        print(json.dumps({
            "ok": False,
            "reason": "independent_cfe_verification_failed",
            "error": str(exc),
            "stats": observation.get("stats"),
        }, ensure_ascii=True, sort_keys=True))
        return 3

    ns.output.parent.mkdir(parents=True, exist_ok=True)
    ns.output.write_text(canonical_certificate(certificate) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "certificate_path": str(ns.output),
        "stats": observation["stats"],
        "verification": verification,
    }, ensure_ascii=True, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
