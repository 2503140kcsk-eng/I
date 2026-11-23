"""Independent verifier for finite forced-checkmate proof trees.

This is a deliberately small, sound proof format for standard 9x9 shogi.
Attacker nodes are OR nodes (one certified legal move is enough); defender
nodes are AND nodes (every legal reply must be present). Leaves are accepted
only when the defender is in check and has no legal move. Repeated position
states on one branch are rejected so the verifier never silently reasons
through repetition/perpetual-check adjudication that is outside this version.
"""
from __future__ import annotations

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

SCHEMA = "cfe.shogi.mate-certificate.v1"


class CertificateVerificationError(ValueError):
    """The supplied certificate does not prove the declared forced mate."""


def _require(condition: bool, message: str, path: str) -> None:
    if not condition:
        raise CertificateVerificationError(f"{path}: {message}")


def _identity_for_position(position) -> dict[str, str]:
    return state_identity(position)


def build_node_identity(sfen: str) -> dict[str, str]:
    """Build the exact CFE identity record expected in a certificate node."""
    return _identity_for_position(parse_sfen(sfen))


def _verify_node(
    node: Any,
    position,
    attacker: str,
    *,
    path: str,
    depth: int,
    max_depth: int,
    budget: list[int],
    max_nodes: int,
    ancestor_states: frozenset[str],
) -> int:
    _require(isinstance(node, dict), "node must be an object", path)
    _require(set(node).issubset({"identity", "children", "terminal"}),
             "node contains unknown fields", path)
    _require("identity" in node, "identity is required", path)
    _require("children" in node, "children is required", path)
    _require(depth <= max_depth, f"proof depth exceeds limit {max_depth}", path)

    budget[0] += 1
    _require(budget[0] <= max_nodes, f"proof node count exceeds limit {max_nodes}", path)

    expected_identity = _identity_for_position(position)
    _require(
        node["identity"] == expected_identity,
        "node identity does not match the position reached by replay",
        path + ".identity",
    )

    children = node["children"]
    _require(isinstance(children, list), "children must be an array", path + ".children")
    side = position.side
    moves = legal_moves(position)
    terminal = node.get("terminal")

    if terminal is not None:
        _require(terminal == "checkmate", "unsupported terminal claim", path + ".terminal")
        _require(side != attacker, "attacker cannot be the checkmated side", path)
        _require(in_check(position, side), "terminal node is not check", path)
        _require(not moves, "terminal node still has a legal reply", path)
        _require(not children, "checkmate leaf must not have children", path + ".children")
        return 0

    _require(children, "non-terminal proof node must have children", path + ".children")
    _require(side == attacker or side in ("b", "w"), "invalid side to move", path)

    child_moves: list[str] = []
    for index, child in enumerate(children):
        child_path = f"{path}.children[{index}]"
        _require(isinstance(child, dict), "child must be an object", child_path)
        _require(set(child) == {"move", "node"},
                 "child must contain exactly move and node", child_path)
        move_text = child["move"]
        _require(isinstance(move_text, str), "move must be a string", child_path + ".move")
        child_moves.append(move_text)

    _require(len(child_moves) == len(set(child_moves)),
             "duplicate child move", path + ".children")

    if side == attacker:
        _require(len(children) == 1, "attacker OR node must choose exactly one move", path)
        selected = child_moves[0]
        try:
            move = parse_move(selected)
        except ValueError as exc:
            raise CertificateVerificationError(f"{path}: invalid USI move {selected!r}: {exc}") from exc
        _require(is_legal_move(position, move), f"attacker move is illegal: {selected}", path)
        next_position = _apply_unchecked(position, move)
        next_state = canonical_state(next_position)
        _require(next_state not in ancestor_states,
                 "branch repeats a position; repetition rules are outside certificate v1", path)
        return 1 + _verify_node(
            children[0]["node"], next_position, attacker,
            path=path + ".children[0].node", depth=depth + 1,
            max_depth=max_depth, budget=budget, max_nodes=max_nodes,
            ancestor_states=ancestor_states | {next_state},
        )

    # Defender AND node: the certificate must cover every legal reply exactly.
    _require(child_moves == sorted(child_moves),
             "defender children must be sorted lexicographically by USI move", path)
    _require(
        set(child_moves) == set(moves),
        "defender children must cover the complete legal-move set; "
        f"missing={sorted(set(moves) - set(child_moves))}, "
        f"extra={sorted(set(child_moves) - set(moves))}",
        path + ".children",
    )
    branch_lengths: list[int] = []
    for index, child in enumerate(children):
        move_text = child["move"]
        move = parse_move(move_text)
        _require(is_legal_move(position, move), f"defender reply is illegal: {move_text}", path)
        next_position = _apply_unchecked(position, move)
        next_state = canonical_state(next_position)
        _require(next_state not in ancestor_states,
                 "branch repeats a position; repetition rules are outside certificate v1", path)
        branch_lengths.append(_verify_node(
            child["node"], next_position, attacker,
            path=f"{path}.children[{index}].node", depth=depth + 1,
            max_depth=max_depth, budget=budget, max_nodes=max_nodes,
            ancestor_states=ancestor_states | {next_state},
        ))
    return 1 + max(branch_lengths, default=0)


def verify_mate_certificate(
    certificate: Any,
    root_sfen: str,
    *,
    max_nodes: int = 100_000,
    max_depth: int = 512,
) -> dict[str, Any]:
    """Verify a forced-mate proof tree independently of the search engine.

    root_sfen is supplied by the verifier's caller, not trusted from the
    certificate. The returned max_mate_plies is the longest defender-resisting
    line in the certified AND/OR tree. This schema does not claim repetition,
    perpetual-check, entering-king, clock, or variant adjudication.
    """
    _require(isinstance(max_nodes, int) and not isinstance(max_nodes, bool) and max_nodes >= 1,
             "max_nodes must be a positive integer", "$limits")
    _require(isinstance(max_depth, int) and not isinstance(max_depth, bool) and max_depth >= 0,
             "max_depth must be a non-negative integer", "$limits")
    _require(isinstance(certificate, dict), "certificate must be an object", "$")
    _require(set(certificate) == {"schema", "attacker", "root"},
             "certificate must contain exactly schema, attacker, and root", "$")
    _require(certificate["schema"] == SCHEMA, f"schema must be {SCHEMA}", "$.schema")
    attacker = certificate["attacker"]
    _require(attacker in ("b", "w"), "attacker must be 'b' or 'w'", "$.attacker")

    position = parse_sfen(root_sfen)
    root = certificate["root"]
    root_state = canonical_state(position)
    budget = [0]
    max_plies = _verify_node(
        root, position, attacker,
        path="$.root", depth=0, max_depth=max_depth,
        budget=budget, max_nodes=max_nodes,
        ancestor_states=frozenset({root_state}),
    )
    identity = state_identity(position)
    return {
        "valid": True,
        "schema": SCHEMA,
        "attacker": attacker,
        "root_state_key": identity["state_key"],
        "verified_nodes": budget[0],
        "max_mate_plies": max_plies,
        "history_policy": "reject-repeated-position-per-branch",
    }


def canonical_certificate(certificate: dict[str, Any]) -> str:
    """Return deterministic JSON text for hashing or signing externally."""
    import json
    return json.dumps(certificate, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
