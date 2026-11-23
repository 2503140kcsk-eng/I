import unittest

import json
from pathlib import Path

from cfe_shogi import (
    Move, Piece, Position, ShogiError, canonical_sfen,
    canonical_state, has_legal_move, in_check, is_legal_move, legal_moves,
    parse_move, parse_sfen, perft, state_identity, position_envelope,
    state_key, to_sfen,
)

START = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1"


class SfenTests(unittest.TestCase):
    def test_start_round_trip_and_canonical(self):
        self.assertEqual(START, canonical_sfen(START))
        self.assertEqual(START, to_sfen(parse_sfen(START)))

    def test_identity_carries_exact_canonical_state_and_version(self):
        identity = state_identity(START)
        self.assertEqual("CFE-SHOGI-STATE-V1", identity["key_version"])
        self.assertEqual(canonical_state(START), identity["canonical_state"])
        self.assertEqual(state_key(START), identity["state_key"])

    def test_portable_position_envelope_is_schema_versioned(self):
        envelope = position_envelope(parse_sfen(START))
        self.assertEqual("cfe.shogi.position.v1", envelope["schema"])
        self.assertEqual(START, envelope["canonical_sfen"])
        self.assertEqual(state_key(START), envelope["identity"]["digest"])
        self.assertEqual(30, len(envelope["legal_moves"]))

    def test_hand_distribution_and_side_are_part_of_state_identity(self):
        a = "4k4/9/9/9/9/9/9/9/4K4 b R 1"
        b = "4k4/9/9/9/9/9/9/9/4K4 b B 1"
        c = "4k4/9/9/9/9/9/9/9/4K4 w R 1"
        self.assertNotEqual(state_key(a), state_key(b))
        self.assertNotEqual(state_key(a), state_key(c))

    def test_move_number_is_not_part_of_state_identity(self):
        a = START
        b = START[:-1] + "999"
        self.assertNotEqual(a, b)
        self.assertEqual(canonical_state(a), canonical_state(b))
        self.assertEqual(state_key(a), state_key(b))

    def test_hand_order_is_canonicalized(self):
        sfen = "4k4/9/9/9/9/9/9/9/4K4 b P2Rbg 17"
        normalized = canonical_sfen(sfen)
        self.assertEqual("4k4/9/9/9/9/9/9/9/4K4 b 2RPbg 17", normalized)

    def test_rejects_malformed_sfen(self):
        bad = [
            "9/9/9/9/9/9/9/9/9 b - 1",  # missing kings
            "9/9/9/9/9/9/9/9/4K4 b - 1",  # missing white king
            "9/9/9/9/9/9/9/9/4K4 x - 1",
            "9/9/9/9/9/9/9/9/4K4 b - 0",
            "99/9/9/9/9/9/9/9/4K4 b - 1",
            "4+G4/9/9/9/9/9/9/9/4K3k b - 1",
            "4k4/9/9/9/9/9/9/9/4K4 b P1P 1",
            "4k4/9/9/9/9/9/9/9/4K4 b 19P 1",  # physical material overflow
            "4k4/9/9/9/9/9/9/9/4K4 b - 65536",  # shogi-rs-compatible ply bound
            "4k4/9/9/9/9/9/9/9/4K4 b - 01",  # no leading zero
            "4k4/9/9/9/9/9/9/9/4K4 b ²P 1",  # ASCII-only count syntax
            "K3k4/9/9/9/9/9/9/9/4K4 b - 1",  # ASCII-only piece alphabet
            "4k4/9/9/9/9/9/9/9/4K4\u00a0b - 1",  # Unicode whitespace is not SFEN ASCII
        ]
        for s in bad:
            with self.subTest(sfen=s), self.assertRaises(ShogiError):
                parse_sfen(s)


