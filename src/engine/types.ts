// Core constants and encodings shared by the whole engine.

export const WHITE = 0;
export const BLACK = 1;
export type Color = 0 | 1;

export const EMPTY = 0;
export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

// Piece code = type | (color << 3). White pawn = 1, black pawn = 9, etc.
export const WP = 1, WN = 2, WB = 3, WR = 4, WQ = 5, WK = 6;
export const BP = 9, BN = 10, BB = 11, BR = 12, BQ = 13, BK = 14;

export const makePiece = (color: number, type: number): number => type | (color << 3);
export const pieceType = (p: number): number => p & 7;
export const pieceColor = (p: number): number => p >> 3;

// 0x88 squares: a1 = 0, h1 = 7, a2 = 16 ... h8 = 119.
export const A1 = 0, B1 = 1, C1 = 2, D1 = 3, E1 = 4, F1 = 5, G1 = 6, H1 = 7;
export const A8 = 112, B8 = 113, C8 = 114, D8 = 115, E8 = 116, F8 = 117, G8 = 118, H8 = 119;
export const NO_SQ = -1;

export const sqFile = (sq: number): number => sq & 7;
export const sqRank = (sq: number): number => sq >> 4;
export const sq88 = (file: number, rank: number): number => (rank << 4) | file;
export const to64 = (sq: number): number => ((sq >> 4) << 3) | (sq & 7);
export const from64 = (i: number): number => ((i >> 3) << 4) | (i & 7);
export const offBoard = (sq: number): boolean => (sq & 0x88) !== 0;

export const FILES = 'abcdefgh';
export const sqName = (sq: number): string => FILES[sq & 7] + (1 + (sq >> 4));
export function parseSq(s: string): number {
  if (s.length !== 2) return NO_SQ;
  const f = FILES.indexOf(s[0]);
  const r = s.charCodeAt(1) - 49;
  if (f < 0 || r < 0 || r > 7) return NO_SQ;
  return sq88(f, r);
}

// Castling rights bits
export const CASTLE_WK = 1, CASTLE_WQ = 2, CASTLE_BK = 4, CASTLE_BQ = 8;

// Move encoding (32-bit int):
//  bits 0-6 from, 7-13 to, 14-17 captured piece code, 18-20 promotion type, 21-23 flags
export const FLAG_EP = 1 << 21;
export const FLAG_CASTLE = 1 << 22;
export const FLAG_DOUBLE = 1 << 23;
export const NO_MOVE = 0;

export const encodeMove = (from: number, to: number, captured: number, promo: number, flags: number): number =>
  from | (to << 7) | (captured << 14) | (promo << 18) | flags;
export const moveFrom = (m: number): number => m & 127;
export const moveTo = (m: number): number => (m >> 7) & 127;
export const moveCaptured = (m: number): number => (m >> 14) & 15;
export const movePromo = (m: number): number => (m >> 18) & 7;
export const moveIsEp = (m: number): boolean => (m & FLAG_EP) !== 0;
export const moveIsCastle = (m: number): boolean => (m & FLAG_CASTLE) !== 0;
export const moveIsDouble = (m: number): boolean => (m & FLAG_DOUBLE) !== 0;
export const moveIsCapture = (m: number): boolean => ((m >> 14) & 15) !== 0;
export const moveIsTactical = (m: number): boolean => ((m >> 14) & 127) !== 0; // capture or promotion

export const PIECE_CHARS = '.PNBRQK..pnbrqk.';
export const PROMO_CHARS = '..nbrq..';

export function moveToUci(m: number): string {
  if (m === NO_MOVE) return '0000';
  let s = sqName(moveFrom(m)) + sqName(moveTo(m));
  const p = movePromo(m);
  if (p) s += PROMO_CHARS[p];
  return s;
}

export const MAX_PLY = 128;
export const MATE_VALUE = 32000;
export const MATE_IN_MAX = MATE_VALUE - MAX_PLY;
export const INFINITE = 32500;
export const VALUE_NONE = 32501;
export const DRAW_VALUE = 0;

export const STARTPOS_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
