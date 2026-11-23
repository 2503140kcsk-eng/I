import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SfenError,
  SFEN_PROFILE,
  canonicalizeSfen,
  getPositionKey,
  parsePlayableSfen,
  parseSfen,
  samePosition,
} from '../src/sfen.js';

const STARTPOS = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
const BARE_KINGS = '4k4/9/9/9/9/9/9/9/4K4';

test('profile contract is explicit and stable', () => {
  assert.equal(SFEN_PROFILE.name, 'CFE-SFEN-1');
  assert.equal(SFEN_PROFILE.maxMoveNumber, 0xffff_ffff);
  assert.deepEqual(SFEN_PROFILE.positionKeyFields, ['board', 'side-to-move', 'hands']);
});

test('initial position parses and round-trips byte-for-byte', () => {
  const position = parseSfen(STARTPOS);
  assert.equal(position.toSfen(), STARTPOS);
  assert.equal(position.positionKey(), STARTPOS.slice(0, STARTPOS.lastIndexOf(' ')));
  assert.equal(position.board.length, 81);
  assert.equal(position.sideToMove, 'b');
  assert.equal(position.moveNumber, 1);
  assert.equal(position.hands.b.P, 0);
  assert.equal(Object.isFrozen(position), true);
  assert.equal(Object.isFrozen(position.board), true);
  assert.equal(Object.isFrozen(position.hands.b), true);
});

test('hand token order normalizes to one canonical order', () => {
  const a = `${BARE_KINGS} b P2Rp 1`;
  const b = `${BARE_KINGS} b 2RPp 1`;
  const canonical = `${BARE_KINGS} b 2RPp 1`;
  assert.equal(canonicalizeSfen(a), canonical);
  assert.equal(canonicalizeSfen(b), canonical);
  assert.equal(parseSfen(a).toSfen(), parseSfen(b).toSfen());
  assert.equal(getPositionKey(a), getPositionKey(b));
  assert.equal(samePosition(a, b), true);
});

test('move number is preserved by SFEN but excluded from position identity', () => {
  const early = `${BARE_KINGS} b - 1`;
  const late = `${BARE_KINGS} b - 428`;
  assert.notEqual(canonicalizeSfen(early), canonicalizeSfen(late));
  assert.equal(getPositionKey(early), getPositionKey(late));
  assert.equal(samePosition(early, late), true);
});

test('side-to-move and hands remain identity-bearing', () => {
  const black = `${BARE_KINGS} b P 1`;
  const white = `${BARE_KINGS} w P 1`;
  const differentHand = `${BARE_KINGS} b p 1`;
  assert.notEqual(getPositionKey(black), getPositionKey(white));
  assert.notEqual(getPositionKey(black), getPositionKey(differentHand));
  assert.equal(samePosition(black, white), false);
  assert.equal(samePosition(black, differentHand), false);
});

test('promotions, colors and all hand counts survive canonical round-trip', () => {
  const sfen = 'k8/9/2+s6/3+P5/4+B4/5+r3/9/9/8K w R2G3Pbl 320';
  const canonical = canonicalizeSfen(sfen);
  assert.equal(canonical, sfen);
  assert.equal(parseSfen(canonical).toSfen(), canonical);
});

test('position representation is immutable to callers', () => {
  const position = parseSfen(STARTPOS);
  assert.throws(() => { position.board[0] = null; }, TypeError);
  assert.throws(() => { position.hands.b.P = 4; }, TypeError);
});

test('parser rejects malformed field structure and non-ASCII input', () => {
  const invalid = [
    '',
    `${BARE_KINGS} b -`,
    `${BARE_KINGS} b - 1 extra`,
    ` ${BARE_KINGS} b - 1`,
    `${BARE_KINGS}  b - 1`,
    `${BARE_KINGS} b - 1 `,
    `${BARE_KINGS}\tb - 1`,
    `${BARE_KINGS} b - １`,
    42,
    null,
  ];
  for (const input of invalid) {
    assert.throws(() => parseSfen(input), SfenError, String(input));
  }
});

test('parser rejects board rank, width and token errors', () => {
  const invalid = [
    '4k4/9/9/9/9/9/9/4K4 b - 1', // eight ranks
    '4k4/9/9/9/9/9/9/9/3K4 b - 1', // last rank too narrow
    '5k4/9/9/9/9/9/9/9/4K4 b - 1', // first rank too wide
    '44k1/9/9/9/9/9/9/9/4K4 b - 1', // adjacent empty counters
    '0k8/9/9/9/9/9/9/9/4K4 b - 1',
    '4q4/9/9/9/9/9/9/9/4K4 b - 1',
    '4+K4/9/9/9/9/9/9/9/4K4 b - 1',
    '4+G4/9/9/9/9/9/9/9/4K4 b - 1',
    '4+4/9/9/9/9/9/9/9/4K4 b - 1',
    '4k4/9/9/9/9/9/9/9/4K+ b - 1',
  ];
  for (const input of invalid) {
    assert.throws(() => parseSfen(input), SfenError, input);
  }
});

