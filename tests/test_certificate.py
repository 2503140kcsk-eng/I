import json
import unittest

from cfe_certificate import (
    SCHEMA,
    CertificateVerificationError,
    canonical_certificate,
    verify_mate_certificate,
)
from cfe_shogi import (
    _apply_unchecked,
    is_legal_move,
    legal_moves,
    parse_move,
    parse_sfen,
    state_identity,
)

ROOT = "4k4/9/2NGKGN2/9/9/9/9/9/9 b - 1"
START = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1"


def one_move_mate_certificate():
    root = parse_sfen(ROOT)
    move = parse_move("4c5b")
    assert is_legal_move(root, move)
    mate = _apply_unchecked(root, move)
    return {
        "schema": SCHEMA,
        "attacker": "b",
        "root": {
            "identity": state_identity(root),
            "children": [{
                "move": "4c5b",
                "node": {
                    "identity": state_identity(mate),
                    "terminal": "checkmate",
                    "children": [],
                },
            }],
        },
    }


class CertificateVerifierTests(unittest.TestCase):
    def test_verifies_one_ply_forced_mate(self):
        result = verify_mate_certificate(one_move_mate_certificate(), ROOT)
        self.assertTrue(result["valid"])
        self.assertEqual(2, result["verified_nodes"])
        self.assertEqual(1, result["max_mate_plies"])
        self.assertEqual("b", result["attacker"])

    def test_checked_in_example_certificate_verifies(self):
        from pathlib import Path
        example = Path(__file__).resolve().parents[1] / "examples/mate-in-1.certificate.json"
        cert = json.loads(example.read_text(encoding="utf-8"))
        result = verify_mate_certificate(cert, ROOT)
        self.assertTrue(result["valid"])
        self.assertEqual(1, result["max_mate_plies"])

    def test_rejects_certificate_for_a_different_root(self):
        with self.assertRaisesRegex(CertificateVerificationError, "identity"):
            verify_mate_certificate(one_move_mate_certificate(), START)

    def test_rejects_forged_child_state_key(self):
        cert = one_move_mate_certificate()
        cert["root"]["children"][0]["node"]["identity"]["state_key"] = "0" * 64
        with self.assertRaisesRegex(CertificateVerificationError, "identity"):
            verify_mate_certificate(cert, ROOT)

    def test_defender_node_must_cover_every_legal_move(self):
        root = parse_sfen(START)
        first = legal_moves(root)[0]
        cert = {
            "schema": SCHEMA,
            "attacker": "w",
            "root": {
                "identity": state_identity(root),
                "children": [{
                    "move": first,
                    "node": {
                        "identity": state_identity(root),
                        "children": [],
                        "terminal": "checkmate",
                    },
                }],
            },
        }
        with self.assertRaisesRegex(CertificateVerificationError, "complete legal-move set"):
            verify_mate_certificate(cert, START)

    def test_attacker_must_choose_exactly_one_proof_move(self):
        root = parse_sfen(ROOT)
        cert = one_move_mate_certificate()
        second_move = legal_moves(root)[0]
        first_move = cert["root"]["children"][0]["move"]
        if second_move == first_move:
            second_move = legal_moves(root)[1]
        cert["root"]["children"].append({
            "move": second_move,
            "node": cert["root"]["children"][0]["node"],
        })
        with self.assertRaisesRegex(CertificateVerificationError, "exactly one move"):
            verify_mate_certificate(cert, ROOT)

    def test_verification_resource_limits_are_enforced(self):
        with self.assertRaisesRegex(CertificateVerificationError, "node count exceeds"):
            verify_mate_certificate(one_move_mate_certificate(), ROOT, max_nodes=1)
        with self.assertRaisesRegex(CertificateVerificationError, "depth exceeds"):
            verify_mate_certificate(one_move_mate_certificate(), ROOT, max_depth=0)

    def test_canonical_certificate_is_deterministic_json(self):
        cert = one_move_mate_certificate()
        encoded = canonical_certificate(cert)
        self.assertEqual(encoded, canonical_certificate(json.loads(encoded)))
        self.assertNotIn(": ", encoded)


if __name__ == "__main__":
    unittest.main()
