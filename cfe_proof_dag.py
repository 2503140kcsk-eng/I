"""Content-addressed DAG packing and independent verification for mate proofs.

A DAG node may be referenced by multiple parents. Verification deliberately
replays a shared node separately for every incoming path: legal moves,
defender completeness, terminal checkmate and path-repeat checks are
context-sensitive. Content hashes protect node payload integrity; they are
not treated as proof of move legality.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from cfe_shogi import (
    _apply_unchecked,
    canonical_state,
    in_check,
    is_legal_move,
    legal_moves,
    parse_move,
    parse_sfen,
    state_identity,
)
from cfe_certificate import (
    CertificateVerificationError,
    _validate_identity_record,
    verify_mate_certificate,
)

SCHEMA = "cfe.shogi.mate-dag-certificate.v1"
NODE_ID_RE = re.compile(r"^n[0-9a-f]{64}$")


class ProofDagError(ValueError):
    """Malformed or invalid CFE mate proof DAG."""


def _require(condition: bool, message: str, path: str) -> None:
    if not condition:
        raise ProofDagError(f"{path}: {message}")


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def _node_id(payload: dict[str, Any]) -> str:
    digest = hashlib.sha256(_canonical_json(payload).encode("ascii")).hexdigest()
    return "n" + digest


def pack_mate_certificate_dag(
    certificate: dict[str, Any],
    root_sfen: str,
    *,
    max_nodes: int = 100_000,
    max_depth: int = 512,
) -> dict[str, Any]:
    """Verify a tree certificate, then hash-cons identical proof subtrees."""
    verify_mate_certificate(
        certificate, root_sfen, max_nodes=max_nodes, max_depth=max_depth,
        identity_policy="strict",
    )
    table: dict[str, dict[str, Any]] = {}
    expanded = [0]

    def intern(tree_node: dict[str, Any], depth: int) -> str:
        if depth > max_depth:
            raise ProofDagError(f"proof depth exceeds limit {max_depth}")
        expanded[0] += 1
        if expanded[0] > max_nodes:
            raise ProofDagError(f"proof tree node count exceeds limit {max_nodes}")

        children = []
        for child in tree_node["children"]:
            target = intern(child["node"], depth + 1)
            children.append({"move": child["move"], "target": target})

        payload: dict[str, Any] = {
            "identity": tree_node["identity"],
            "children": children,
        }
        if "terminal" in tree_node:
            payload["terminal"] = tree_node["terminal"]
        identifier = _node_id(payload)
        prior = table.get(identifier)
        if prior is not None and prior != payload:
            raise ProofDagError("SHA-256 node-id collision detected")
        table[identifier] = payload
        return identifier

    root_id = intern(certificate["root"], 0)
    dag = {
        "schema": SCHEMA,
        "attacker": certificate["attacker"],
        "root": root_id,
        "nodes": {identifier: table[identifier] for identifier in sorted(table)},
    }
    verify_mate_certificate_dag(
        dag, root_sfen, max_nodes=max_nodes, max_depth=max_depth,
        identity_policy="strict",
    )
    return dag


def verify_mate_certificate_dag(
    dag: Any,
    root_sfen: str,
    *,
    max_nodes: int = 100_000,
    max_depth: int = 512,
    identity_policy: str = "strict",
) -> dict[str, Any]:
    """Replay and independently verify a content-addressed AND/OR proof DAG.

    Shared nodes are not memo-accepted: every incoming path re-evaluates them
    against the reached position. This is essential because a graph node can
    be reached under different path histories even when its stored logic is
    identical.
    """
    _require(isinstance(max_nodes, int) and not isinstance(max_nodes, bool) and max_nodes >= 1,
             "max_nodes must be a positive integer", "$limits")
    _require(isinstance(max_depth, int) and not isinstance(max_depth, bool) and max_depth >= 0,
             "max_depth must be a non-negative integer", "$limits")
    _require(identity_policy in ("strict", "replay"),
             "identity_policy must be strict or replay", "$limits")
    _require(isinstance(dag, dict), "DAG must be an object", "$")
    _require(set(dag) == {"schema", "attacker", "root", "nodes"},
             "DAG must contain exactly schema, attacker, root, and nodes", "$")
    _require(dag.get("schema") == SCHEMA, f"schema must be {SCHEMA}", "$.schema")
    attacker = dag.get("attacker")
    _require(attacker in ("b", "w"), "attacker must be 'b' or 'w'", "$.attacker")

    nodes = dag.get("nodes")
    _require(isinstance(nodes, dict) and bool(nodes), "nodes must be a non-empty object", "$.nodes")
    _require(len(nodes) <= max_nodes, f"DAG node count exceeds limit {max_nodes}", "$.nodes")
    root_id = dag.get("root")
    _require(isinstance(root_id, str) and root_id in nodes, "root id is missing from nodes", "$.root")

    # Validate the whole table and content-addressed IDs before any replay.
    for identifier, node in nodes.items():
        path = f"$.nodes[{identifier}]"
        _require(isinstance(identifier, str) and NODE_ID_RE.fullmatch(identifier),
                 "node id must be n followed by 64 lowercase hex digits", path)
        _require(isinstance(node, dict), "node must be an object", path)
        _require(set(node).issubset({"identity", "children", "terminal"}),
                 "node contains unknown fields", path)
        _require("identity" in node and "children" in node,
                 "node requires identity and children", path)
        _require(isinstance(node["children"], list), "children must be an array", path + ".children")
        for index, edge in enumerate(node["children"]):
            edge_path = f"{path}.children[{index}]"
            _require(isinstance(edge, dict) and set(edge) == {"move", "target"},
                     "edge must contain exactly move and target", edge_path)
            _require(isinstance(edge["move"], str), "edge move must be a string", edge_path + ".move")
            _require(isinstance(edge["target"], str), "edge target must be a string", edge_path + ".target")
            _require(edge["target"] in nodes, "edge target does not exist", edge_path + ".target")
        expected_id = _node_id(node)
        _require(identifier == expected_id, "node id does not match canonical content hash", path)

    position = parse_sfen(root_sfen)
    budget = [0]
    visited_ids: set[str] = set()
    active_ids: set[str] = set()
    identity_mismatches = [0]

    def visit(
        identifier: str,
        current,
        *,
        path: str,
        depth: int,
        ancestor_states: frozenset[str],
    ) -> int:
        _require(depth <= max_depth, f"proof depth exceeds limit {max_depth}", path)
        budget[0] += 1
        _require(budget[0] <= max_nodes, f"proof node visits exceed limit {max_nodes}", path)
        _require(identifier not in active_ids, "cycle detected in proof DAG", path)
        active_ids.add(identifier)
        visited_ids.add(identifier)
        node = nodes[identifier]
        try:
            try:
                recorded_identity = _validate_identity_record(node["identity"], path + ".identity")
            except CertificateVerificationError as exc:
                raise ProofDagError(f"{path}.identity: {exc}") from exc
            expected_identity = state_identity(current)
            if recorded_identity != expected_identity:
                if identity_policy == "strict":
                    raise ProofDagError(
                        f"{path}.identity: node identity does not match replayed position"
                    )
                identity_mismatches[0] += 1

            children = node["children"]
            side = current.side
            moves = legal_moves(current)
            terminal = node.get("terminal")

            if terminal is not None:
                _require(terminal == "checkmate", "unsupported terminal claim", path + ".terminal")
                _require(side != attacker, "attacker cannot be checkmated", path)
                _require(in_check(current, side), "terminal node is not check", path)
                _require(not moves, "terminal node still has a legal reply", path)
                _require(not children, "checkmate leaf must not have children", path + ".children")
                return 0

            _require(bool(children), "non-terminal node must have children", path + ".children")
            edge_moves: list[str] = []
            for index, edge in enumerate(children):
                edge_moves.append(edge["move"])
            _require(len(edge_moves) == len(set(edge_moves)),
                     "duplicate child move", path + ".children")

            if side == attacker:
                _require(len(children) == 1, "attacker OR node must choose exactly one move", path)
                edge = children[0]
                try:
                    move = parse_move(edge["move"])
                except ValueError as exc:
                    raise ProofDagError(f"{path}: invalid USI move: {exc}") from exc
                _require(is_legal_move(current, move), f"illegal attacker move: {edge['move']}", path)
                after = _apply_unchecked(current, move)
                next_state = canonical_state(after)
                _require(next_state not in ancestor_states,
                         "repeated position on branch; repetition is outside DAG v1", path)
                return 1 + visit(
                    edge["target"], after, path=path + ".children[0]",
                    depth=depth + 1, ancestor_states=ancestor_states | {next_state},
                )

            _require(edge_moves == sorted(edge_moves),
                     "defender children must be sorted lexicographically by USI move", path)
            _require(
                set(edge_moves) == set(moves),
                "defender children must cover the complete legal-move set; "
                f"missing={sorted(set(moves) - set(edge_moves))}, "
                f"extra={sorted(set(edge_moves) - set(moves))}",
                path + ".children",
            )
            branch_lengths = []
            for index, edge in enumerate(children):
                move = parse_move(edge["move"])
                _require(is_legal_move(current, move), f"illegal defender reply: {edge['move']}", path)
                after = _apply_unchecked(current, move)
                next_state = canonical_state(after)
                _require(next_state not in ancestor_states,
                         "repeated position on branch; repetition is outside DAG v1", path)
                branch_lengths.append(visit(
                    edge["target"], after, path=f"{path}.children[{index}]",
                    depth=depth + 1, ancestor_states=ancestor_states | {next_state},
                ))
            return 1 + max(branch_lengths, default=0)
        finally:
            active_ids.remove(identifier)

    root_state = canonical_state(position)
    max_plies = visit(
        root_id, position, path="$.root", depth=0,
        ancestor_states=frozenset({root_state}),
    )
    _require(visited_ids == set(nodes), "DAG contains unreachable nodes", "$.nodes")
    root_identity = state_identity(position)
    return {
        "valid": True,
        "schema": SCHEMA,
        "attacker": attacker,
        "root_state_key": root_identity["state_key"],
        "unique_dag_nodes": len(nodes),
        "verified_node_visits": budget[0],
        "identity_policy": identity_policy,
        "identity_mismatches": identity_mismatches[0],
        "max_mate_plies": max_plies,
    }


def canonical_mate_dag(dag: dict[str, Any]) -> str:
    """Return deterministic JSON text for the content-addressed DAG."""
    return _canonical_json(dag)
