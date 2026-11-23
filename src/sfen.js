/**
 * CFE-SFEN-1: strict SFEN parsing and deterministic position canonicalization.
 *
 * This module has no runtime dependencies and uses only ASCII SFEN tokens.
 * It is an independent implementation; it does not import code from shogi
 * engines or notation libraries.
 */

const INTERNAL = Symbol('CFE-SFEN internal constructor');
const MAX_INPUT_LENGTH = 512;
const MAX_MOVE_NUMBER = 0xffff_ffff;
const BOARD_RANKS = 9;
const BOARD_FILES = 9;
const BOARD_SIZE = BOARD_RANKS * BOARD_FILES;
const PIECE_KINDS = new Set(['K', 'R', 'B', 'G', 'S', 'N', 'L', 'P']);
const PROMOTABLE_KINDS = new Set(['R', 'B', 'S', 'N', 'L', 'P']);
const HAND_KINDS = ['R', 'B', 'G', 'S', 'N', 'L', 'P'];
const HAND_KIND_SET = new Set(HAND_KINDS);
const MATERIAL_LIMITS = Object.freeze({
  K: 2,
  R: 2,
  B: 2,
  G: 4,
  S: 4,
  N: 4,
  L: 4,
  P: 18,
});
const ZERO_HAND = () => ({ R: 0, B: 0, G: 0, S: 0, N: 0, L: 0, P: 0 });

/** A machine-readable SFEN error. `code` is stable across patch versions. */
export class SfenError extends Error {
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = 'SfenError';
    this.code = code;
    if (detail !== undefined) this.detail = Object.freeze({ ...detail });
  }
}

function fail(code, message, detail) {
  throw new SfenError(code, message, detail);
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function sideOf(letter) {
  return letter === letter.toUpperCase() ? 'b' : 'w';
}

function freezeHands(hands) {
  return Object.freeze({
    b: Object.freeze({ ...hands.b }),
    w: Object.freeze({ ...hands.w }),
  });
}

function serializeBoard(board) {
  const ranks = [];
  for (let rank = 0; rank < BOARD_RANKS; rank += 1) {
    let row = '';
    let emptyRun = 0;
    for (let file = 0; file < BOARD_FILES; file += 1) {
      const piece = board[rank * BOARD_FILES + file];
      if (piece === null) {
        emptyRun += 1;
        continue;
      }
      if (emptyRun > 0) {
        row += String(emptyRun);
        emptyRun = 0;
      }
      if (piece.promoted) row += '+';
      row += piece.side === 'b' ? piece.kind : piece.kind.toLowerCase();
    }
    if (emptyRun > 0) row += String(emptyRun);
    ranks.push(row);
  }
  return ranks.join('/');
}

function serializeHands(hands) {
  let result = '';
  for (const side of ['b', 'w']) {
    for (const kind of HAND_KINDS) {
      const count = hands[side][kind];
      if (count === 0) continue;
      if (count > 1) result += String(count);
      result += side === 'b' ? kind : kind.toLowerCase();
    }
  }
  return result || '-';
}

/**
 * Immutable parsed position. Construct instances with `parseSfen` only.
 * `positionKey()` deliberately excludes the SFEN move counter.
 */
class SfenPosition {
  #board;
  #hands;

  constructor(token, state) {
    if (token !== INTERNAL) {
      throw new TypeError('Use parseSfen() to construct an SfenPosition.');
    }
    this.#board = Object.freeze(state.board.map((piece) => (
      piece === null ? null : Object.freeze({ ...piece })
    )));
    this.#hands = freezeHands(state.hands);
    this.sideToMove = state.sideToMove;
    this.moveNumber = state.moveNumber;
    Object.freeze(this);
  }

  /** Read-only 81-square array in SFEN order (rank a..i, file 9..1). */
  get board() {
    return this.#board;
  }

  /** Read-only hand counts, keyed by `b` (sente) and `w` (gote). */
  get hands() {
    return this.#hands;
  }

  /** Four-field canonical SFEN, preserving the move number. */
  toSfen() {
    return `${serializeBoard(this.#board)} ${this.sideToMove} ${serializeHands(this.#hands)} ${this.moveNumber}`;
  }

  /**
   * Canonical identity for the board, side to move and hands.
   * The move number and game history are intentionally not included.
   */
  positionKey() {
    return `${serializeBoard(this.#board)} ${this.sideToMove} ${serializeHands(this.#hands)}`;
  }

  /** Compare bare SFEN position identity; this is not a repetition-history check. */
  samePosition(other) {
    return other instanceof SfenPosition && this.positionKey() === other.positionKey();
  }
}

