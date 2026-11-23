#!/usr/bin/env python3
"""Run the deterministic CFE proof-reuse governor over measured candidates."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cfe_governor import GovernorInputError, govern


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--candidates", required=True, type=Path)
    ap.add_argument("--max-verification-nodes", required=True, type=int)
    ap.add_argument("--max-time-ms", required=True, type=int)
    ap.add_argument("--max-memory-bytes", required=True, type=int)
    ap.add_argument("--max-jobs", required=True, type=int)
    ns = ap.parse_args()
    try:
        payload = json.loads(ns.candidates.read_text(encoding="utf-8"))
        if not isinstance(payload, list):
            raise GovernorInputError("candidate file must contain a JSON array")
        result = govern(
            payload,
            max_verification_nodes=ns.max_verification_nodes,
            max_time_ms=ns.max_time_ms,
            max_memory_bytes=ns.max_memory_bytes,
            max_jobs=ns.max_jobs,
        )
        print(json.dumps(result, ensure_ascii=True, sort_keys=True))
        return 0
    except (OSError, json.JSONDecodeError, GovernorInputError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=True, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
