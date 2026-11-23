import unittest

from cfe_governor import GovernorInputError, govern


def candidate(identifier, p, saved, verify, ms, memory):
    return {
        "id": identifier,
        "reuse_probability": p,
        "expected_saved_nodes": saved,
        "verification_nodes": verify,
        "estimated_ms": ms,
        "memory_bytes": memory,
    }


class GovernorTests(unittest.TestCase):
    def budget(self, **overrides):
        values = {
            "max_verification_nodes": 10_000,
            "max_time_ms": 10_000,
            "max_memory_bytes": 10_000_000,
            "max_jobs": 10,
        }
        values.update(overrides)
        return values

    def test_selects_positive_utility_candidates_in_efficiency_order(self):
        result = govern([
            candidate("slow", 0.9, 10_000, 1_000, 100, 1000),
            candidate("fast", 0.8, 10_000, 100, 10, 1000),
        ], **self.budget())
        self.assertEqual(["fast", "slow"], [x["id"] for x in result["selected"]])
        self.assertEqual("greedy-net-saved-nodes-per-ms-v1", result["policy"])

    def test_respects_all_hard_resource_budgets(self):
        result = govern([
            candidate("a", 0.99, 10_000, 600, 60, 600),
            candidate("b", 0.99, 10_000, 600, 60, 600),
            candidate("c", 0.99, 10_000, 600, 60, 600),
        ], **self.budget(
            max_verification_nodes=1200,
            max_time_ms=120,
            max_memory_bytes=1200,
            max_jobs=2,
        ))
        self.assertEqual(2, len(result["selected"]))
        self.assertEqual(0, result["remaining_budget"]["verification_nodes"])
        self.assertEqual(0, result["remaining_budget"]["time_ms"])
        self.assertEqual(0, result["remaining_budget"]["memory_bytes"])
        self.assertEqual("job_budget", result["rejected"][0]["reason"])

    def test_rejects_negative_expected_benefit(self):
        result = govern([
            candidate("bad", 0.1, 100, 50, 1, 1),
        ], **self.budget())
        self.assertEqual([], result["selected"])
        self.assertEqual("non_positive_expected_net_benefit", result["rejected"][0]["reason"])

    def test_result_is_deterministic_under_input_permutation(self):
        a = candidate("a", 0.9, 1000, 100, 10, 100)
        b = candidate("b", 0.9, 1000, 100, 10, 100)
        kwargs = self.budget(max_verification_nodes=100, max_time_ms=10, max_memory_bytes=100, max_jobs=1)
        first = govern([a, b], **kwargs)
        second = govern([b, a], **kwargs)
        self.assertEqual(first, second)
        self.assertEqual("a", first["selected"][0]["id"])

    def test_rejects_nan_probability_and_duplicate_ids(self):
        with self.assertRaisesRegex(GovernorInputError, "finite number"):
            govern([candidate("bad", float("nan"), 100, 1, 1, 1)], **self.budget())
        a = candidate("same", 0.9, 100, 1, 1, 1)
        with self.assertRaisesRegex(GovernorInputError, "unique"):
            govern([a, a], **self.budget())

    def test_rejects_boolean_as_numeric_budget_or_probability(self):
        with self.assertRaisesRegex(GovernorInputError, "max_time_ms must be an integer"):
            govern([], **self.budget(max_time_ms=True))
        with self.assertRaisesRegex(GovernorInputError, "reuse_probability"):
            govern([candidate("bad", True, 100, 1, 1, 1)], **self.budget())


if __name__ == "__main__":
    unittest.main()