/**
 * Parse the strict CFE-SFEN-1 profile.
 *
 * Required profile:
 * - exactly four fields, separated by one ASCII space;
 * - 9 ranks, each exactly 9 squares;
 * - recognized Shogi pieces and valid promotion markers;
 * - exactly one king per side and no more than the physical piece supply;
 * - valid hand counters, no king/promoted pieces in hand, no duplicate
 *   hand-kind token for the same side;
 * - a positive, canonical decimal move number in the uint32 range.
 *
 * A syntactically/structurally valid composition can still violate local
 * movement rules (nifu or dead-rank pieces). Use `parsePlayableSfen` when
 * those extra checks are required.
 */
export function parseSfen(input) {
  if (typeof input !== 'string') {
    fail('INVALID_TYPE', 'SFEN must be a string.');
  }
  if (input.length > MAX_INPUT_LENGTH) {
    fail('INPUT_TOO_LONG', `SFEN must not exceed ${MAX_INPUT_LENGTH} ASCII characters.`);
  }
  if (!/^[\x20-\x7e]*$/.test(input)) {
    fail('NON_ASCII', 'SFEN must contain printable ASCII characters only.');
  }

  const fields = input.split(' ');
  if (fields.length !== 4 || fields.some((field) => field.length === 0)) {
    fail('FIELD_COUNT', 'SFEN must contain exactly four non-empty fields separated by one ASCII space.');
  }
  const [boardField, sideField, handField, moveField] = fields;

  const ranks = boardField.split('/');
  if (ranks.length !== BOARD_RANKS) {
    fail('RANK_COUNT', `Board must contain exactly ${BOARD_RANKS} ranks.`, { found: ranks.length });
  }

  const board = Array(BOARD_SIZE).fill(null);
  const boardMaterial = { K: 0, R: 0, B: 0, G: 0, S: 0, N: 0, L: 0, P: 0 };
  const kings = { b: 0, w: 0 };

  for (let rank = 0; rank < BOARD_RANKS; rank += 1) {
    const row = ranks[rank];
    let offset = 0;
    let file = 0;
    let previousWasDigit = false;

    while (offset < row.length) {
      const current = row[offset];
      if (current >= '1' && current <= '9') {
        if (previousWasDigit) {
          fail('BOARD_SYNTAX', 'Adjacent empty-square counts are not canonical SFEN.', { rank: rank + 1, offset });
        }
        file += Number(current);
        offset += 1;
        previousWasDigit = true;
        if (file > BOARD_FILES) {
          fail('BOARD_WIDTH', 'A board rank expands to more than nine squares.', { rank: rank + 1, width: file });
        }
        continue;
      }

      let promoted = false;
      if (current === '+') {
        promoted = true;
        offset += 1;
        if (offset >= row.length) {
          fail('BOARD_SYNTAX', 'Promotion marker must be followed by a piece letter.', { rank: rank + 1, offset: offset - 1 });
        }
      }

      const letter = row[offset];
      offset += 1;
      const kind = letter.toUpperCase();
      if (!PIECE_KINDS.has(kind) || (letter !== letter.toUpperCase() && letter !== letter.toLowerCase())) {
        fail('BOARD_SYNTAX', `Unknown board piece token '${promoted ? '+' : ''}${letter}'.`, { rank: rank + 1, offset: offset - 1 });
      }
      if (promoted && !PROMOTABLE_KINDS.has(kind)) {
        fail('INVALID_PROMOTION', `Piece ${kind} cannot be promoted.`, { rank: rank + 1, offset: offset - 2 });
      }
      if (file >= BOARD_FILES) {
        fail('BOARD_WIDTH', 'A board rank expands to more than nine squares.', { rank: rank + 1, width: file + 1 });
      }

      const side = sideOf(letter);
      board[rank * BOARD_FILES + file] = { side, kind, promoted };
      file += 1;
      previousWasDigit = false;
      boardMaterial[kind] += 1;
      if (kind === 'K') kings[side] += 1;
    }

    if (file !== BOARD_FILES) {
      fail('BOARD_WIDTH', `Rank ${rank + 1} expands to ${file} squares; expected nine.`, { rank: rank + 1, width: file });
    }
  }

  if (sideField !== 'b' && sideField !== 'w') {
    fail('SIDE_TO_MOVE', "Side-to-move field must be 'b' or 'w'.");
  }

  const hands = { b: ZERO_HAND(), w: ZERO_HAND() };
  if (handField !== '-') {
    if (handField.length === 0) {
      fail('HAND_SYNTAX', 'Hand field must be '-' or contain one or more hand-piece tokens.');
    }
    let offset = 0;
    while (offset < handField.length) {
      const tokenStart = offset;
      let count = 1;
      let hadCount = false;
      if (isDigit(handField[offset])) {
        hadCount = true;
        while (offset < handField.length && isDigit(handField[offset])) offset += 1;
        const digits = handField.slice(tokenStart, offset);
        if (digits[0] === '0') {
          fail('HAND_COUNT', 'Hand counts must be positive canonical decimals without leading zeroes.', { offset: tokenStart });
        }
        count = Number(digits);
        if (!Number.isSafeInteger(count) || count < 2) {
          fail('HAND_COUNT', 'A hand count prefix must be an integer of at least two.', { offset: tokenStart });
        }
      }
      if (offset >= handField.length) {
        fail('HAND_SYNTAX', 'A hand count must be followed by a piece letter.', { offset: tokenStart });
      }

      const letter = handField[offset];
      offset += 1;
      const kind = letter.toUpperCase();
      if (!HAND_KIND_SET.has(kind) || (letter !== letter.toUpperCase() && letter !== letter.toLowerCase())) {
        fail('HAND_SYNTAX', `Invalid hand-piece token '${letter}'.`, { offset: offset - 1 });
      }
      const side = sideOf(letter);
      if (hands[side][kind] !== 0) {
        fail('DUPLICATE_HAND_KIND', `Hand piece ${letter} occurs more than once for the same side.`, { side, kind });
      }
      if (count > MATERIAL_LIMITS[kind]) {
        fail('HAND_COUNT', `Hand count for ${kind} exceeds the physical supply.`, { side, kind, count, limit: MATERIAL_LIMITS[kind] });
      }
      if (hadCount && count === 1) {
        fail('HAND_COUNT', 'A count of one must be omitted in canonical SFEN.');
      }
      hands[side][kind] = count;
    }
  }

  const totalMaterial = { ...boardMaterial };
  for (const side of ['b', 'w']) {
    for (const kind of HAND_KINDS) totalMaterial[kind] += hands[side][kind];
  }
  for (const kind of Object.keys(MATERIAL_LIMITS)) {
    if (totalMaterial[kind] > MATERIAL_LIMITS[kind]) {
      fail('MATERIAL_OVERFLOW', `Total ${kind} pieces on board and in hand exceed the standard set.`, {
        kind,
        count: totalMaterial[kind],
        limit: MATERIAL_LIMITS[kind],
      });
    }
  }

  for (const side of ['b', 'w']) {
    if (kings[side] !== 1) {
      fail('KING_COUNT', `A standard Shogi position must contain exactly one ${side === 'b' ? 'sente' : 'gote'} king.`, {
        side,
        count: kings[side],
      });
    }
  }

  if (!/^[1-9][0-9]*$/.test(moveField)) {
    fail('MOVE_NUMBER', 'Move number must be a positive canonical decimal integer.');
  }
  const moveNumber = Number(moveField);
  if (!Number.isSafeInteger(moveNumber) || moveNumber > MAX_MOVE_NUMBER) {
    fail('MOVE_NUMBER', `Move number must be between 1 and ${MAX_MOVE_NUMBER}.`);
  }

  return new SfenPosition(INTERNAL, { board, hands, sideToMove: sideField, moveNumber });
}

