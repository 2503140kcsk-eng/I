#!/usr/bin/env python3
"""Pack a verified CFE mate tree into a content-addressed proof DAG."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cfe_proof_dag import canonical_mate_dag, pack_mate_certificate_dag


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root-sfen", required=True)
    ap.add_argument("--certificate", required=True, type=Path)
    ap.add_argument("--output", required=True, type=Path)
    ap.add_argument("--max-nodes", type=int, default=100_000)
    ap.add_argument("--max-depth", type=int, default=512)
    ns = ap.parse_args()
    try:
        cert = json.loads(ns.certificate.read_text(encoding="utf-8"))
        dag = pack_mate_certificate_dag(
            cert, ns.root_sfen, max_nodes=ns.max_nodes, max_depth=ns.max_depth,
        )
        ns.output.parent.mkdir(parents=True, exist_ok=True)
        ns.output.write_text(canonical_mate_dag(dag) + "\n", encoding="utf-8")
        print(json.dumps({
            "ok": True,
            "dag_nodes": len(dag["nodes"]),
            "output": str(ns.output),
        }, ensure_ascii=True, sort_keys=True))
        return 0
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=True, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
