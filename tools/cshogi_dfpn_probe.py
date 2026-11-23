#!/usr/bin/env python3
"""GPL-3.0 cshogi DF-PN probe; emits a raw, engine-neutral AND/OR proof tree.

This file is intentionally an isolated child process. It imports cshogi but
never imports the CFE core. The parent process must independently extract and
verify the returned raw tree before treating it as a certificate.
"""
from __future__ import annotations

import argparse
import json
import sys
import time


class ExtractionStopped(Exception):
    pass


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sfen", required=True)
    ap.add_argument("--max-search-nodes", type=int, default=200_000)
    ap.add_argument("--max-tree-nodes", type=int, default=10_000)
    ap.add_argument("--max-depth", type=int, default=64)
    ap.add_argument("--draw-ply", type=int, default=2_147_483_646)
    ns = ap.parse_args()

    try:
        import cshogi
    except ImportError:
        print(json.dumps({"ok": False, "reason": "cshogi_not_installed"}))
        return 2

    if ns.max_search_nodes < 1 or ns.max_tree_nodes < 1 or ns.max_depth < 1:
        ap.error("node limits and max-depth must be positive")
    if ns.draw_ply < 1:
        ap.error("draw-ply must be positive")

    board = cshogi.Board(ns.sfen)
    attacker = "b" if board.turn == cshogi.BLACK else "w"
    original_sfen = board.sfen()
    totals = {
        "dfpn_search_calls": 0,
        "dfpn_searched_nodes": 0,
        "proof_tree_nodes": 0,
        "max_depth_reached": 0,
    }
    started = time.monotonic()

    def position_key() -> str:
        # Exclude SFEN move number: it is not part of position identity.
        return " ".join(board.sfen().split()[:3])

    def visit(depth: int, ancestors: frozenset[str]):
        if depth > ns.max_depth:
            raise ExtractionStopped("proof_depth_limit")
        totals["proof_tree_nodes"] += 1
        if totals["proof_tree_nodes"] > ns.max_tree_nodes:
            raise ExtractionStopped("proof_tree_node_limit")
        totals["max_depth_reached"] = max(totals["max_depth_reached"], depth)

        key = position_key()
        if key in ancestors:
            raise ExtractionStopped("repeated_position_on_branch")
        next_ancestors = ancestors | {key}

        side = "b" if board.turn == cshogi.BLACK else "w"
        if side != attacker:
            # Every defender node must be a check-evasion node.
            if not board.is_check():
                raise ExtractionStopped("defender_node_not_in_check")
            replies = list(board.legal_moves)
            if not replies:
                return {"terminal": "checkmate", "children": []}

            children = []
            ordered = sorted(
                ((cshogi.move_to_usi(move), move) for move in replies),
                key=lambda row: row[0],
            )
            for usi, move in ordered:
                board.push(move)
                try:
                    child = visit(depth + 1, next_ancestors)
                finally:
                    board.pop()
                children.append({"move": usi, "node": child})
            return {"children": children}

        remaining_nodes = ns.max_search_nodes - totals["dfpn_searched_nodes"]
        if remaining_nodes <= 0:
            raise ExtractionStopped("dfpn_node_budget_exhausted")

        searcher = cshogi.DfPn(
            depth=max(1, ns.max_depth - depth + 1),
            nodes=remaining_nodes,
            draw_ply=ns.draw_ply,
        )
        before = board.sfen()
        totals["dfpn_search_calls"] += 1
        found = bool(searcher.search(board))
        searched = int(searcher.searched_node)
        totals["dfpn_searched_nodes"] += max(0, searched)
        if board.sfen() != before:
            raise ExtractionStopped("cshogi_search_mutated_input_board")
        if not found:
            raise ExtractionStopped("dfpn_did_not_prove_mate_or_budget_exhausted")

        pv = list(searcher.get_pv(board))
        if not pv:
            raise ExtractionStopped("dfpn_returned_no_principal_variation")
        move = int(pv[0])
        legal = set(board.legal_moves)
        if move not in legal:
            raise ExtractionStopped("dfpn_principal_move_is_not_legal")
        usi = cshogi.move_to_usi(move)

        board.push(move)
        try:
            if not board.is_check():
                raise ExtractionStopped("dfpn_principal_move_does_not_give_check")
            child = visit(depth + 1, next_ancestors)
        finally:
            board.pop()
        return {"children": [{"move": usi, "node": child}]}

    try:
        raw_root = visit(0, frozenset())
        if board.sfen() != original_sfen:
            raise ExtractionStopped("board_not_restored_after_extraction")
        raw = {
            "schema": "cfe.shogi.raw-mate-proof.v1",
            "attacker": attacker,
            "root": raw_root,
        }
        result = {
            "ok": True,
            "proof_tree": raw,
            "stats": {
                **totals,
                "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
                "search_node_budget": ns.max_search_nodes,
                "tree_node_budget": ns.max_tree_nodes,
                "max_depth_budget": ns.max_depth,
            },
        }
        print(json.dumps(result, ensure_ascii=True, sort_keys=True))
        return 0
    except ExtractionStopped as exc:
        print(json.dumps({
            "ok": False,
            "reason": str(exc),
            "stats": {
                **totals,
                "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
                "search_node_budget": ns.max_search_nodes,
                "tree_node_budget": ns.max_tree_nodes,
                "max_depth_budget": ns.max_depth,
            },
        }, ensure_ascii=True, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