/**
 * Parse strict SFEN and additionally reject nifu and dead-rank pieces.
 * This is local diagram validation, not proof that the position is reachable
 * from the initial position or that every king/check condition is legal.
 */
export function parsePlayableSfen(input) {
  const position = parseSfen(input);
  const board = position.board;
  const pawnFiles = { b: new Set(), w: new Set() };

  for (let rank = 0; rank < BOARD_RANKS; rank += 1) {
    for (let file = 0; file < BOARD_FILES; file += 1) {
      const piece = board[rank * BOARD_FILES + file];
      if (piece === null) continue;

      if (piece.kind === 'P' && !piece.promoted) {
        if (pawnFiles[piece.side].has(file)) {
          fail('NIFU', `Unpromoted ${piece.side === 'b' ? 'sente' : 'gote'} pawns share file ${9 - file}.`, {
            side: piece.side,
            file: 9 - file,
            rank: rank + 1,
          });
        }
        pawnFiles[piece.side].add(file);
      }

      const senteDead = !piece.promoted && piece.side === 'b'
        && ((piece.kind === 'P' || piece.kind === 'L') ? rank === 0 : piece.kind === 'N' && rank <= 1);
      const goteDead = !piece.promoted && piece.side === 'w'
        && ((piece.kind === 'P' || piece.kind === 'L') ? rank === 8 : piece.kind === 'N' && rank >= 7);
      if (senteDead || goteDead) {
        fail('DEAD_RANK_PIECE', `Unpromoted ${piece.kind} cannot be placed on this final rank for its owner.`, {
          side: piece.side,
          kind: piece.kind,
          rank: rank + 1,
          file: 9 - file,
        });
      }
    }
  }
  return position;
}

