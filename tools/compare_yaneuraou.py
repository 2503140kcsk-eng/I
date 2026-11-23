#!/usr/bin/env python3
"""Cross-check exact legal moves and engine-independent state identity with YaneuraOu.

YaneuraOu is launched as a separate USI process. No YaneuraOu source, objects,
or private hash implementation are imported into CFE. Its pinned perft
implementation prints every root move as "USI: 1" at depth one; this adapter
parses those lines and compares the complete move set, not only the node count.
"""
from __future__ import annotations

import argparse
import json
import queue
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from cfe_shogi import canonical_state, legal_moves, parse_sfen, state_key, to_sfen

USI_MOVE_RE = re.compile(r"^(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])$")
PERFT_MOVE_LINE_RE = re.compile(
    r"^\s*((?:[1-9][a-i][1-9][a-i]\+?)|(?:[PLNSGBR]\*[1-9][a-i])):\s*(\d+)\s*$"
)
PERFT_NODES_RE = re.compile(r"Nodes searched:\s*(\d+)")


def parse_perft_output(lines: list[str], summary_line: str) -> tuple[tuple[str, ...], int]:
    """Parse depth-1 perft divide output into an exact USI move set.

    The pinned upstream source (source/perft.h) prints one root line per legal
    move in the form "7g7f: 1" and then "Nodes searched: N". A malformed,
    duplicate, or non-unit root count is rejected rather than silently falling
    back to node-count-only comparison.
    """
    summary = PERFT_NODES_RE.search(summary_line)
    if not summary:
        raise ValueError(f"unrecognised YaneuraOu perft summary: {summary_line!r}")
    nodes = int(summary.group(1))
    moves: list[str] = []
    for line in lines:
        match = PERFT_MOVE_LINE_RE.fullmatch(line)
        if not match:
            continue
        move, count_text = match.groups()
        if not USI_MOVE_RE.fullmatch(move):
            raise ValueError(f"invalid USI move in YaneuraOu perft output: {move!r}")
        count = int(count_text)
        if count != 1:
            raise ValueError(
                f"depth-1 perft root count must be 1 for {move}, received {count}"
            )
        if move in moves:
            raise ValueError(f"duplicate move in YaneuraOu perft output: {move}")
        moves.append(move)

    if len(moves) != nodes:
        raise ValueError(
            "YaneuraOu perft divide lines do not match summary: "
            f"{len(moves)} root moves vs {nodes} nodes"
        )
    return tuple(sorted(moves)), nodes


class USIProcess:
    def __init__(self, executable: str, timeout: float = 45.0) -> None:
        self.timeout = timeout
        self.proc = subprocess.Popen(
            [executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
            bufsize=1,
        )
        self.lines: queue.Queue[str | None] = queue.Queue()
        self.reader = threading.Thread(target=self._read_stdout, daemon=True)
        self.reader.start()
        self.send("usi")
        self.wait_for(lambda line: line == "usiok", "USI handshake")
        self.send("isready")
        self.wait_for(lambda line: line == "readyok", "engine readiness")

    def _read_stdout(self) -> None:
        assert self.proc.stdout is not None
        try:
            for line in self.proc.stdout:
                self.lines.put(line.rstrip("\r\n"))
        finally:
            self.lines.put(None)

    def send(self, command: str) -> None:
        if self.proc.poll() is not None:
            raise RuntimeError(f"YaneuraOu exited with code {self.proc.returncode}")
        assert self.proc.stdin is not None
        self.proc.stdin.write(command + "\n")
        self.proc.stdin.flush()

    def _read_until(self, predicate, label: str) -> tuple[list[str], str]:
        deadline = time.monotonic() + self.timeout
        seen: list[str] = []
        while time.monotonic() < deadline:
            remaining = max(0.01, deadline - time.monotonic())
            try:
                line = self.lines.get(timeout=remaining)
            except queue.Empty:
                break
            if line is None:
                break
            seen.append(line)
            if predicate(line):
                return seen[:-1], line
        tail = " | ".join(seen[-12:])
        raise TimeoutError(f"timed out waiting for {label}; recent output: {tail}")

    def wait_for(self, predicate, label: str) -> str:
        _preceding, line = self._read_until(predicate, label)
        return line

    def inspect(self, sfen: str) -> tuple[str, tuple[str, ...], int]:
        self.send(f"position sfen {sfen}")
        self.send("d")
        line = self.wait_for(lambda item: item.startswith("sfen "), "YaneuraOu SFEN dump")
        native_sfen = line[len("sfen "):].strip()

        self.send("go perft 1")
        divide_lines, summary_line = self._read_until(
            lambda item: "Nodes searched:" in item,
            "perft depth-1 divide and summary",
        )
        native_moves, nodes = parse_perft_output(divide_lines, summary_line)
        return native_sfen, native_moves, nodes

    def close(self) -> None:
        if self.proc.poll() is None:
            try:
                self.send("quit")
                self.proc.wait(timeout=5)
            except Exception:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait(timeout=3)

    def __enter__(self) -> "USIProcess":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()


def compare(engine: USIProcess, sfen: str) -> dict[str, object]:
    pos = parse_sfen(sfen)
    source_state = canonical_state(pos)
    source_key = state_key(pos)
    native_sfen, native_moves, nodes = engine.inspect(to_sfen(pos))
    native_pos = parse_sfen(native_sfen)
    native_state = canonical_state(native_pos)
    native_key = state_key(native_pos)
    cfe_moves = tuple(legal_moves(pos))
    expected_moves = set(cfe_moves)
    actual_moves = set(native_moves)
    return {
        "engine": "YaneuraOu",
        "canonical_state_equal": source_state == native_state,
        "state_key": native_key,
        "expected_state_key": source_key,
        "state_key_equal": native_key == source_key,
        "legal_moves_equal": expected_moves == actual_moves,
        "missing_from_engine": sorted(expected_moves - actual_moves),
        "extra_from_engine": sorted(actual_moves - expected_moves),
        "yaneuraou_perft_depth_1": nodes,
        "cfe_legal_move_count": len(cfe_moves),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine-path", required=True, help="path to a built YaneuraOu executable")
    ap.add_argument("--sfen", help="check one SFEN; omit to check the shared corpus")
    ap.add_argument("--timeout", type=float, default=45.0)
    ap.add_argument("--limit", type=int, default=0, help="0 means all corpus cases")
    ap.add_argument("--corpus", type=Path, default=ROOT / "corpus/sfen-v1.jsonl")
    ns = ap.parse_args()
    if ns.limit < 0:
        ap.error("--limit cannot be negative")
    if ns.sfen:
        rows = [{"id": "single", "sfen": ns.sfen}]
    else:
        if not ns.corpus.is_file():
            ap.error(f"corpus file does not exist: {ns.corpus}")
        rows = [json.loads(line) for line in ns.corpus.read_text(encoding="utf-8").splitlines() if line.strip()]
        if not rows:
            ap.error(f"corpus is empty: {ns.corpus}")
        if ns.limit:
            rows = rows[:ns.limit]
    failures = 0
    with USIProcess(ns.engine_path, timeout=ns.timeout) as engine:
        for row in rows:
            result = compare(engine, row["sfen"])
            print(json.dumps({"id": row["id"], **result}, ensure_ascii=False, sort_keys=True))
            if (not result["canonical_state_equal"] or not result["state_key_equal"]
                    or not result["legal_moves_equal"]
                    or result["yaneuraou_perft_depth_1"] != result["cfe_legal_move_count"]):
                failures += 1
    print(json.dumps({"engine": "YaneuraOu", "cases": len(rows), "failures": failures}, sort_keys=True))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
