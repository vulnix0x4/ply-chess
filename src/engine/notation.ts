// Standard Algebraic Notation and UCI move strings.
import { Position } from './board';
import {
  PAWN, KING, NO_MOVE, KNIGHT, BISHOP, ROOK, QUEEN,
  moveFrom, moveTo, moveCaptured, movePromo, moveIsCastle, pieceType, sqName, sqFile, sqRank, parseSq, moveToUci,
} from './types';

const PIECE_LETTERS = '..NBRQK';

// SAN without check/mate suffix, given the legal move list of the position.
function sanBody(pos: Position, m: number, legal: number[]): string {
  if (moveIsCastle(m)) return moveTo(m) > moveFrom(m) ? 'O-O' : 'O-O-O';
  const from = moveFrom(m), to = moveTo(m);
  const piece = pos.board[from];
  const type = pieceType(piece);
  const capture = moveCaptured(m) !== 0;
  let s = '';
  if (type === PAWN) {
    if (capture) s += sqName(from)[0] + 'x';
    s += sqName(to);
    const promo = movePromo(m);
    if (promo) s += '=' + PIECE_LETTERS[promo];
    return s;
  }
  s += PIECE_LETTERS[type];
  // Disambiguation among other legal moves of the same piece type to the same square.
  let sameFile = false, sameRank = false, others = 0;
  for (const o of legal) {
    if (o === m || moveTo(o) !== to) continue;
    const of = moveFrom(o);
    if (pieceType(pos.board[of]) !== type) continue;
    others++;
    if (sqFile(of) === sqFile(from)) sameFile = true;
    if (sqRank(of) === sqRank(from)) sameRank = true;
  }
  if (others > 0) {
    if (!sameFile) s += sqName(from)[0];
    else if (!sameRank) s += sqName(from)[1];
    else s += sqName(from);
  }
  if (capture) s += 'x';
  s += sqName(to);
  return s;
}

export function moveToSan(pos: Position, m: number, legal?: number[]): string {
  const moves = legal ?? pos.legalMoves();
  let s = sanBody(pos, m, moves);
  if (!pos.makeMove(m)) return s;
  if (pos.inCheck()) s += pos.legalMoves().length === 0 ? '#' : '+';
  pos.unmakeMove();
  return s;
}

const SAN_RE = /^([NBRQK])?([a-h])?([1-8])?(x|:)?([a-h][1-8])(?:=?([NBRQnbrq]))?$/;

// Parses a SAN string in the given position. Tolerant of missing/extra
// disambiguation, "x" markers, check symbols and annotation glyphs.
export function parseSan(pos: Position, san: string): number {
  let s = san.trim().replace(/[+#!?]+$/g, '').replace(/\s*e\.p\.$/i, '').replace(/0/g, 'O');
  if (s.endsWith('+') || s.endsWith('#')) s = s.slice(0, -1);
  const legal = pos.legalMoves();
  if (s === 'O-O' || s === 'O-O-O') {
    for (const m of legal) if (moveIsCastle(m) && ((moveTo(m) > moveFrom(m)) === (s === 'O-O'))) return m;
    return NO_MOVE;
  }
  const match = SAN_RE.exec(s);
  if (!match) return NO_MOVE;
  const [, pieceCh, fileCh, rankCh, , toStr, promoCh] = match;
  const type = pieceCh ? PIECE_LETTERS.indexOf(pieceCh) : PAWN;
  const to = parseSq(toStr);
  const promo = promoCh ? PIECE_LETTERS.indexOf(promoCh.toUpperCase()) : 0;
  const file = fileCh ? 'abcdefgh'.indexOf(fileCh) : -1;
  const rank = rankCh ? rankCh.charCodeAt(0) - 49 : -1;
  let found = NO_MOVE, count = 0;
  for (const m of legal) {
    if (moveTo(m) !== to || moveIsCastle(m)) continue;
    const from = moveFrom(m);
    if (pieceType(pos.board[from]) !== type) continue;
    if (movePromo(m) !== promo) continue;
    if (file >= 0 && sqFile(from) !== file) continue;
    if (rank >= 0 && sqRank(from) !== rank) continue;
    found = m; count++;
  }
  if (count === 1) return found;
  if (count > 1 && type === PAWN && file < 0) {
    // "e4" style pawn moves are pushes; ambiguity means the pawn capture was meant without file.
    for (const m of legal) {
      if (moveTo(m) === to && pieceType(pos.board[moveFrom(m)]) === PAWN && moveCaptured(m) === 0 && movePromo(m) === promo) return m;
    }
  }
  return NO_MOVE;
}

export function parseUci(pos: Position, uci: string): number {
  const s = uci.trim().toLowerCase();
  if (s.length < 4) return NO_MOVE;
  const from = parseSq(s.slice(0, 2)), to = parseSq(s.slice(2, 4));
  const promo = s.length > 4 ? '..nbrq'.indexOf(s[4]) : 0;
  for (const m of pos.legalMoves()) {
    if (moveFrom(m) === from && moveTo(m) === to && movePromo(m) === Math.max(0, promo)) return m;
  }
  // Some GUIs send castling as king-takes-rook; accept e1h1 style too.
  if (pieceType(pos.board[from]) === KING) {
    for (const m of pos.legalMoves()) {
      if (moveIsCastle(m) && moveFrom(m) === from && Math.sign(moveTo(m) - from) === Math.sign(to - from)) return m;
    }
  }
  return NO_MOVE;
}

export { moveToUci, KNIGHT, BISHOP, ROOK, QUEEN };

// Converts a principal variation (array of moves from `pos`) to SAN strings.
export function pvToSan(pos: Position, pv: number[]): string[] {
  const out: string[] = [];
  let made = 0;
  for (const m of pv) {
    if (!pos.isPseudoLegal(m)) break;
    out.push(moveToSan(pos, m));
    if (!pos.makeMove(m)) break;
    made++;
  }
  for (let i = 0; i < made; i++) pos.unmakeMove();
  return out;
}
