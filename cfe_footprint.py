"""Condition-cube footprints and sound certificate-candidate reuse.

Footprints are filters, not proofs. A matching footprint only nominates a
certificate; try_reuse_certificate must replay the AND/OR tree against the
query position with identity_policy="replay". Replay recomputes every legal
move set and checkmate leaf, so a broader cube cannot by itself authorize a
false reuse.
"""
from __future__ import annotations

import re
from typing import Iterable, Any

from cfe_shogi import (
    HAND_KINDS,
    canonical_state,
    parse_square,
    parse_sfen,
    square_name,
    state_identity,
)
from cfe_certificate import (
    CertificateVerificationError,
    verify_mate_certificate,
)

SCHEMA = "cfe.shogi.footprint.v1"
PIECE_TOKEN_RE = re.compile(r"^(?:\+[PLNSBRplnsbr]|[PLNSGBRKplnsgbrk])$")
HAND_TOKEN_RE = re.compile(r"^([bw])([RBGSNLP])$")


class FootprintError(ValueError):
    """Malformed condition cube or incompatible footprint operation."""


def _validate_footprint(footprint: Any) -> dict[str, Any]:
    if not isinstance(footprint, dict):
        raise FootprintError("footprint must be an object")
    if set(footprint) - {"schema", "key_version", "source_state_key", "conditions"}:
        raise FootprintError("footprint contains unknown top-level fields")
    if footprint.get("schema") != SCHEMA:
        raise FootprintError(f"schema must be {SCHEMA}")
    if footprint.get("key_version") != "CFE-SHOGI-STATE-V1":
        raise FootprintError("unsupported state-key version")
    source_key = footprint.get("source_state_key")
    if source_key is not None and (
        not isinstance(source_key, str) or not re.fullmatch(r"[0-9a-f]{64}", source_key)
    ):
        raise FootprintError("source_state_key must be a 64-character lowercase SHA-256 digest")

    conditions = footprint.get("conditions")
    if not isinstance(conditions, dict) or set(conditions) - {"side", "board", "hands"}:
        raise FootprintError("conditions must contain only side, board, and hands")
    if "side" in conditions and conditions["side"] not in ("b", "w"):
        raise FootprintError("side condition must be 'b' or 'w'")

    board = conditions.get("board", {})
    if not isinstance(board, dict):
        raise FootprintError("board condition must be an object")
    for square, token in board.items():
        try:
            parse_square(square)
        except ValueError as exc:
            raise FootprintError(f"invalid board square: {square!r}") from exc
        if token is not None and (not isinstance(token, str) or not PIECE_TOKEN_RE.fullmatch(token)):
            raise FootprintError(f"invalid piece token for {square}: {token!r}")

    hands = conditions.get("hands", {})
    if not isinstance(hands, dict) or set(hands) - {"b", "w"}:
        raise FootprintError("hands must be an object keyed by b and/or w")
    for owner, counts in hands.items():
        if not isinstance(counts, dict) or set(counts) - set(HAND_KINDS):
            raise FootprintError(f"invalid hand-count map for {owner}")
        for kind, count in counts.items():
            if isinstance(count, bool) or not isinstance(count, int) or count < 0:
                raise FootprintError(f"hand count {owner}{kind} must be a non-negative integer")
    return footprint