/** Normalize a strict SFEN string to its unique four-field representation. */
export function canonicalizeSfen(input) {
  return parseSfen(input).toSfen();
}

/**
 * Return the canonical identity key for the board, side to move and hands.
 * Accepts either a parsed position or a strict SFEN string.
 */
export function getPositionKey(input) {
  const position = typeof input === 'string' ? parseSfen(input) : input;
  if (!(position instanceof SfenPosition)) {
    throw new TypeError('getPositionKey() expects an SFEN string or parsed SfenPosition.');
  }
  return position.positionKey();
}

/** Compare position identity while deliberately ignoring move number/history. */
export function samePosition(left, right) {
  const a = typeof left === 'string' ? parseSfen(left) : left;
  const b = typeof right === 'string' ? parseSfen(right) : right;
  if (!(a instanceof SfenPosition) || !(b instanceof SfenPosition)) {
    throw new TypeError('samePosition() expects SFEN strings or parsed SfenPosition values.');
  }
  return a.samePosition(b);
}

export const SFEN_PROFILE = Object.freeze({
  name: 'CFE-SFEN-1',
  maxInputLength: MAX_INPUT_LENGTH,
  maxMoveNumber: MAX_MOVE_NUMBER,
  ranks: BOARD_RANKS,
  files: BOARD_FILES,
  handOrder: 'RBGSNLP',
  fields: Object.freeze(['board', 'side-to-move', 'hands', 'move-number']),
  positionKeyFields: Object.freeze(['board', 'side-to-move', 'hands']),
});
