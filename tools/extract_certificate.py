#!/usr/bin/env python3
"""Extract a replay-validated CFE mate certificate from a raw AND/OR proof tree."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cfe_certificate import CertificateVerificationError, canonical_certificate, extract_mate_certificate


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root-sfen", required=True, help="trusted four-field root SFEN")
    ap.add_argument("--proof-tree", required=True, type=Path, help="raw AND/OR proof-tree JSON")
    ap.add_argument("--output", type=Path, help="output certificate JSON; stdout when omitted")
    ap.add_argument("--max-nodes", type=int, default=100_000)
    ap.add_argument("--max-depth", type=int, default=512)
    ns = ap.parse_args()
    try:
        raw = json.loads(ns.proof_tree.read_text(encoding="utf-8"))
        certificate = extract_mate_certificate(
            raw, ns.root_sfen,
            max_nodes=ns.max_nodes, max_depth=ns.max_depth,
        )
        encoded = canonical_certificate(certificate) + "\n"
        if ns.output:
            ns.output.parent.mkdir(parents=True, exist_ok=True)
            ns.output.write_text(encoded, encoding="utf-8")
        else:
            sys.stdout.write(encoded)
        return 0
    except (OSError, json.JSONDecodeError, CertificateVerificationError, ValueError) as exc:
        print(json.dumps({"valid": False, "error": str(exc)}, ensure_ascii=True, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
