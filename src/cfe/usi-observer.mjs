/**
 * Conservative, transport-independent observer for common USI commands.
 * It does not execute an engine and never upgrades engine output to a proof.
 */

function tokenize(line, maxLength = 65536) {
  if (typeof line !== "string") throw new TypeError("USI line must be a string");
  if (line.length > maxLength) throw new RangeError("USI line exceeds the configured limit");
  if (line.includes("\0")) throw new TypeError("USI line contains a NUL byte");
  const trimmed = line.trim();
  return trimmed ? trimmed.split(/\s+/) : [];
}

function parseMoves(tokens, label) {
  if (!Array.isArray(tokens)) throw new TypeError(label + " must be an array");
  for (const move of tokens) {
    if (!move || move.length > 16) throw new TypeError(label + " contains an invalid move token");
  }
  return tokens.slice();
}

export function parsePositionCommand(line) {
  const tokens = tokenize(line);
  if (tokens[0] !== "position") throw new TypeError("Expected a USI position command");
  if (tokens[1] === "startpos") {
    if (tokens.length === 2) return { kind: "startpos", moves: [] };
    if (tokens[2] !== "moves") throw new TypeError("Unexpected token after position startpos");
    return { kind: "startpos", moves: parseMoves(tokens.slice(3), "position moves") };
  }
  if (tokens[1] === "sfen") {
    if (tokens.length < 6) throw new TypeError("position sfen requires four SFEN fields");
    const sfenFields = tokens.slice(2, 6);
    if (tokens.length === 6) return { kind: "sfen", sfen: sfenFields.join(" "), moves: [] };
    if (tokens[6] !== "moves") throw new TypeError("Unexpected token after SFEN fields");
    return {
      kind: "sfen",
      sfen: sfenFields.join(" "),
      moves: parseMoves(tokens.slice(7), "position moves")
    };
  }
  throw new TypeError("position must use startpos or sfen");
}

const GO_NUMERIC = new Set([
  "btime", "wtime", "byoyomi", "binc", "winc", "movetime", "depth", "nodes", "mate"
]);

export function parseGoCommand(line) {
  const tokens = tokenize(line);
  if (tokens[0] !== "go") throw new TypeError("Expected a USI go command");
  const result = { mode: tokens.includes("mate") ? "mate" : "normal", parameters: {}, flags: [], searchmoves: [] };
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (GO_NUMERIC.has(token)) {
      const raw = tokens[i + 1];
      if (raw === undefined || !/^\d+$/.test(raw)) {
        throw new TypeError("USI go parameter " + token + " requires a non-negative integer");
      }
      const value = Number(raw);
      if (!Number.isSafeInteger(value)) throw new RangeError("USI go parameter is outside the safe integer range");
      result.parameters[token] = value;
      i += 1;
      continue;
    }
    if (token === "searchmoves") {
      const start = i + 1;
      let end = start;
      while (end < tokens.length && !GO_NUMERIC.has(tokens[end]) &&
          !["infinite", "ponder", "searchmoves"].includes(tokens[end])) end += 1;
      result.searchmoves = parseMoves(tokens.slice(start, end), "searchmoves");
      if (result.searchmoves.length === 0) throw new TypeError("searchmoves requires at least one move");
      i = end - 1;
      continue;
    }
    if (token === "infinite" || token === "ponder") {
      result.flags.push(token);
      continue;
    }
    // Preserve unknown extension tokens instead of rejecting a vendor option.
    result.flags.push(token);
  }
  return result;
}

export class UsiProxyObserver {
  #state = {
    usiOk: false,
    ready: false,
    searching: false,
    stopRequested: false,
    terminated: false,
    position: null,
    activeSearch: null,
    mateClaim: null,
    bestMove: null
  };

  snapshot() {
    return structuredClone(this.#state);
  }

  acceptGuiLine(line) {
    const tokens = tokenize(line);
    if (tokens.length === 0) return { forward: false, line, event: "EMPTY" };
    const command = tokens[0];

    if (command === "usi") {
      this.#state.usiOk = false;
      this.#state.ready = false;
    } else if (command === "isready") {
      this.#state.ready = false;
    } else if (command === "usinewgame") {
      this.#state.searching = false;
      this.#state.stopRequested = false;
      this.#state.position = null;
      this.#state.activeSearch = null;
      this.#state.mateClaim = null;
      this.#state.bestMove = null;
    } else if (command === "position") {
      this.#state.position = parsePositionCommand(line);
      this.#state.mateClaim = null;
      this.#state.bestMove = null;
    } else if (command === "go") {
      this.#state.activeSearch = parseGoCommand(line);
      this.#state.searching = true;
      this.#state.stopRequested = false;
      this.#state.mateClaim = null;
      this.#state.bestMove = null;
    } else if (command === "stop") {
      this.#state.stopRequested = true;
    } else if (command === "quit") {
      this.#state.terminated = true;
    } else if (command === "gameover") {
      this.#state.searching = false;
      this.#state.activeSearch = null;
    }
    return { forward: true, line: line, command: command };
  }

  acceptEngineLine(line) {
    const tokens = tokenize(line);
    if (tokens.length === 0) return { forward: true, line: line, event: "EMPTY" };
    if (tokens[0] === "usiok") {
      this.#state.usiOk = true;
    } else if (tokens[0] === "readyok") {
      this.#state.ready = true;
    } else if (tokens[0] === "bestmove") {
      this.#state.bestMove = tokens[1] || null;
      this.#state.searching = false;
      this.#state.stopRequested = false;
      this.#state.activeSearch = null;
    } else if (tokens[0] === "checkmate") {
      if (tokens[1] === "timeout") {
        this.#state.mateClaim = {
          status: "INCOMPLETE",
          proofVerified: false,
          line: line
        };
      } else if (tokens[1] === "nomate") {
        this.#state.mateClaim = {
          status: "ENGINE_REPORT_NO_MATE",
          proofVerified: false,
          line: line
        };
      } else {
        this.#state.mateClaim = {
          status: "ENGINE_CLAIM_ONLY",
          proofVerified: false,
          principalVariation: tokens.slice(1),
          line: line
        };
      }
    }
    return { forward: true, line: line, event: tokens[0] };
  }
}
