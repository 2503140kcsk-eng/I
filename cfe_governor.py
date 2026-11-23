"""Deterministic, measurement-driven CFE proof-verification governor.

The governor allocates a finite verification budget to proof-reuse candidates.
It does not invent confidence values: callers must supply an explicit
calibrated reuse probability and measured/estimated resource costs. The
scheduler is a deterministic greedy heuristic (not a globally optimal
multi-dimensional knapsack solver); unused resources remain available to the
main search engine.
"""
from __future__ import annotations

import math
from typing import Any, Iterable

SCHEMA = "cfe.shogi.governor-input.v1"


class GovernorInputError(ValueError):
    """Malformed candidate or resource budget."""


def _positive_int(value: Any, name: str, *, allow_zero: bool = False) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise GovernorInputError(f"{name} must be an integer")
    minimum = 0 if allow_zero else 1
    if value < minimum:
        raise GovernorInputError(f"{name} must be >= {minimum}")
    return value


def _probability(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        raise GovernorInputError(f"{name} must be a number in [0, 1]")
    number = float(value)
    if not math.isfinite(number) or not 0.0 <= number <= 1.0:
        raise GovernorInputError(f"{name} must be a finite number in [0, 1]")
    return number


def _normalise_candidate(candidate: Any) -> dict[str, Any]:
    if not isinstance(candidate, dict):
        raise GovernorInputError("every candidate must be an object")
    allowed = {
        "id", "reuse_probability", "expected_saved_nodes",
        "verification_nodes", "estimated_ms", "memory_bytes",
    }
    if set(candidate) != allowed:
        raise GovernorInputError(
            "candidate must contain exactly: " + ", ".join(sorted(allowed))
        )
    identifier = candidate["id"]
    if not isinstance(identifier, str) or not identifier.strip():
        raise GovernorInputError("candidate id must be a non-empty string")
    p = _probability(candidate["reuse_probability"], f"{identifier}.reuse_probability")
    saved = _positive_int(candidate["expected_saved_nodes"], f"{identifier}.expected_saved_nodes")
    verify = _positive_int(
        candidate["verification_nodes"], f"{identifier}.verification_nodes", allow_zero=True
    )
    ms = _positive_int(candidate["estimated_ms"], f"{identifier}.estimated_ms")
    memory = _positive_int(candidate["memory_bytes"], f"{identifier}.memory_bytes", allow_zero=True)
    gross = p * saved
    net = gross - verify
    return {
        "id": identifier,
        "reuse_probability": p,
        "expected_saved_nodes": saved,
        "verification_nodes": verify,
        "estimated_ms": ms,
        "memory_bytes": memory,
        "expected_gross_saved_nodes": gross,
        "expected_net_saved_nodes": net,
        "efficiency": net / ms,
    }


def govern(
    candidates: Iterable[dict[str, Any]],
    *,
    max_verification_nodes: int,
    max_time_ms: int,
    max_memory_bytes: int,
    max_jobs: int,
) -> dict[str, Any]:
    """Choose positive-utility reuse checks under node/time/memory/job limits.

    Utility is measured in expected search nodes saved minus verification
    nodes. Candidates with non-positive expected net saved nodes are rejected.
    Eligible candidates are sorted by expected net saved nodes per estimated
    millisecond, then by net saved nodes, then stable candidate id. The greedy
    scan respects every hard budget and never overcommits a resource.
    """
    max_nodes = _positive_int(max_verification_nodes, "max_verification_nodes", allow_zero=True)
    max_ms = _positive_int(max_time_ms, "max_time_ms", allow_zero=True)
    max_memory = _positive_int(max_memory_bytes, "max_memory_bytes", allow_zero=True)
    jobs = _positive_int(max_jobs, "max_jobs")

    normalised = [_normalise_candidate(item) for item in candidates]
    identifiers = [item["id"] for item in normalised]
    if len(identifiers) != len(set(identifiers)):
        raise GovernorInputError("candidate ids must be unique")

    eligible = [item for item in normalised if item["expected_net_saved_nodes"] > 0]
    eligible.sort(key=lambda item: (
        -item["efficiency"],
        -item["expected_net_saved_nodes"],
        item["id"],
    ))

    remaining = {
        "verification_nodes": max_nodes,
        "time_ms": max_ms,
        "memory_bytes": max_memory,
        "jobs": jobs,
    }
    selected: list[dict[str, Any]] = []
    rejected: list[dict[str, str]] = []

    for item in eligible:
        if len(selected) >= jobs:
            rejected.append({"id": item["id"], "reason": "job_budget"})
        elif item["verification_nodes"] > remaining["verification_nodes"]:
            rejected.append({"id": item["id"], "reason": "verification_node_budget"})
        elif item["estimated_ms"] > remaining["time_ms"]:
            rejected.append({"id": item["id"], "reason": "time_budget"})
        elif item["memory_bytes"] > remaining["memory_bytes"]:
            rejected.append({"id": item["id"], "reason": "memory_budget"})
        else:
            selected.append(item)
            remaining["verification_nodes"] -= item["verification_nodes"]
            remaining["time_ms"] -= item["estimated_ms"]
            remaining["memory_bytes"] -= item["memory_bytes"]
            remaining["jobs"] -= 1

    for item in normalised:
        if item["expected_net_saved_nodes"] <= 0:
            rejected.append({"id": item["id"], "reason": "non_positive_expected_net_benefit"})

    return {
        "schema": "cfe.shogi.governor-decision.v1",
        "policy": "greedy-net-saved-nodes-per-ms-v1",
        "optimality": "heuristic_not_global_optimum",
        "selected": selected,
        "rejected": sorted(rejected, key=lambda row: row["id"]),
        "remaining_budget": remaining,
        "selected_expected_net_saved_nodes": sum(
            item["expected_net_saved_nodes"] for item in selected
        ),
        "unallocated_budget_policy": "leave_available_to_main_search",
    }
