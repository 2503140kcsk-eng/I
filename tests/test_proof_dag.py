import copy
import hashlib
import json
import unittest

from cfe_proof_dag import (
    ProofDagError,
    canonical_mate_dag,
    pack_mate_certificate_dag,
    verify_mate_certificate_dag,
)
from cfe_certificate import SCHEMA
from cfe_shogi import _apply_unchecked, parse_move, parse_sfen, state_identity

ROOT = "4k4/9/2NGKGN2/9/9/9/9/9/9 b - 1"


def mate_certificate():
    root = parse_sfen(ROOT)
    child = _apply_unchecked(root, parse_move("4c5b"))
    return {
        "schema": SCHEMA,
        "attacker": "b",
        "root": {
            "identity": state_identity(root),
            "children": [{
                "move": "4c5b",
                "node": {
                    "identity": state_identity(child),
                    "terminal": "checkmate",
                    "children": [],
                },
            }],
        },
    }


class ProofDagTests(unittest.TestCase):
    def test_packs_and_independently_verifies_mate_certificate(self):
        dag = pack_mate_certificate_dag(mate_certificate(), ROOT)
        result = verify_mate_certificate_dag(dag, ROOT)
        self.assertTrue(result["valid"])
        self.assertEqual(2, result["unique_dag_nodes"])
        self.assertEqual(2, result["verified_node_visits"])
        self.assertEqual(1, result["max_mate_plies"])

    def test_pack_is_deterministic_and_content_addressed(self):
        cert = mate_certificate()
        first = pack_mate_certificate_dag(cert, ROOT)
        second = pack_mate_certificate_dag(cert, ROOT)
        self.assertEqual(first, second)
        self.assertEqual(canonical_mate_dag(first), canonical_mate_dag(second))
        for identifier, node in first["nodes"].items():
            digest = hashlib.sha256(
                json.dumps(node, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("ascii")
            ).hexdigest()
            self.assertEqual("n" + digest, identifier)

    def test_rejects_node_content_tampering(self):
        dag = pack_mate_certificate_dag(mate_certificate(), ROOT)
        damaged = copy.deepcopy(dag)
        root = damaged["nodes"][damaged["root"]]
        root["children"][0]["move"] = "4c5c"
        with self.assertRaisesRegex(ProofDagError, "content hash"):
            verify_mate_certificate_dag(damaged, ROOT)

    def test_rejects_missing_edge_target(self):
        dag = pack_mate_certificate_dag(mate_certificate(), ROOT)
        damaged = copy.deepcopy(dag)
        root = damaged["nodes"][damaged["root"]]
        target = root["children"][0]["target"]
        del damaged["nodes"][target]
        with self.assertRaisesRegex(ProofDagError, "target does not exist"):
            verify_mate_certificate_dag(damaged, ROOT)

    def test_rejects_unreachable_node(self):
        dag = pack_mate_certificate_dag(mate_certificate(), ROOT)
        orphan = {
            "identity": state_identity(parse_sfen(ROOT)),
            "children": [],
        }
        digest = hashlib.sha256(
            json.dumps(orphan, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("ascii")
        ).hexdigest()
        damaged = copy.deepcopy(dag)
        damaged["nodes"]["n" + digest] = orphan
        with self.assertRaisesRegex(ProofDagError, "unreachable nodes"):
            verify_mate_certificate_dag(damaged, ROOT)

    def test_rejects_invalid_identity_even_in_replay_policy(self):
        dag = pack_mate_certificate_dag(mate_certificate(), ROOT)
        damaged = copy.deepcopy(dag)
        root = damaged["nodes"][damaged["root"]]
        root["identity"]["state_key"] = "0" * 64
        identifier = damaged["root"]
        del damaged["nodes"][identifier]
        new_digest = hashlib.sha256(
            json.dumps(root, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("ascii")
        ).hexdigest()
        damaged["root"] = "n" + new_digest
        damaged["nodes"]["n" + new_digest] = root
        with self.assertRaisesRegex(ProofDagError, "identity digest"):
            verify_mate_certificate_dag(damaged, ROOT, identity_policy="replay")

    def test_rejects_proof_depth_and_node_visit_limit(self):
        dag = pack_mate_certificate_dag(mate_certificate(), ROOT)
        with self.assertRaisesRegex(ProofDagError, "depth exceeds"):
            verify_mate_certificate_dag(dag, ROOT, max_depth=0)
        with self.assertRaisesRegex(ProofDagError, "DAG node count exceeds"):
            verify_mate_certificate_dag(dag, ROOT, max_nodes=1)


if __name__ == "__main__":
    unittest.main()