test('parser rejects invalid side, hand tokens, duplicate hands and inventory overflow', () => {
  const invalid = [
    `${BARE_KINGS} B - 1`,
    `${BARE_KINGS} b K 1`,
    `${BARE_KINGS} b +P 1`,
    `${BARE_KINGS} b 1P 1`,
    `${BARE_KINGS} b 0P 1`,
    `${BARE_KINGS} b 01P 1`,
    `${BARE_KINGS} b 19P 1`,
    `${BARE_KINGS} b P2 1`,
    `${BARE_KINGS} b PP 1`,
    `${BARE_KINGS} b P2P 1`,
    `${BARE_KINGS} b -- 1`,
    'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b P 1', // 19 pawns total
    '4k4/9/9/9/9/9/9/9/9 b - 1', // missing sente king
    '4k4/9/9/9/9/9/9/9/3KK3 b - 1', // duplicate sente king
  ];
  for (const input of invalid) {
    assert.throws(() => parseSfen(input), SfenError, input);
  }
});

test('parser rejects non-canonical and out-of-range move numbers', () => {
  for (const move of ['0', '01', '+1', '-1', '1.0', '4294967296', '999999999999999999999']) {
    assert.throws(() => parseSfen(`${BARE_KINGS} b - ${move}`), (error) => error instanceof SfenError && error.code === 'MOVE_NUMBER');
  }
  assert.equal(parseSfen(`${BARE_KINGS} b - 4294967295`).moveNumber, 0xffff_ffff);
});

test('strict SFEN parse and local-playability checks are intentionally distinct', () => {
  const nifu = '4k4/9/9/9/9/9/4P4/4P4/4K4 b - 1';
  assert.doesNotThrow(() => parseSfen(nifu));
  assert.throws(() => parsePlayableSfen(nifu), (error) => error instanceof SfenError && error.code === 'NIFU');

  const deadPawn = 'P3k4/9/9/9/9/9/9/9/4K4 b - 1';
  assert.doesNotThrow(() => parseSfen(deadPawn));
  assert.throws(() => parsePlayableSfen(deadPawn), (error) => error instanceof SfenError && error.code === 'DEAD_RANK_PIECE');

  // Promoted pieces move as golds and are not dead-rank pieces.
  const promotedPawnsOnDeadRanks = '+P3k4/9/9/9/9/9/9/9/+p3K4 b - 1';
  assert.doesNotThrow(() => parsePlayableSfen(promotedPawnsOnDeadRanks));
});

test('all errors expose stable machine-readable codes', () => {
  assert.throws(() => parseSfen('x'), (error) => {
    assert.ok(error instanceof SfenError);
    assert.equal(error.code, 'FIELD_COUNT');
    return true;
  });
});

test('every promotable piece kind and side retains its exact token', () => {
  const cases = [
    ['+P', '+p'], ['+L', '+l'], ['+N', '+n'],
    ['+S', '+s'], ['+B', '+b'], ['+R', '+r'],
  ];
  for (const [sente, gote] of cases) {
    const row = `4k4/9/9/9/4${sente}4/4${gote}4/9/9/4K4`;
    const input = `${row} b - 1`;
    assert.equal(canonicalizeSfen(input), input);
  }
  assert.equal(parseSfen(`${BARE_KINGS} b - 1`).board[4].kind, 'K');
});

test('standard material ceilings are enforced across both hands and board', () => {
  const fullSetInHands = `${BARE_KINGS} b 2R2B4G4S4N4L18P 1`;
  assert.equal(parseSfen(fullSetInHands).toSfen(), fullSetInHands);
  assert.throws(
    () => parseSfen(`${BARE_KINGS} b 2R2B4G4S4N4L19P 1`),
    (error) => error instanceof SfenError && error.code === 'HAND_COUNT',
  );
});

test('canonicalization is idempotent and parsed objects share the same key API', () => {
  const input = `${BARE_KINGS} b P2Rp 15`;
  const once = canonicalizeSfen(input);
  assert.equal(canonicalizeSfen(once), once);
  const parsed = parseSfen(input);
  assert.equal(getPositionKey(parsed), getPositionKey(input));
  assert.equal(samePosition(parsed, parseSfen(once)), true);
});

test('input size limit prevents unbounded parsing work', () => {
  assert.throws(
    () => parseSfen('x'.repeat(513)),
    (error) => error instanceof SfenError && error.code === 'INPUT_TOO_LONG',
  );
});
