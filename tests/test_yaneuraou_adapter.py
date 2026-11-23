"""Tests for the exact YaneuraOu perft-divide parser."""
import unittest

from tools.compare_yaneuraou import parse_perft_output


class YaneuraOuPerftParserTests(unittest.TestCase):
    def test_parses_normal_promotion_and_drop_moves(self):
        lines = [
            "info string perft start",
            "7g7f: 1",
            "2b2h+: 1",
            "P*5e: 1",
            "Elapsed Time = 1 [ms]",
            "1000 NPS",
        ]
        self.assertEqual(
            (("2b2h+", "7g7f", "P*5e"), 3),
            parse_perft_output(lines, "Nodes searched: 3"),
        )

    def test_zero_move_position(self):
        self.assertEqual(((), 0), parse_perft_output([], "Nodes searched: 0"))

    def test_rejects_summary_without_all_root_moves(self):
        with self.assertRaisesRegex(ValueError, "do not match summary"):
            parse_perft_output(["7g7f: 1"], "Nodes searched: 2")

    def test_rejects_duplicate_root_move(self):
        with self.assertRaisesRegex(ValueError, "duplicate move"):
            parse_perft_output(["7g7f: 1", "7g7f: 1"], "Nodes searched: 2")

    def test_rejects_non_unit_depth_one_count(self):
        with self.assertRaisesRegex(ValueError, "must be 1"):
            parse_perft_output(["7g7f: 2"], "Nodes searched: 2")

    def test_rejects_malformed_summary(self):
        with self.assertRaisesRegex(ValueError, "unrecognised"):
            parse_perft_output(["7g7f: 1"], "perft complete")


if __name__ == "__main__":
    unittest.main()
