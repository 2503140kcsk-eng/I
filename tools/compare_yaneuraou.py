#!/usr/bin/env python3
"""Cross-check the CFE state identity and depth-1 move count with YaneuraOu.

YaneuraOu is launched as a separate USI process. No YaneuraOu source, objects,
or private hash implementation are imported into CFE.
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

    def wait_for(self, predicate, label: str) -> str:
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
                return line
        tail = " | ".join(seen[-12:])
        raise TimeoutError(f"timed out waiting for {label}; recent output: {tail}")

    def inspect(self, sfen: str) -> tuple[str, int]:
        self.send(f"position sfen {sfen}")
        self.send("d")
        line = self.wait_for(lambda item: item.startswith("sfen "), "YaneuraOu SFEN dump")
        native_sfen = line[len("sfen "):].strip()
        self.send("go perft 1")
        line = self.wait_for(lambda item: "Nodes searched:" in item, "perft depth-1 result")
        match = re.search(r"Nodes searched:\s*(\d+)", line)
        if not match:
            raise RuntimeError(f"unrecognised YaneuraOu perft output: {line!r}")
        return native_sfen, int(match.group(1))

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
    native_sfen, nodes = engine.inspect(to_sfen(pos))
    native_pos = parse_sfen(native_sfen)
    native_state = canonical_state(native_pos)
    native_key = state_key(native_pos)
    cfe_count = len(legal_moves(pos))
    return {
        "engine": "YaneuraOu",
        "canonical_state_equal": source_state == native_state,
        "state_key": native_key,
        "expected_state_key": source_key,
        "state_key_equal": native_key == source_key,
        "perft_depth_1_equal": nodes == cfe_count,
        "yaneuraou_perft_depth_1": nodes,
        "cfe_legal_move_count": cfe_count,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine-path", required=True, help="path to a built YaneuraOu executable")
    ap.add_argument("--sfen", help="check one SFEN; omit to check the shared corpus")
    ap.add_argument("--timeout", type=float, default=45.0)
    ap.add_argument("--limit", type=int, default=0, help="0 means all corpus cases")
    ns = ap.parse_args()
    if ns.sfen:
        rows = [{"id": "single", "sfen": ns.sfen}]
    else:
        rows = [json.loads(line) for line in (ROOT / "corpus/sfen-v1.jsonl").read_text().splitlines() if line.strip()]
        if ns.limit:
            rows = rows[:ns.limit]
    failures = 0
    with USIProcess(ns.engine_path, timeout=ns.timeout) as engine:
        for row in rows:
            result = compare(engine, row["sfen"])
            print(json.dumps({"id": row["id"], **result}, ensure_ascii=False, sort_keys=True))
            if (not result["canonical_state_equal"] or not result["state_key_equal"]
                    or not result["perft_depth_1_equal"]):
                failures += 1
    print(json.dumps({"engine": "YaneuraOu", "cases": len(rows), "failures": failures}, sort_keys=True))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
