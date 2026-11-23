#!/usr/bin/env python3
"""Verify a CFE mate certificate against an independently supplied root SFEN."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cfe_certificate import CertificateVerificationError, verify_mate_certificate


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root-sfen", required=True, help="trusted four-field root SFEN")
    ap.add_argument("--certificate", required=True, type=Path, help="JSON certificate file")
    ap.add_argument("--max-nodes", type=int, default=100_000)
    ap.add_argument("--max-depth", type=int, default=512)
    ns = ap.parse_args()
    try:
        certificate = json.loads(ns.certificate.read_text(encoding="utf-8"))
        result = verify_mate_certificate(
            certificate, ns.root_sfen,
            max_nodes=ns.max_nodes, max_depth=ns.max_depth,
        )
        print(json.dumps(result, ensure_ascii=True, sort_keys=True))
        return 0
    except (OSError, json.JSONDecodeError, CertificateVerificationError, ValueError) as exc:
        print(json.dumps({"valid": False, "error": str(exc)}, ensure_ascii=True, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
