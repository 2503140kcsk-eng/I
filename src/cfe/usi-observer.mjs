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
  "btime", "wtime", "byoyomi", "binc", "winc", "movetime", "depth", "nodes"
]);

export function parseGoCommand(line) {
  const tokens = tokenize(line);
  if (tokens[0] !== "go") throw new TypeError("Expected a USI go command");

  const result = {
    mode: "normal",
    parameters: {},
    flags: [],
    searchmoves: [],
    mateTimeLimit: null
  };

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (token === "mate") {
      if (result.mode === "mate") throw new TypeError("USI go command repeats mate");
      result.mode = "mate";
      const optionalLimit = tokens[i + 1];

      if (optionalLimit === "infinite") {
        result.mateTimeLimit = { kind: "infinite" };
        i += 1;
      } else if (optionalLimit !== undefined && /^\\d+$/.test(optionalLimit)) {
        const value = Number(optionalLimit);
        if (!Number.isSafeInteger(value)) {
          throw new RangeError("USI mate time limit is outside the safe integer range");
        }
        result.mateTimeLimit = { kind: "milliseconds", value };
        i += 1;
      } else if (optionalLimit !== undefined && !GO_NUMERIC.has(optionalLimit) &&
          !["infinite", "ponder", "searchmoves"].includes(optionalLimit)) {
        throw new TypeError("USI go mate argument must be milliseconds or infinite");
      } else {
        // A bare "go mate" is accepted by YaneuraOu, but explicit
        // "go mate infinite" is more portable between USI engines.
        result.mateTimeLimit = { kind: "omitted" };
      }
      continue;
    }

    if (GO_NUMERIC.has(token)) {
      const raw = tokens[i + 1];
      if (raw === undefined || !/^\\d+$/.test(raw)) {
        throw new TypeError("USI go parameter " + token + " requires a non-negative integer");
      }
      const value = Number(raw);
      if (!Number.isSafeInteger(value)) {
        throw new RangeError("USI go parameter is outside the safe integer range");
      }
      result.parameters[token] = value;
      i += 1;
      continue;
    }

    if (token === "searchmoves") {
      const startIndex = i + 1;
      let endIndex = startIndex;
      while (endIndex < tokens.length && !GO_NUMERIC.has(tokens[endIndex]) &&
          !["mate", "infinite", "ponder", "searchmoves"].includes(tokens[endIndex])) {
        endIndex += 1;
      }
      result.searchmoves = parseMoves(tokens.slice(startIndex, endIndex), "searchmoves");
      if (result.searchmoves.length === 0) {
        throw new TypeError("searchmoves requires at least one move");
      }
      i = endIndex - 1;
      continue;
    }

    if (token === "infinite" || token === "ponder") {
      result.flags.push(token);
      continue;
    }

    // Preserve unknown extension tokens rather than rejecting a vendor option.
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
      // The checkmate response terminates the mate-search command. Every
      // status below is an engine report; none is a CFE certificate.
      this.#state.searching = false;
      this.#state.stopRequested = false;
      this.#state.activeSearch = null;

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
      } else if (tokens[1] === "notimplemented") {
        this.#state.mateClaim = {
          status: "ENGINE_NOT_IMPLEMENTED",
          proofVerified: false,
          line: line
        };
      } else if (tokens.length === 1) {
        this.#state.mateClaim = {
          status: "MALFORMED_EMPTY_CLAIM",
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
