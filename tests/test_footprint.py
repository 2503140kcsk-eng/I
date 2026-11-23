import unittest

from cfe_certificate import SCHEMA, verify_mate_certificate
from cfe_footprint import (
    cube_implies,
    extract_footprint,
    matches_footprint,
    try_reuse_certificate,
)
from cfe_shogi import _apply_unchecked, is_legal_move, parse_move, parse_sfen, state_identity, square_name

ROOT = "4k4/9/2NGKGN2/9/9/9/9/9/9 b - 1"
TARGET_EXTRA_PAWN = "4k4/9/2NGKGN2/9/9/9/9/9/8P b - 1"


def mate_certificate():
    root = parse_sfen(ROOT)
    move = parse_move("4c5b")
    assert is_legal_move(root, move)
    child = _apply_unchecked(root, move)
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


class FootprintTests(unittest.TestCase):
    def test_full_footprint_matches_exact_position_and_ignores_ply(self):
        cert = mate_certificate()
        cube = extract_footprint(cert, ROOT)
        self.assertTrue(matches_footprint(cube, ROOT))
        self.assertTrue(matches_footprint(cube, ROOT.rsplit(" ", 1)[0] + " 77"))
        self.assertFalse(matches_footprint(cube, TARGET_EXTRA_PAWN))

    def test_stronger_cube_implies_broader_cube(self):
        cert = mate_certificate()
        squares = [square_name(i) for i in range(81)]
        broad = extract_footprint(
            cert, ROOT,
            board_squares=[sq for sq in squares if sq != "1i"],
        )
        strong = extract_footprint(cert, ROOT)
        self.assertTrue(cube_implies(strong, broad))
        self.assertFalse(cube_implies(broad, strong))

    def test_broader_candidate_is_replayed_before_reuse(self):
        cert = mate_certificate()
        squares = [square_name(i) for i in range(81)]
        broad = extract_footprint(
            cert, ROOT,
            board_squares=[sq for sq in squares if sq != "1i"],
        )
        self.assertTrue(matches_footprint(broad, TARGET_EXTRA_PAWN))
        result = try_reuse_certificate(cert, broad, TARGET_EXTRA_PAWN)
        self.assertTrue(result["candidate_match"])
        self.assertTrue(result["reusable"])
        self.assertEqual(2, result["verification"]["identity_mismatches"])
        self.assertEqual("replay", result["verification"]["identity_policy"])

    def test_footprint_hit_does_not_accept_a_corrupt_strategy(self):
        cert = mate_certificate()
        cube = extract_footprint(cert, ROOT)
        cert["root"]["children"][0]["move"] = "4c5c"
        result = try_reuse_certificate(cert, cube, ROOT)
        self.assertTrue(result["candidate_match"])
        self.assertFalse(result["reusable"])
        self.assertEqual("proof_replay_failed", result["reason"])

    def test_empty_partial_cube_matches_any_valid_standard_position(self):
        cert = mate_certificate()
        cube = extract_footprint(
            cert, ROOT, board_squares=[], hand_counts=[], include_side=False,
        )
        self.assertTrue(matches_footprint(cube, TARGET_EXTRA_PAWN))
        self.assertTrue(cube_implies(extract_footprint(cert, ROOT), cube))


if __name__ == "__main__":
    unittest.main()
