#!/usr/bin/env python3
"""Filter a certificate by a condition cube, then replay-verify the proof."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cfe_footprint import try_reuse_certificate


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--target-sfen", required=True)
    ap.add_argument("--certificate", required=True, type=Path)
    ap.add_argument("--footprint", required=True, type=Path)
    ns = ap.parse_args()
    try:
        cert = json.loads(ns.certificate.read_text(encoding="utf-8"))
        footprint = json.loads(ns.footprint.read_text(encoding="utf-8"))
        result = try_reuse_certificate(cert, footprint, ns.target_sfen)
        print(json.dumps(result, ensure_ascii=True, sort_keys=True))
        return 0 if result["reusable"] else 1
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(json.dumps({"reusable": False, "error": str(exc)}, ensure_ascii=True, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
