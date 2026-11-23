"""Independent, dependency-free standard-shogi SFEN and legal-move core.

This module intentionally contains no code copied from third-party engines.
Coordinates follow USI: files 9..1, ranks a..i. Board storage is rank-major,
with file 9 at column 0. Only standard 9x9 shogi is supported.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import re
from typing import Iterable, Optional

BASE_KINDS = "PLNSGBRK"
HAND_KINDS = "RBGSNLP"  # canonical SFEN order: R B G S N L P
MAX_PLY = 65_535  # interoperable with the u16 ply field in shogi-rs
MAX_INVENTORY = {"K": 2, "R": 2, "B": 2, "G": 4, "S": 4, "N": 4, "L": 4, "P": 18}
PROMOTABLE = frozenset("PLNSBR")


class ShogiError(ValueError):
    """Invalid SFEN, move notation, or shogi position."""


@dataclass(frozen=True, slots=True)
class Piece:
    owner: str  # "b" or "w"
    kind: str   # unpromoted base kind: P L N S G B R K
    promoted: bool = False

    def __post_init__(self) -> None:
        if self.owner not in ("b", "w") or self.kind not in BASE_KINDS:
            raise ShogiError(f"invalid piece: {self!r}")
        if self.promoted and self.kind not in PROMOTABLE:
            raise ShogiError(f"piece cannot be promoted: {self.kind}")

    def sfen(self) -> str:
        letter = self.kind if self.owner == "b" else self.kind.lower()
        return ("+" if self.promoted else "") + letter


@dataclass(frozen=True, slots=True)
class Move:
    from_sq: Optional[int]
    to_sq: int
    promote: bool = False
    drop_kind: Optional[str] = None

    def to_usi(self) -> str:
        dst = square_name(self.to_sq)
        if self.drop_kind is not None:
            return f"{self.drop_kind}*{dst}"
        assert self.from_sq is not None
        return square_name(self.from_sq) + dst + ("+" if self.promote else "")


@dataclass(frozen=True, slots=True)
class Position:
    board: tuple[Optional[Piece], ...]  # 81 entries
    side: str
    # hands[0] black, hands[1] white; each tuple follows HAND_KINDS
    hands: tuple[tuple[int, ...], tuple[int, ...]]
    ply: int

    def piece_at(self, sq: int) -> Optional[Piece]:
        return self.board[sq]

    def hand_count(self, owner: str, kind: str) -> int:
        return self.hands[0 if owner == "b" else 1][HAND_KINDS.index(kind)]


def square_index(file_no: int, rank_no: int) -> int:
    """Map USI file 1..9 and rank 1..9 to the internal 0..80 index."""
    if not (1 <= file_no <= 9 and 1 <= rank_no <= 9):
        raise ShogiError(f"square out of range: {file_no}{rank_no}")
    return (rank_no - 1) * 9 + (9 - file_no)


def square_name(sq: int) -> str:
    if not 0 <= sq < 81:
        raise ShogiError(f"square index out of range: {sq}")
    return f"{9 - (sq % 9)}{chr(ord('a') + sq // 9)}"


def parse_square(s: str) -> int:
    if not re.fullmatch(r"[1-9][a-i]", s):
        raise ShogiError(f"invalid square: {s!r}")
    return square_index(int(s[0]), ord(s[1]) - ord("a") + 1)


def parse_move(text: str) -> Move:
    if re.fullmatch(r"[1-9][a-i][1-9][a-i]\+?", text):
        return Move(parse_square(text[:2]), parse_square(text[2:4]), text.endswith("+"))
    if re.fullmatch(r"[PLNSGBR]\*[1-9][a-i]", text):
        return Move(None, parse_square(text[2:4]), False, text[0])
    raise ShogiError(f"invalid USI move: {text!r}")


def parse_sfen(sfen: str, *, require_two_kings: bool = True) -> Position:
    """Parse exactly four SFEN fields and enforce structural/material invariants.

    This is deliberately a *position validity* check, not a reachability proof:
    it checks board syntax, kings, promotion, hand syntax and physical material
    upper bounds, but does not prove that a legal game history reaches the state.
    """
    try:
        sfen.encode("ascii")
    except UnicodeEncodeError as exc:
        raise ShogiError("SFEN must use ASCII characters only") from exc
    fields = sfen.strip().split()
    if len(fields) != 4:
        raise ShogiError("SFEN must contain exactly four fields: board side hands ply")
    board_text, side, hand_text, ply_text = fields
    if side not in ("b", "w"):
        raise ShogiError("side-to-move must be 'b' or 'w'")
    if not re.fullmatch(r"[1-9][0-9]*", ply_text):
        raise ShogiError("move number must be a positive decimal integer without leading zero")
    # Bound the counter before int() to avoid pathological decimal input and
    # keep SFEN interoperability with engines storing the move number as u16.
    if len(ply_text) > 5 or int(ply_text) > MAX_PLY:
        raise ShogiError(f"move number exceeds the interoperable limit {MAX_PLY}")
    ply = int(ply_text)

    ranks = board_text.split("/")
    if len(ranks) != 9:
        raise ShogiError("board must contain exactly nine ranks")
    board: list[Optional[Piece]] = [None] * 81
    for rank_i, row in enumerate(ranks):
        col = 0
        i = 0
        previous_was_digit = False
        while i < len(row):
            ch = row[i]
            if "0" <= ch <= "9":
                if ch not in "123456789" or previous_was_digit:
                    raise ShogiError(f"invalid or non-canonical empty-run in rank {rank_i + 1}")
                col += int(ch)
                previous_was_digit = True
                i += 1
                continue
            previous_was_digit = False
            promoted = ch == "+"
            if promoted:
                i += 1
                if i >= len(row):
                    raise ShogiError("promotion marker must precede a piece")
                ch = row[i]
            if ch not in "PLNSGBRKplnsgbrk":
                raise ShogiError(f"unknown piece symbol: {ch!r}")
            kind = ch.upper()
            owner = "b" if ch.isupper() else "w"
            piece = Piece(owner, kind, promoted)
            if col >= 9:
                raise ShogiError(f"rank {rank_i + 1} is wider than nine squares")
            board[rank_i * 9 + col] = piece
            col += 1
            i += 1
        if col != 9:
            raise ShogiError(f"rank {rank_i + 1} has width {col}, not nine")

    hands = [[0] * len(HAND_KINDS), [0] * len(HAND_KINDS)]
    if hand_text != "-":
        if not hand_text:
            raise ShogiError("empty hand field must be '-' ")
        i = 0
        seen: set[tuple[str, str]] = set()
        while i < len(hand_text):
            start = i
            while i < len(hand_text) and "0" <= hand_text[i] <= "9":
                i += 1
            if i - start > 2:
                raise ShogiError("hand count is too large")
            number = int(hand_text[start:i]) if i > start else 1
            if number <= 0 or (i - start > 1 and hand_text[start] == "0"):
                raise ShogiError("hand counts must be positive with no leading zero")
            if i >= len(hand_text) or hand_text[i] not in "RBGSNLPrbgsnlp":
                raise ShogiError("invalid piece in hand field")
            letter = hand_text[i]
            kind = letter.upper()
            owner = "b" if letter.isupper() else "w"
            key = (owner, kind)
            if key in seen:
                raise ShogiError("duplicate piece kind in hand field")
            seen.add(key)
            hands[0 if owner == "b" else 1][HAND_KINDS.index(kind)] = number
            i += 1

    counts = {k: 0 for k in BASE_KINDS}
    kings = {"b": 0, "w": 0}
    for p in board:
        if p is not None:
            counts[p.kind] += 1
            if p.kind == "K":
                kings[p.owner] += 1
    for owner_i in range(2):
        for idx, number in enumerate(hands[owner_i]):
            counts[HAND_KINDS[idx]] += number
    for kind, count in counts.items():
        if count > MAX_INVENTORY[kind]:
            raise ShogiError(f"physical inventory exceeded for {kind}: {count}>{MAX_INVENTORY[kind]}")
    if require_two_kings and kings != {"b": 1, "w": 1}:
        raise ShogiError(f"exactly one king per side is required; found {kings}")
    if not require_two_kings and (kings["b"] > 1 or kings["w"] > 1):
        raise ShogiError("a side cannot have more than one king")
    return Position(tuple(board), side, (tuple(hands[0]), tuple(hands[1])), ply)


def to_sfen(position: Position, *, include_ply: bool = True) -> str:
    rows: list[str] = []
    for rank in range(9):
        out = ""
        empty = 0
        for col in range(9):
            piece = position.board[rank * 9 + col]
            if piece is None:
                empty += 1
            else:
                if empty:
                    out += str(empty)
                    empty = 0
                out += piece.sfen()
        if empty:
            out += str(empty)
        rows.append(out)
    hand_parts: list[str] = []
    for owner_i, owner in ((0, "b"), (1, "w")):
        for kind in HAND_KINDS:
            count = position.hands[owner_i][HAND_KINDS.index(kind)]
            if count:
                letter = kind if owner == "b" else kind.lower()
                hand_parts.append((str(count) if count > 1 else "") + letter)
    hand = "".join(hand_parts) or "-"
    fields = ["/".join(rows), position.side, hand]
    if include_ply:
        fields.append(str(position.ply))
    return " ".join(fields)


def canonical_sfen(sfen: str) -> str:
    """Canonical four-field SFEN; retains the move number for round trips."""
    return to_sfen(parse_sfen(sfen))


def canonical_state(sfen_or_position: str | Position) -> str:
    """Canonical state identity input: board + side + hands (no move counter)."""
    pos = parse_sfen(sfen_or_position) if isinstance(sfen_or_position, str) else sfen_or_position
    return to_sfen(pos, include_ply=False)


STATE_KEY_VERSION = "CFE-SHOGI-STATE-V1"


def state_identity(sfen_or_position: str | Position) -> dict[str, str]:
    """Return both the exact canonical state and its versioned digest.

    Keeping the canonical bytes beside the digest gives verifiers an exact
    collision check rather than treating a cryptographic hash as a proof of
    injectivity.
    """
    canonical = canonical_state(sfen_or_position)
    payload = STATE_KEY_VERSION.encode("ascii") + b"\0" + canonical.encode("ascii")
    return {
        "key_version": STATE_KEY_VERSION,
        "canonical_state": canonical,
        "state_key": hashlib.sha256(payload).hexdigest(),
    }


def state_key(sfen_or_position: str | Position) -> str:
    """Versioned, engine-independent SHA-256 key for the current shogi state."""
    return state_identity(sfen_or_position)["state_key"]


def position_envelope(pos: Position) -> dict[str, object]:
    """Portable, engine-neutral snapshot consumed by CFE adapters.

    This is a normalized position snapshot, not a proof of game-history
    reachability and not a proof certificate for a search result.
    """
    identity = state_identity(pos)
    return {
        "schema": "cfe.shogi.position.v1",
        "canonical_sfen": to_sfen(pos),
        "identity": {
            "algorithm": "sha-256",
            "key_version": identity["key_version"],
            "canonical_state": identity["canonical_state"],
            "digest": identity["state_key"],
        },
        "legal_moves": list(legal_moves(pos)),
    }


def _coords(sq: int) -> tuple[int, int]:
    return (9 - sq % 9, sq // 9 + 1)  # file number, rank number


def _path_clear(pos: Position, src: int, dst: int, dx: int, dy: int) -> bool:
    f, r = _coords(src)
    tf, tr = _coords(dst)
    sf = 0 if dx == 0 else (1 if dx > 0 else -1)
    sr = 0 if dy == 0 else (1 if dy > 0 else -1)
    f += sf
    r += sr
    while (f, r) != (tf, tr):
        if pos.board[square_index(f, r)] is not None:
            return False
        f += sf
        r += sr
    return True


def _reaches(pos: Position, src: int, dst: int, piece: Piece) -> bool:
    sf, sr = _coords(src)
    tf, tr = _coords(dst)
    dx, dy = tf - sf, tr - sr
    if dx == 0 and dy == 0:
        return False
    forward = -1 if piece.owner == "b" else 1
    adx, ady = abs(dx), abs(dy)
    k = piece.kind
    promoted = piece.promoted

    # Gold movement is shared by promoted P/L/N/S.
    gold_like = k == "G" or (promoted and k in "PLNS")
    if gold_like:
        return ((dy == forward and adx <= 1) or
                (dy == 0 and adx == 1) or
                (dy == -forward and dx == 0))
    if k == "K":
        return max(adx, ady) == 1
    if k == "P":
        return dx == 0 and dy == forward
    if k == "N":
        return adx == 1 and dy == 2 * forward
    if k == "S":
        return ((dy == forward and adx <= 1) or (dy == -forward and adx == 1))
    if k == "L":
        return dx == 0 and dy * forward > 0 and _path_clear(pos, src, dst, dx, dy)
    if k == "B":
        if adx == ady:
            return _path_clear(pos, src, dst, dx, dy)
        return promoted and adx + ady == 1
    if k == "R":
        if dx == 0 or dy == 0:
            return _path_clear(pos, src, dst, dx, dy)
        return promoted and adx == 1 and ady == 1
    return False


def is_square_attacked(pos: Position, target: int, by: str) -> bool:
    """Geometric attacks; pinned pieces count as attackers for king safety."""
    for src, piece in enumerate(pos.board):
        if piece is not None and piece.owner == by and _reaches(pos, src, target, piece):
            return True
    return False


def in_check(pos: Position, owner: str) -> bool:
    kings = [i for i, p in enumerate(pos.board) if p == Piece(owner, "K")]
    if len(kings) != 1:
        raise ShogiError(f"cannot test check: expected one {owner} king, found {len(kings)}\")
    return is_square_attacked(pos, kings[0], "w" if owner == "b" else "b")


def _replace_hand(hands: tuple[tuple[int, ...], tuple[int, ...]], owner: str,
                  kind: str, delta: int) -> tuple[tuple[int, ...], tuple[int, ...]]:
    rows = [list(hands[0]), list(hands[1])]
    row = rows[0 if owner == "b" else 1]
    i = HAND_KINDS.index(kind)
    if row[i] + delta < 0 or row[i] + delta > MAX_INVENTORY[kind]:
        raise ShogiError("invalid hand count after move")
    row[i] += delta
    return (tuple(rows[0]), tuple(rows[1]))


def _apply_unchecked(pos: Position, move: Move) -> Position:
    board = list(pos.board)
    hands = pos.hands
    owner = pos.side
    if move.drop_kind is not None:
        kind = move.drop_kind
        if hands[0 if owner == "b" else 1][HAND_KINDS.index(kind)] <= 0:
            raise ShogiError("piece is not in hand")
        if board[move.to_sq] is not None:
            raise ShogiError("drop destination is occupied")
        board[move.to_sq] = Piece(owner, kind)
        hands = _replace_hand(hands, owner, kind, -1)
    else:
        assert move.from_sq is not None
        piece = board[move.from_sq]
        if piece is None or piece.owner != owner:
            raise ShogiError("source square does not contain a friendly piece")
        captured = board[move.to_sq]
        if captured is not None:
            if captured.owner == owner:
                raise ShogiError("cannot capture a friendly piece")
            if captured.kind == "K":
                raise ShogiError("kings are not captured as moves; checkmate ends the game")
            hands = _replace_hand(hands, owner, captured.kind, 1)
        board[move.from_sq] = None
        board[move.to_sq] = Piece(owner, piece.kind, piece.promoted or move.promote)
    return Position(tuple(board), "w" if owner == "b" else "b", hands, pos.ply + 1)


def _in_promotion_zone(owner: str, sq: int) -> bool:
    rank = sq // 9 + 1
    return rank <= 3 if owner == "b" else rank >= 7


def _dead_rank(owner: str, kind: str, sq: int) -> bool:
    rank = sq // 9 + 1
    relative = rank if owner == "b" else 10 - rank
    return (kind in "PL" and relative == 1) or (kind == "N" and relative <= 2)


def _has_unpromoted_pawn_on_file(pos: Position, owner: str, file_no: int) -> bool:
    return any(p == Piece(owner, "P") and _coords(i)[0] == file_no
               for i, p in enumerate(pos.board))


def _king_safe_after(pos: Position, move: Move) -> Position:
    after = _apply_unchecked(pos, move)
    if in_check(after, pos.side):
        raise ShogiError("move leaves own king in check")
    return after


def is_legal_move(pos: Position, move: Move, *, _enforce_uchifuzume: bool = True,
                  _uchi_depth: int = 0) -> bool:
    """Return whether a USI move is fully legal in the given position.

    Includes movement/path, captures, promotion, mandatory promotion, drops,
    nifu, dead-rank drops, own-king safety, and recursive uchifuzume handling.
    """
    try:
        if not 0 <= move.to_sq < 81:
            return False
        if move.drop_kind is not None:
            kind = move.drop_kind
            if kind not in HAND_KINDS or move.promote or move.from_sq is not None:
                return False
            if pos.board[move.to_sq] is not None:
                return False
            if pos.hand_count(pos.side, kind) <= 0:
                return False
            if _dead_rank(pos.side, kind, move.to_sq):
                return False
            if kind == "P" and _has_unpromoted_pawn_on_file(pos, pos.side, _coords(move.to_sq)[0]):
                return False
            after = _king_safe_after(pos, move)
            if kind == "P" and _enforce_uchifuzume and in_check(after, after.side):
                # Every recursive edge is a checking pawn drop, consuming one
                # pawn from hand; total hand pawns are bounded by 18.
                if _uchi_depth > 18:
                    raise ShogiError("uchifuzume recursion invariant violated")
                if not has_legal_move(after, _enforce_uchifuzume=True,
                                      _uchi_depth=_uchi_depth + 1):
                    return False
            return True

        if move.from_sq is None or not 0 <= move.from_sq < 81 or move.from_sq == move.to_sq:
            return False
        piece = pos.board[move.from_sq]
        if piece is None or piece.owner != pos.side:
            return False
        target = pos.board[move.to_sq]
        if target is not None and target.owner == pos.side:
            return False
        if target is not None and target.kind == "K":
            return False
        if not _reaches(pos, move.from_sq, move.to_sq, piece):
            return False
        can_promote = (piece.kind in PROMOTABLE and
                       (_in_promotion_zone(pos.side, move.from_sq) or
                        _in_promotion_zone(pos.side, move.to_sq)))
        if move.promote and (piece.promoted or not can_promote):
            return False
        if not move.promote and not piece.promoted:
            if piece.kind in "PL" and _dead_rank(pos.side, piece.kind, move.to_sq):
                return False
            if piece.kind == "N":
                rank = move.to_sq // 9 + 1
                relative = rank if pos.side == "b" else 10 - rank
                if relative <= 2:
                    return False
        _king_safe_after(pos, move)
        return True
    except (ShogiError, IndexError, ValueError):
        return False


def _candidate_moves(pos: Position) -> Iterable[Move]:
    owner = pos.side
    for src, piece in enumerate(pos.board):
        if piece is None or piece.owner != owner:
            continue
        for dst in range(81):
            if dst == src:
                continue
            yield Move(src, dst, False)
            if piece.kind in PROMOTABLE and not piece.promoted:
                yield Move(src, dst, True)
    for kind in HAND_KINDS:
        if pos.hand_count(owner, kind) > 0:
            for dst, piece in enumerate(pos.board):
                if piece is None:
                    yield Move(None, dst, False, kind)


def has_legal_move(pos: Position, *, _enforce_uchifuzume: bool = True,
                   _uchi_depth: int = 0) -> bool:
    return any(is_legal_move(pos, m, _enforce_uchifuzume=_enforce_uchifuzume,
                             _uchi_depth=_uchi_depth) for m in _candidate_moves(pos))


def legal_moves(pos: Position) -> tuple[str, ...]:
    """Return all legal moves as lexicographically sorted USI strings."""
    return tuple(sorted(m.to_usi() for m in _candidate_moves(pos) if is_legal_move(pos, m)))


def validate_move(sfen: str, usi_move: str) -> bool:
    return is_legal_move(parse_sfen(sfen), parse_move(usi_move))


def perft(pos: Position, depth: int) -> int:
    """Legal move tree node count; useful for cross-engine rule conformance."""
    if depth < 0:
        raise ShogiError("perft depth cannot be negative")
    if depth == 0:
        return 1
    total = 0
    for m in _candidate_moves(pos):
        if is_legal_move(pos, m):
            total += perft(_apply_unchecked(pos, m), depth - 1)
    return total


def main(argv: Optional[list[str]] = None) -> int:
    import argparse, json, sys
    parser = argparse.ArgumentParser(description="CFE standard-shogi legality/SFEN oracle")
    parser.add_argument("--sfen", help="four-field SFEN")
    parser.add_argument("--move", help="USI move to validate")
    parser.add_argument("--moves", action="store_true", help="enumerate all legal USI moves")
    parser.add_argument("--key", action="store_true", help="print canonical state key")
    parser.add_argument("--canonical", action="store_true", help="print canonical SFEN")
    parser.add_argument("--perft", type=int, help="count legal tree nodes at depth")
    parser.add_argument("--envelope", action="store_true", help="emit the portable CFE position envelope")
    ns = parser.parse_args(argv)
    sfen = ns.sfen or sys.stdin.read().strip()
    try:
        pos = parse_sfen(sfen)
        result: dict[str, object] = {"ok": True}
        if ns.canonical: result["canonical_sfen"] = to_sfen(pos)
        if ns.key:
            result["state_key"] = state_key(pos)
            result["state_identity"] = state_identity(pos)
        if ns.envelope: result["position_envelope"] = position_envelope(pos)
        if ns.move is not None: result["legal"] = is_legal_move(pos, parse_move(ns.move))
        if ns.moves: result["legal_moves"] = legal_moves(pos)
        if ns.perft is not None: result["perft"] = perft(pos, ns.perft)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except ShogiError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