def extract_footprint(
    certificate: dict[str, Any],
    root_sfen: str,
    *,
    board_squares: Iterable[str] | None = None,
    hand_counts: Iterable[str] | None = None,
    include_side: bool = True,
) -> dict[str, Any]:
    """Extract a verified condition cube from a mate certificate.

    Omitting board squares or hand counters makes a broader candidate filter.
    Such a filter is never itself considered proof reuse; replay verification
    remains mandatory in try_reuse_certificate.
    """
    verification = verify_mate_certificate(certificate, root_sfen, identity_policy="strict")
    position = parse_sfen(root_sfen)

    if board_squares is None:
        selected_squares = [square_name(i) for i in range(81)]
    else:
        selected_squares = list(board_squares)
    if len(selected_squares) != len(set(selected_squares)):
        raise FootprintError("board_squares contains duplicates")
    for square in selected_squares:
        try:
            parse_square(square)
        except ValueError as exc:
            raise FootprintError(f"invalid board square: {square!r}") from exc

    if hand_counts is None:
        selected_hands = [owner + kind for owner in ("b", "w") for kind in HAND_KINDS]
    else:
        selected_hands = list(hand_counts)
    if len(selected_hands) != len(set(selected_hands)):
        raise FootprintError("hand_counts contains duplicates")
    for token in selected_hands:
        if not isinstance(token, str) or not HAND_TOKEN_RE.fullmatch(token):
            raise FootprintError(f"invalid hand counter selector: {token!r}")

    board_conditions: dict[str, str | None] = {}
    for square in sorted(selected_squares):
        piece = position.board[parse_square(square)]
        board_conditions[square] = None if piece is None else piece.sfen()

    hands: dict[str, dict[str, int]] = {"b": {}, "w": {}}
    for token in sorted(selected_hands):
        owner, kind = token[0], token[1]
        hands[owner][kind] = position.hand_count(owner, kind)
    hands = {owner: values for owner, values in hands.items() if values}

    conditions: dict[str, Any] = {
        "board": board_conditions,
        "hands": hands,
    }
    if include_side:
        conditions["side"] = position.side

    footprint = {
        "schema": SCHEMA,
        "key_version": "CFE-SHOGI-STATE-V1",
        "source_state_key": verification["root_state_key"],
        "conditions": conditions,
    }
    return _validate_footprint(footprint)


def matches_footprint(footprint: Any, sfen: str) -> bool:
    """Check whether a position satisfies all predicates in a condition cube."""
    cube = _validate_footprint(footprint)
    position = parse_sfen(sfen)
    conditions = cube["conditions"]

    if "side" in conditions and position.side != conditions["side"]:
        return False
    for square, expected in conditions.get("board", {}).items():
        piece = position.board[parse_square(square)]
        actual = None if piece is None else piece.sfen()
        if actual != expected:
            return False
    for owner, counts in conditions.get("hands", {}).items():
        for kind, expected in counts.items():
            if position.hand_count(owner, kind) != expected:
                return False
    return True


def cube_implies(stronger: Any, weaker: Any) -> bool:
    """Return whether every state matching stronger also matches weaker.

    The order is explicit: stronger is the narrower cube (more equalities);
    weaker is the broader cube (fewer equalities).
    """
    a = _validate_footprint(stronger)["conditions"]
    b = _validate_footprint(weaker)["conditions"]

    if "side" in b and a.get("side") != b["side"]:
        return False
    a_board = a.get("board", {})
    for square, expected in b.get("board", {}).items():
        if square not in a_board or a_board[square] != expected:
            return False

    a_hands = a.get("hands", {})
    for owner, counts in b.get("hands", {}).items():
        if owner not in a_hands:
            return False
        for kind, expected in counts.items():
            if kind not in a_hands[owner] or a_hands[owner][kind] != expected:
                return False
    return True


def try_reuse_certificate(
    certificate: dict[str, Any],
    footprint: Any,
    target_sfen: str,
    *,
    max_nodes: int = 100_000,
    max_depth: int = 512,
) -> dict[str, Any]:
    """Use a footprint as a candidate filter, then replay the full proof.

    A cube hit never returns reusable=True by itself. The tree must verify
    against the target position with every legal defender reply and checkmate
    leaf recomputed from scratch.
    """
    if not matches_footprint(footprint, target_sfen):
        return {"candidate_match": False, "reusable": False, "reason": "footprint_miss"}
    try:
        verification = verify_mate_certificate(
            certificate, target_sfen, max_nodes=max_nodes, max_depth=max_depth,
            identity_policy="replay",
        )
    except (CertificateVerificationError, ValueError) as exc:
        return {
            "candidate_match": True,
            "reusable": False,
            "reason": "proof_replay_failed",
            "error": str(exc),
        }
    return {
        "candidate_match": True,
        "reusable": True,
        "reason": "proof_replay_verified",
        "verification": verification,
    }
