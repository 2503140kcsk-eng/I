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
RAW_PROOF_SCHEMA = "cfe.shogi.raw-mate-proof.v1"


class CertificateVerificationError(ValueError):
    """The supplied certificate does not prove the declared forced mate."""


def _require(condition: bool, message: str, path: str) -> None:
    if not condition:
        raise CertificateVerificationError(f"{path}: {message}")


def _identity_for_position(position) -> dict[str, str]:
    return state_identity(position)


def _validate_identity_record(record: Any, path: str) -> dict[str, str]:
    _require(isinstance(record, dict), "identity must be an object", path)
    _require(set(record) == {"key_version", "canonical_state", "state_key"},
             "identity must contain exactly key_version, canonical_state, and state_key", path)
    _require(record.get("key_version") == "CFE-SHOGI-STATE-V1",
             "unsupported state-key version", path)
    canonical = record.get("canonical_state")
    _require(isinstance(canonical, str), "canonical_state must be a string", path)
    try:
        position = parse_sfen(canonical + " 1")
    except ValueError as exc:
        raise CertificateVerificationError(f"{path}: invalid canonical state: {exc}") from exc
    _require(canonical_state(position) == canonical,
             "identity canonical_state is not canonical", path)
    expected = state_identity(position)
    _require(record == expected, "identity digest is not the digest of its canonical_state", path)
    return expected


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
    identity_policy: str,
    identity_mismatches: list[int],
) -> int:
    _require(isinstance(node, dict), "node must be an object", path)
    _require(set(node).issubset({"identity", "children", "terminal"}),
             "node contains unknown fields", path)
    _require("identity" in node, "identity is required", path)
    _require("children" in node, "children is required", path)
    _require(depth <= max_depth, f"proof depth exceeds limit {max_depth}", path)

    budget[0] += 1
    _require(budget[0] <= max_nodes, f"proof node count exceeds limit {max_nodes}", path)

    recorded_identity = _validate_identity_record(node["identity"], path + ".identity")
    expected_identity = _identity_for_position(position)
    if recorded_identity != expected_identity:
        if identity_policy == "strict":
            raise CertificateVerificationError(
                f"{path}.identity: node identity does not match the position reached by replay"
            )
        identity_mismatches[0] += 1

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
            identity_policy=identity_policy, identity_mismatches=identity_mismatches,
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
            identity_policy=identity_policy, identity_mismatches=identity_mismatches,
        ))
    return 1 + max(branch_lengths, default=0)


def verify_mate_certificate(
    certificate: Any,
    root_sfen: str,
    *,
    max_nodes: int = 100_000,
    max_depth: int = 512,
    identity_policy: str = "strict",
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
    _require(identity_policy in ("strict", "replay"),
             "identity_policy must be 'strict' or 'replay'", "$limits")
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
    identity_mismatches = [0]
    max_plies = _verify_node(
        root, position, attacker,
        path="$.root", depth=0, max_depth=max_depth,
        budget=budget, max_nodes=max_nodes,
        ancestor_states=frozenset({root_state}),
        identity_policy=identity_policy,
        identity_mismatches=identity_mismatches,
    )
    identity = state_identity(position)
    return {
        "valid": True,
        "schema": SCHEMA,
        "attacker": attacker,
        "root_state_key": identity["state_key"],
        "verified_nodes": budget[0],
        "identity_policy": identity_policy,
        "identity_mismatches": identity_mismatches[0],
        "max_mate_plies": max_plies,
        "history_policy": "reject-repeated-position-per-branch",
    }


def extract_mate_certificate(
    proof_tree: Any,
    root_sfen: str,
    *,
    max_nodes: int = 100_000,
    max_depth: int = 512,
) -> dict[str, Any]:
    """Attach replay-derived identities to a raw AND/OR proof tree.

    The input tree contains only attacker/defender moves and terminal labels.
    Identities are never accepted from the search process: every node position
    is reconstructed from the trusted root and its legal-move path. The
    resulting certificate is then passed through the independent verifier
    before being returned.
    """
    _require(isinstance(proof_tree, dict), "proof tree must be an object", "$")
    _require(set(proof_tree) == {"schema", "attacker", "root"},
             "proof tree must contain exactly schema, attacker, and root", "$")
    _require(proof_tree["schema"] == RAW_PROOF_SCHEMA,
             f"schema must be {RAW_PROOF_SCHEMA}", "$.schema")
    attacker = proof_tree["attacker"]
    _require(attacker in ("b", "w"), "attacker must be 'b' or 'w'", "$.attacker")
    _require(isinstance(max_nodes, int) and not isinstance(max_nodes, bool) and max_nodes >= 1,
             "max_nodes must be a positive integer", "$limits")
    _require(isinstance(max_depth, int) and not isinstance(max_depth, bool) and max_depth >= 0,
             "max_depth must be a non-negative integer", "$limits")

    root_position = parse_sfen(root_sfen)
    budget = [0]

    def decorate(raw_node: Any, position, path: str, depth: int) -> dict[str, Any]:
        _require(isinstance(raw_node, dict), "proof node must be an object", path)
        _require(set(raw_node).issubset({"children", "terminal"}),
                 "proof node contains unknown fields", path)
        _require("children" in raw_node, "children is required", path)
        _require(depth <= max_depth, f"proof depth exceeds limit {max_depth}", path)
        budget[0] += 1
        _require(budget[0] <= max_nodes, f"proof node count exceeds limit {max_nodes}", path)

        raw_children = raw_node["children"]
        _require(isinstance(raw_children, list), "children must be an array", path + ".children")
        result: dict[str, Any] = {
            "identity": state_identity(position),
            "children": [],
        }
        if "terminal" in raw_node:
            result["terminal"] = raw_node["terminal"]

        for index, child in enumerate(raw_children):
            child_path = f"{path}.children[{index}]"
            _require(isinstance(child, dict), "child must be an object", child_path)
            _require(set(child) == {"move", "node"},
                     "child must contain exactly move and node", child_path)
            move_text = child["move"]
            _require(isinstance(move_text, str), "move must be a string", child_path + ".move")
            try:
                move = parse_move(move_text)
            except ValueError as exc:
                raise CertificateVerificationError(
                    f"{child_path}: invalid USI move {move_text!r}: {exc}"
                ) from exc
            _require(is_legal_move(position, move), f"illegal proof edge: {move_text}", child_path)
            next_position = _apply_unchecked(position, move)
            result["children"].append({
                "move": move_text,
                "node": decorate(child["node"], next_position, child_path + ".node", depth + 1),
            })
        return result

    certificate = {
        "schema": SCHEMA,
        "attacker": attacker,
        "root": decorate(proof_tree["root"], root_position, "$.root", 0),
    }
    verify_mate_certificate(
        certificate, root_sfen, max_nodes=max_nodes, max_depth=max_depth
    )
    return certificate


def canonical_certificate(certificate: dict[str, Any]) -> str:
    """Return deterministic JSON text for hashing or signing externally."""
    import json
    return json.dumps(certificate, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