class MoveTests(unittest.TestCase):
    def test_initial_legal_moves(self):
        p = parse_sfen(START)
        moves = legal_moves(p)
        self.assertEqual(30, len(moves))
        self.assertIn("7g7f", moves)
        self.assertFalse(is_legal_move(p, parse_move("7g7e")))
        self.assertEqual(900, perft(p, 2))
        self.assertEqual(25_470, perft(p, 3))

    def test_promotion_zone(self):
        s = "8k/9/9/4P4/9/9/9/9/K8 b - 1"
        p = parse_sfen(s)
        self.assertTrue(is_legal_move(p, parse_move("5d5c+")))
        self.assertTrue(is_legal_move(p, parse_move("5d5c")))

    def test_mandatory_promotion(self):
        s = "8k/4P4/9/9/9/9/9/9/K8 b - 1"
        p = parse_sfen(s)
        self.assertFalse(is_legal_move(p, parse_move("5b5a")))
        self.assertTrue(is_legal_move(p, parse_move("5b5a+")))

    def test_drop_rules(self):
        s = "8k/9/9/4P4/9/9/9/9/K8 b PN 1"
        p = parse_sfen(s)
        self.assertFalse(is_legal_move(p, parse_move("P*5f")))  # nifu
        self.assertFalse(is_legal_move(p, parse_move("P*4a")))  # pawn dead rank
        self.assertFalse(is_legal_move(p, parse_move("N*4b")))  # knight dead rank
        self.assertTrue(is_legal_move(p, parse_move("P*4f")))

    def test_discovered_self_check_is_rejected(self):
        s = "4r3k/9/9/9/4G4/9/9/9/4K4 b - 1"
        p = parse_sfen(s)
        self.assertFalse(is_legal_move(p, parse_move("5e4e")))

    def test_king_cannot_step_into_rook_attack(self):
        s = "3r4k/9/9/9/4K4/9/9/9/9 b - 1"
        p = parse_sfen(s)
        self.assertFalse(is_legal_move(p, parse_move("5e6e")))

    def test_capture_of_promoted_piece_returns_unpromoted_hand_piece(self):
        s = "4k4/9/9/9/4+p4/4G4/9/9/4K4 b - 1"
        p = parse_sfen(s)
        from cfe_shogi import _apply_unchecked
        move = parse_move("5f5e")
        self.assertTrue(is_legal_move(p, move))
        after = _apply_unchecked(p, move)
        self.assertEqual(1, after.hand_count("b", "P"))
        self.assertEqual("G", after.piece_at(parse_move("5f5e").to_sq).kind)

    def test_drop_may_interpose_against_check(self):
        s = "4r3k/9/9/9/4K4/9/9/9/9 b G 1"
        p = parse_sfen(s)
        self.assertTrue(in_check(p, "b"))
        self.assertTrue(is_legal_move(p, parse_move("G*5c")))

    def test_checking_pawn_drop_with_king_escape_is_legal(self):
        s = "k8/9/9/9/9/9/9/9/8K b P 1"
        p = parse_sfen(s)
        self.assertTrue(is_legal_move(p, parse_move("P*9b")))

    def test_blocked_rook_cannot_jump(self):
        s = "4k4/9/9/4P4/4R4/9/9/9/K8 b - 1"
        p = parse_sfen(s)
        self.assertFalse(is_legal_move(p, parse_move("5e5c")))

    def test_promoted_bishop_has_orthogonal_step(self):
        s = "8k/9/9/9/4+B4/9/9/9/K8 b - 1"
        p = parse_sfen(s)
        self.assertTrue(is_legal_move(p, parse_move("5e5d")))
        self.assertFalse(is_legal_move(p, parse_move("5e5b")))

    def test_promoted_rook_has_diagonal_step(self):
        s = "8k/9/9/9/4+R4/9/9/9/K8 b - 1"
        p = parse_sfen(s)
        self.assertTrue(is_legal_move(p, parse_move("5e6d")))
        self.assertFalse(is_legal_move(p, parse_move("5e7d")))

    def _center_piece_position(self, symbol):
        if symbol == "K":
            return parse_sfen("8k/9/9/9/4K4/9/9/9/9 b - 1")
        return parse_sfen(f"8k/9/9/9/4{symbol}4/9/9/9/K8 b - 1")

    def test_all_unpromoted_piece_movement_families(self):
        cases = {
            "P": ({"5d"}, {"5f", "4d"}),
            "L": ({"5d", "5c", "5b"}, {"5f", "4d", "5a"}),
            "N": ({"4c", "6c"}, {"4d", "5c"}),
            "S": ({"5d", "4d", "6d", "4f", "6f"}, {"5f", "4e"}),
            "G": ({"5d", "4d", "6d", "4e", "6e", "5f"}, {"4f", "5c"}),
            "K": ({"4d", "5d", "6d", "4e", "6e", "4f", "5f", "6f"}, {"3e"}),
            "B": ({"4d", "6d", "4f", "6f", "3c", "7g"}, {"5d", "4e"}),
            "R": ({"5d", "5c", "5b", "5a", "5f", "5g", "4e", "3e", "6e", "7e"}, {"4d", "4f"}),
        }
        for symbol, (legal_dests, illegal_dests) in cases.items():
            with self.subTest(piece=symbol):
                pos = self._center_piece_position(symbol)
                for dest in legal_dests:
                    self.assertTrue(is_legal_move(pos, parse_move(f"5e{dest}")), dest)
                for dest in illegal_dests:
                    self.assertFalse(is_legal_move(pos, parse_move(f"5e{dest}")), dest)

    def test_promoted_gold_like_and_major_piece_movement(self):
        gold_like = {"5d", "4d", "6d", "4e", "6e", "5f"}
        for symbol in ("+P", "+L", "+N", "+S"):
            with self.subTest(piece=symbol):
                pos = self._center_piece_position(symbol)
                for dest in gold_like:
                    self.assertTrue(is_legal_move(pos, parse_move(f"5e{dest}")), dest)
                self.assertFalse(is_legal_move(pos, parse_move("5e4f")))
        horse = self._center_piece_position("+B")
        self.assertTrue(is_legal_move(horse, parse_move("5e5d")))
        self.assertTrue(is_legal_move(horse, parse_move("5e4d")))
        self.assertFalse(is_legal_move(horse, parse_move("5e5c")))
        dragon = self._center_piece_position("+R")
        self.assertTrue(is_legal_move(dragon, parse_move("5e5d")))
        self.assertTrue(is_legal_move(dragon, parse_move("5e6d")))
        self.assertFalse(is_legal_move(dragon, parse_move("5e6c")))

    def test_promotion_is_optional_only_when_permitted(self):
        outside_zone = self._center_piece_position("P")
        self.assertFalse(is_legal_move(outside_zone, parse_move("5e5d+")))
        lance = self._center_piece_position("L")
        self.assertFalse(is_legal_move(lance, parse_move("5e5a")))
        self.assertTrue(is_legal_move(lance, parse_move("5e5a+")))
        already_promoted = self._center_piece_position("+P")
        self.assertFalse(is_legal_move(already_promoted, parse_move("5e5d+")))
        gold = self._center_piece_position("G")
        self.assertFalse(is_legal_move(gold, parse_move("5e5d+")))

    def test_corpus_obeys_rotate_and_color_swap_symmetry(self):
        def rotate_swap(pos):
            board = [None] * 81
            for square, piece in enumerate(pos.board):
                if piece is not None:
                    board[80 - square] = Piece(
                        "w" if piece.owner == "b" else "b", piece.kind, piece.promoted
                    )
            return Position(
                tuple(board), "w" if pos.side == "b" else "b",
                (pos.hands[1], pos.hands[0]), pos.ply,
            )

        def rotate_move(usi):
            move = parse_move(usi)
            if move.drop_kind is not None:
                return Move(None, 80 - move.to_sq, False, move.drop_kind).to_usi()
            return Move(80 - move.from_sq, 80 - move.to_sq, move.promote).to_usi()

        corpus = Path(__file__).resolve().parents[1] / "corpus/sfen-v1.jsonl"
        for line in corpus.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            original = parse_sfen(row["sfen"])
            mirrored = rotate_swap(original)
            with self.subTest(case=row["id"]):
                expected = {rotate_move(m) for m in legal_moves(original)}
                self.assertEqual(expected, set(legal_moves(mirrored)))
                self.assertEqual(
                    canonical_state(mirrored), canonical_state(to_sfen(mirrored))
                )

    def test_uchifuzume(self):
        # Black K5c protects the dropped P5b; G4c/G6c cover 4b/6b;
        # N3c/N7c cover 4a/6a. The white king on 5a has no legal reply.
        s = "4k4/9/2NGKGN2/9/9/9/9/9/9 b P 1"
        p = parse_sfen(s)
        self.assertFalse(in_check(p, "w"))
        # Applying the checking pawn drop would put White in check, but no
        # legal king move or capture exists, so uchifuzume forbids the drop.
        from cfe_shogi import _apply_unchecked
        after = _apply_unchecked(p, parse_move("P*5b"))
        self.assertTrue(in_check(after, "w"))
        self.assertFalse(has_legal_move(after))
        self.assertFalse(is_legal_move(p, parse_move("P*5b")))


if __name__ == "__main__":
    unittest.main()
