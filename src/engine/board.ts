// 0x88 board with piece lists. Pseudo-legal move generation; makeMove rejects
// moves that leave the own king in check. All state needed to undo a move is
// kept in struct-of-arrays history buffers so search never allocates.
import {
  WHITE, BLACK, EMPTY, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  WP, BP, NO_SQ, A1, E1, H1, A8, E8, H8,
  CASTLE_WK, CASTLE_WQ, CASTLE_BK, CASTLE_BQ,
  FLAG_EP, FLAG_CASTLE, FLAG_DOUBLE, NO_MOVE,
  makePiece, pieceType, pieceColor, encodeMove, moveFrom, moveTo, moveCaptured, movePromo,
  sqFile, sqRank, offBoard, sqName, parseSq, PIECE_CHARS, STARTPOS_FEN,
} from './types';
import {
  PIECE_KEY_LO, PIECE_KEY_HI, CASTLE_KEY_LO, CASTLE_KEY_HI, EP_KEY_LO, EP_KEY_HI, SIDE_KEY_LO, SIDE_KEY_HI,
} from './zobrist';
import { PST_MG, PST_EG, PHASE_INC } from './pst';

// ---- Attack tables -------------------------------------------------------
export const ATK_PAWN_W = 1, ATK_PAWN_B = 2, ATK_KNIGHT = 4, ATK_BISHOP = 8, ATK_ROOK = 16, ATK_KING = 32;
// ATTACKS[to - from + 128]: which piece kinds attack along that vector on an empty board.
export const ATTACKS = new Uint8Array(256);
// DELTAS[to - from + 128]: unit step for sliders (0 if not a ray).
export const DELTAS = new Int8Array(256);
export const KNIGHT_OFFS = [-33, -31, -18, -14, 14, 18, 31, 33];
export const KING_OFFS = [-17, -16, -15, -1, 1, 15, 16, 17];
export const BISHOP_DIRS = [-17, -15, 15, 17];
export const ROOK_DIRS = [-16, -1, 1, 16];
// Attack bit for each piece type (queen is both slider kinds).
const PIECE_ATK = [0, 0, ATK_KNIGHT, ATK_BISHOP, ATK_ROOK, ATK_BISHOP | ATK_ROOK, ATK_KING, 0];

for (const d of KNIGHT_OFFS) ATTACKS[d + 128] |= ATK_KNIGHT;
for (const d of KING_OFFS) ATTACKS[d + 128] |= ATK_KING;
for (const dir of BISHOP_DIRS) for (let i = 1; i < 8; i++) { ATTACKS[dir * i + 128] |= ATK_BISHOP; DELTAS[dir * i + 128] = dir; }
for (const dir of ROOK_DIRS) for (let i = 1; i < 8; i++) { ATTACKS[dir * i + 128] |= ATK_ROOK; DELTAS[dir * i + 128] = dir; }
ATTACKS[15 + 128] |= ATK_PAWN_W; ATTACKS[17 + 128] |= ATK_PAWN_W;
ATTACKS[-15 + 128] |= ATK_PAWN_B; ATTACKS[-17 + 128] |= ATK_PAWN_B;

// Castling rights that survive a move touching each square.
const CASTLE_MASK = new Uint8Array(128).fill(15);
CASTLE_MASK[A1] = 15 & ~CASTLE_WQ; CASTLE_MASK[E1] = 15 & ~(CASTLE_WK | CASTLE_WQ); CASTLE_MASK[H1] = 15 & ~CASTLE_WK;
CASTLE_MASK[A8] = 15 & ~CASTLE_BQ; CASTLE_MASK[E8] = 15 & ~(CASTLE_BK | CASTLE_BQ); CASTLE_MASK[H8] = 15 & ~CASTLE_BK;

const MAX_HIST = 1024;
const LIST_STRIDE = 10;

export class Position {
  board = new Int8Array(128);
  pieceList = new Int8Array(16 * LIST_STRIDE);
  pieceCount = new Int8Array(16);
  pieceIdx = new Int8Array(128);
  side = WHITE;
  castling = 0;
  ep = NO_SQ;
  halfmove = 0;
  fullmove = 1;
  hashLo = 0;
  hashHi = 0;
  pawnLo = 0;
  pawnHi = 0;
  mg = new Int32Array(2);
  eg = new Int32Array(2);
  phase = 0;
  // History (struct of arrays)
  hply = 0;
  hMove = new Int32Array(MAX_HIST);
  hCastle = new Int8Array(MAX_HIST);
  hEp = new Int16Array(MAX_HIST);
  hHalf = new Int16Array(MAX_HIST);
  hHashLo = new Uint32Array(MAX_HIST);
  hHashHi = new Uint32Array(MAX_HIST);
  hPawnLo = new Uint32Array(MAX_HIST);
  hPawnHi = new Uint32Array(MAX_HIST);

  constructor(fen: string = STARTPOS_FEN) {
    this.setFen(fen);
  }

  clone(): Position {
    const p = new Position(STARTPOS_FEN);
    p.board.set(this.board); p.pieceList.set(this.pieceList); p.pieceCount.set(this.pieceCount); p.pieceIdx.set(this.pieceIdx);
    p.side = this.side; p.castling = this.castling; p.ep = this.ep; p.halfmove = this.halfmove; p.fullmove = this.fullmove;
    p.hashLo = this.hashLo; p.hashHi = this.hashHi; p.pawnLo = this.pawnLo; p.pawnHi = this.pawnHi;
    p.mg.set(this.mg); p.eg.set(this.eg); p.phase = this.phase;
    p.hply = this.hply;
    p.hMove.set(this.hMove); p.hCastle.set(this.hCastle); p.hEp.set(this.hEp); p.hHalf.set(this.hHalf);
    p.hHashLo.set(this.hHashLo); p.hHashHi.set(this.hHashHi); p.hPawnLo.set(this.hPawnLo); p.hPawnHi.set(this.hPawnHi);
    return p;
  }

  // ---- Piece bookkeeping -------------------------------------------------
  private clear(): void {
    this.board.fill(EMPTY); this.pieceList.fill(0); this.pieceCount.fill(0); this.pieceIdx.fill(0);
    this.side = WHITE; this.castling = 0; this.ep = NO_SQ; this.halfmove = 0; this.fullmove = 1;
    this.hashLo = 0; this.hashHi = 0; this.pawnLo = 0; this.pawnHi = 0;
    this.mg[0] = this.mg[1] = 0; this.eg[0] = this.eg[1] = 0; this.phase = 0; this.hply = 0;
  }

  private addPiece(sq: number, p: number): void {
    this.board[sq] = p;
    const n = this.pieceCount[p]++;
    this.pieceList[p * LIST_STRIDE + n] = sq;
    this.pieceIdx[sq] = n;
    const k = p * 128 + sq;
    this.hashLo = (this.hashLo ^ PIECE_KEY_LO[k]) >>> 0; this.hashHi = (this.hashHi ^ PIECE_KEY_HI[k]) >>> 0;
    if ((p & 7) === PAWN) { this.pawnLo = (this.pawnLo ^ PIECE_KEY_LO[k]) >>> 0; this.pawnHi = (this.pawnHi ^ PIECE_KEY_HI[k]) >>> 0; }
    const c = p >> 3;
    this.mg[c] += PST_MG[k]; this.eg[c] += PST_EG[k]; this.phase += PHASE_INC[p & 7];
  }

  private removePiece(sq: number): void {
    const p = this.board[sq];
    this.board[sq] = EMPTY;
    const idx = this.pieceIdx[sq];
    const last = --this.pieceCount[p];
    const base = p * LIST_STRIDE;
    if (idx !== last) {
      const lsq = this.pieceList[base + last];
      this.pieceList[base + idx] = lsq;
      this.pieceIdx[lsq] = idx;
    }
    const k = p * 128 + sq;
    this.hashLo = (this.hashLo ^ PIECE_KEY_LO[k]) >>> 0; this.hashHi = (this.hashHi ^ PIECE_KEY_HI[k]) >>> 0;
    if ((p & 7) === PAWN) { this.pawnLo = (this.pawnLo ^ PIECE_KEY_LO[k]) >>> 0; this.pawnHi = (this.pawnHi ^ PIECE_KEY_HI[k]) >>> 0; }
    const c = p >> 3;
    this.mg[c] -= PST_MG[k]; this.eg[c] -= PST_EG[k]; this.phase -= PHASE_INC[p & 7];
  }

  private movePiece(from: number, to: number): void {
    const p = this.board[from];
    this.board[from] = EMPTY; this.board[to] = p;
    const idx = this.pieceIdx[from];
    this.pieceList[p * LIST_STRIDE + idx] = to;
    this.pieceIdx[to] = idx;
    const kf = p * 128 + from, kt = p * 128 + to;
    this.hashLo = (this.hashLo ^ PIECE_KEY_LO[kf] ^ PIECE_KEY_LO[kt]) >>> 0;
    this.hashHi = (this.hashHi ^ PIECE_KEY_HI[kf] ^ PIECE_KEY_HI[kt]) >>> 0;
    if ((p & 7) === PAWN) {
      this.pawnLo = (this.pawnLo ^ PIECE_KEY_LO[kf] ^ PIECE_KEY_LO[kt]) >>> 0;
      this.pawnHi = (this.pawnHi ^ PIECE_KEY_HI[kf] ^ PIECE_KEY_HI[kt]) >>> 0;
    }
    const c = p >> 3;
    this.mg[c] += PST_MG[kt] - PST_MG[kf]; this.eg[c] += PST_EG[kt] - PST_EG[kf];
  }

  kingSq(color: number): number {
    return this.pieceList[makePiece(color, KING) * LIST_STRIDE];
  }

  pieceSq(piece: number, i: number): number {
    return this.pieceList[piece * LIST_STRIDE + i];
  }

  // ---- FEN -----------------------------------------------------------------
  setFen(fen: string): boolean {
    const parts = fen.trim().split(/\s+/);
    if (parts.length < 2) return false;
    const rows = parts[0].split('/');
    if (rows.length !== 8) return false;
    this.clear();
    for (let r = 0; r < 8; r++) {
      const rank = 7 - r;
      let file = 0;
      for (const ch of rows[r]) {
        if (ch >= '1' && ch <= '8') { file += ch.charCodeAt(0) - 48; continue; }
        const p = PIECE_CHARS.indexOf(ch);
        if (p <= 0 || file > 7) { this.setFen(STARTPOS_FEN); return false; }
        if (this.pieceCount[p] >= LIST_STRIDE) { this.setFen(STARTPOS_FEN); return false; }
        this.addPiece((rank << 4) | file, p);
        file++;
      }
      if (file !== 8) { this.setFen(STARTPOS_FEN); return false; }
    }
    if (this.pieceCount[makePiece(WHITE, KING)] !== 1 || this.pieceCount[makePiece(BLACK, KING)] !== 1) {
      this.setFen(STARTPOS_FEN); return false;
    }
    this.side = parts[1] === 'b' ? BLACK : WHITE;
    if (this.side === BLACK) { this.hashLo = (this.hashLo ^ SIDE_KEY_LO) >>> 0; this.hashHi = (this.hashHi ^ SIDE_KEY_HI) >>> 0; }
    let castling = 0;
    const cs = parts[2] ?? '-';
    if (cs.includes('K') && this.board[E1] === makePiece(WHITE, KING) && this.board[H1] === makePiece(WHITE, ROOK)) castling |= CASTLE_WK;
    if (cs.includes('Q') && this.board[E1] === makePiece(WHITE, KING) && this.board[A1] === makePiece(WHITE, ROOK)) castling |= CASTLE_WQ;
    if (cs.includes('k') && this.board[E8] === makePiece(BLACK, KING) && this.board[H8] === makePiece(BLACK, ROOK)) castling |= CASTLE_BK;
    if (cs.includes('q') && this.board[E8] === makePiece(BLACK, KING) && this.board[A8] === makePiece(BLACK, ROOK)) castling |= CASTLE_BQ;
    this.castling = castling;
    this.hashLo = (this.hashLo ^ CASTLE_KEY_LO[castling]) >>> 0; this.hashHi = (this.hashHi ^ CASTLE_KEY_HI[castling]) >>> 0;
    const epStr = parts[3] ?? '-';
    this.ep = NO_SQ;
    if (epStr !== '-') {
      const sq = parseSq(epStr);
      if (sq !== NO_SQ && this.epCapturable(sq)) {
        this.ep = sq;
        this.hashLo = (this.hashLo ^ EP_KEY_LO[sq & 7]) >>> 0; this.hashHi = (this.hashHi ^ EP_KEY_HI[sq & 7]) >>> 0;
      }
    }
    this.halfmove = parts[4] !== undefined ? Math.max(0, parseInt(parts[4], 10) || 0) : 0;
    this.fullmove = parts[5] !== undefined ? Math.max(1, parseInt(parts[5], 10) || 1) : 1;
    // A position where the side not to move is in check is illegal.
    if (this.isAttacked(this.kingSq(this.side ^ 1), this.side)) { this.setFen(STARTPOS_FEN); return false; }
    return true;
  }

  // Is there a pawn of the side to move that could capture on the ep square?
  private epCapturable(sq: number): boolean {
    const us = this.side;
    const pawn = makePiece(us, PAWN);
    const back = us === WHITE ? -16 : 16;
    if (sqRank(sq) !== (us === WHITE ? 5 : 2)) return false;
    if (this.board[sq] !== EMPTY || this.board[sq + back] !== makePiece(us ^ 1, PAWN)) return false;
    const a = sq + back - 1, b = sq + back + 1;
    return (!offBoard(a) && this.board[a] === pawn) || (!offBoard(b) && this.board[b] === pawn);
  }

  fen(): string {
    let s = '';
    for (let rank = 7; rank >= 0; rank--) {
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const p = this.board[(rank << 4) | file];
        if (p === EMPTY) { empty++; continue; }
        if (empty) { s += empty; empty = 0; }
        s += PIECE_CHARS[p];
      }
      if (empty) s += empty;
      if (rank) s += '/';
    }
    s += this.side === WHITE ? ' w ' : ' b ';
    let c = '';
    if (this.castling & CASTLE_WK) c += 'K';
    if (this.castling & CASTLE_WQ) c += 'Q';
    if (this.castling & CASTLE_BK) c += 'k';
    if (this.castling & CASTLE_BQ) c += 'q';
    s += c || '-';
    s += ' ' + (this.ep === NO_SQ ? '-' : sqName(this.ep));
    s += ' ' + this.halfmove + ' ' + this.fullmove;
    return s;
  }

  // ---- Attacks -------------------------------------------------------------
  isAttacked(sq: number, by: number): boolean {
    const board = this.board, pl = this.pieceList, pc = this.pieceCount;
    if (by === WHITE) {
      let a = sq - 15; if (!(a & 0x88) && board[a] === WP) return true;
      a = sq - 17; if (!(a & 0x88) && board[a] === WP) return true;
    } else {
      let a = sq + 15; if (!(a & 0x88) && board[a] === BP) return true;
      a = sq + 17; if (!(a & 0x88) && board[a] === BP) return true;
    }
    const cb = by << 3;
    // Knights
    let p = cb | KNIGHT, base = p * LIST_STRIDE, n = pc[p];
    for (let i = 0; i < n; i++) if (ATTACKS[sq - pl[base + i] + 128] & ATK_KNIGHT) return true;
    // King
    p = cb | KING; base = p * LIST_STRIDE;
    if (ATTACKS[sq - pl[base] + 128] & ATK_KING) return true;
    // Sliders
    for (let type = BISHOP; type <= QUEEN; type++) {
      p = cb | type; base = p * LIST_STRIDE; n = pc[p];
      const mask = PIECE_ATK[type];
      for (let i = 0; i < n; i++) {
        const from = pl[base + i];
        const d = sq - from + 128;
        if (ATTACKS[d] & mask) {
          const step = DELTAS[d];
          let s = from + step;
          while (s !== sq && board[s] === EMPTY) s += step;
          if (s === sq) return true;
        }
      }
    }
    return false;
  }

  inCheck(): boolean {
    return this.isAttacked(this.kingSq(this.side), this.side ^ 1);
  }

  // ---- Move generation -----------------------------------------------------
  // Writes pseudo-legal moves into list starting at `start`; returns end index.
  genMoves(list: Int32Array, start: number): number {
    const us = this.side, them = us ^ 1;
    const board = this.board, pl = this.pieceList, pc = this.pieceCount;
    let n = start;
    const cb = us << 3;
    const push = us === WHITE ? 16 : -16;
    const startRank = us === WHITE ? 1 : 6;
    const promoRank = us === WHITE ? 7 : 0;
    const theirPawn = makePiece(them, PAWN);

    // Pawns
    let p = cb | PAWN, base = p * LIST_STRIDE, cnt = pc[p];
    for (let i = 0; i < cnt; i++) {
      const from = pl[base + i];
      const to = from + push;
      const toRank = to >> 4;
      if (board[to] === EMPTY) {
        if (toRank === promoRank) {
          list[n++] = encodeMove(from, to, 0, QUEEN, 0);
          list[n++] = encodeMove(from, to, 0, KNIGHT, 0);
          list[n++] = encodeMove(from, to, 0, ROOK, 0);
          list[n++] = encodeMove(from, to, 0, BISHOP, 0);
        } else {
          list[n++] = encodeMove(from, to, 0, 0, 0);
          if ((from >> 4) === startRank && board[to + push] === EMPTY) {
            list[n++] = encodeMove(from, to + push, 0, 0, FLAG_DOUBLE);
          }
        }
      }
      for (let k = 0; k < 2; k++) {
        const cap = k === 0 ? to - 1 : to + 1;
        if (cap & 0x88) continue;
        const target = board[cap];
        if (target !== EMPTY && (target >> 3) === them) {
          if (toRank === promoRank) {
            list[n++] = encodeMove(from, cap, target, QUEEN, 0);
            list[n++] = encodeMove(from, cap, target, KNIGHT, 0);
            list[n++] = encodeMove(from, cap, target, ROOK, 0);
            list[n++] = encodeMove(from, cap, target, BISHOP, 0);
          } else {
            list[n++] = encodeMove(from, cap, target, 0, 0);
          }
        } else if (cap === this.ep) {
          list[n++] = encodeMove(from, cap, theirPawn, 0, FLAG_EP);
        }
      }
    }

    // Knights
    p = cb | KNIGHT; base = p * LIST_STRIDE; cnt = pc[p];
    for (let i = 0; i < cnt; i++) {
      const from = pl[base + i];
      for (let k = 0; k < 8; k++) {
        const to = from + KNIGHT_OFFS[k];
        if (to & 0x88) continue;
        const target = board[to];
        if (target === EMPTY) list[n++] = encodeMove(from, to, 0, 0, 0);
        else if ((target >> 3) === them) list[n++] = encodeMove(from, to, target, 0, 0);
      }
    }

    // Sliders
    for (let type = BISHOP; type <= QUEEN; type++) {
      p = cb | type; base = p * LIST_STRIDE; cnt = pc[p];
      const dirs = type === BISHOP ? BISHOP_DIRS : type === ROOK ? ROOK_DIRS : KING_OFFS;
      for (let i = 0; i < cnt; i++) {
        const from = pl[base + i];
        for (let k = 0; k < dirs.length; k++) {
          const d = dirs[k];
          let to = from + d;
          while (!(to & 0x88)) {
            const target = board[to];
            if (target === EMPTY) { list[n++] = encodeMove(from, to, 0, 0, 0); to += d; continue; }
            if ((target >> 3) === them) list[n++] = encodeMove(from, to, target, 0, 0);
            break;
          }
        }
      }
    }

    // King
    p = cb | KING; base = p * LIST_STRIDE;
    const ksq = pl[base];
    for (let k = 0; k < 8; k++) {
      const to = ksq + KING_OFFS[k];
      if (to & 0x88) continue;
      const target = board[to];
      if (target === EMPTY) list[n++] = encodeMove(ksq, to, 0, 0, 0);
      else if ((target >> 3) === them) list[n++] = encodeMove(ksq, to, target, 0, 0);
    }

    // Castling
    if (us === WHITE) {
      if ((this.castling & CASTLE_WK) && board[E1 + 1] === EMPTY && board[E1 + 2] === EMPTY &&
        !this.isAttacked(E1, BLACK) && !this.isAttacked(E1 + 1, BLACK) && !this.isAttacked(E1 + 2, BLACK)) {
        list[n++] = encodeMove(E1, E1 + 2, 0, 0, FLAG_CASTLE);
      }
      if ((this.castling & CASTLE_WQ) && board[E1 - 1] === EMPTY && board[E1 - 2] === EMPTY && board[E1 - 3] === EMPTY &&
        !this.isAttacked(E1, BLACK) && !this.isAttacked(E1 - 1, BLACK) && !this.isAttacked(E1 - 2, BLACK)) {
        list[n++] = encodeMove(E1, E1 - 2, 0, 0, FLAG_CASTLE);
      }
    } else {
      if ((this.castling & CASTLE_BK) && board[E8 + 1] === EMPTY && board[E8 + 2] === EMPTY &&
        !this.isAttacked(E8, WHITE) && !this.isAttacked(E8 + 1, WHITE) && !this.isAttacked(E8 + 2, WHITE)) {
        list[n++] = encodeMove(E8, E8 + 2, 0, 0, FLAG_CASTLE);
      }
      if ((this.castling & CASTLE_BQ) && board[E8 - 1] === EMPTY && board[E8 - 2] === EMPTY && board[E8 - 3] === EMPTY &&
        !this.isAttacked(E8, WHITE) && !this.isAttacked(E8 - 1, WHITE) && !this.isAttacked(E8 - 2, WHITE)) {
        list[n++] = encodeMove(E8, E8 - 2, 0, 0, FLAG_CASTLE);
      }
    }
    return n;
  }

  // Captures and queen promotions only (for quiescence search).
  genCaptures(list: Int32Array, start: number): number {
    const us = this.side, them = us ^ 1;
    const board = this.board, pl = this.pieceList, pc = this.pieceCount;
    let n = start;
    const cb = us << 3;
    const push = us === WHITE ? 16 : -16;
    const promoRank = us === WHITE ? 7 : 0;
    const theirPawn = makePiece(them, PAWN);

    let p = cb | PAWN, base = p * LIST_STRIDE, cnt = pc[p];
    for (let i = 0; i < cnt; i++) {
      const from = pl[base + i];
      const to = from + push;
      const toRank = to >> 4;
      if (toRank === promoRank && board[to] === EMPTY) list[n++] = encodeMove(from, to, 0, QUEEN, 0);
      for (let k = 0; k < 2; k++) {
        const cap = k === 0 ? to - 1 : to + 1;
        if (cap & 0x88) continue;
        const target = board[cap];
        if (target !== EMPTY && (target >> 3) === them) {
          if (toRank === promoRank) list[n++] = encodeMove(from, cap, target, QUEEN, 0);
          else list[n++] = encodeMove(from, cap, target, 0, 0);
        } else if (cap === this.ep) {
          list[n++] = encodeMove(from, cap, theirPawn, 0, FLAG_EP);
        }
      }
    }
    p = cb | KNIGHT; base = p * LIST_STRIDE; cnt = pc[p];
    for (let i = 0; i < cnt; i++) {
      const from = pl[base + i];
      for (let k = 0; k < 8; k++) {
        const to = from + KNIGHT_OFFS[k];
        if (to & 0x88) continue;
        const target = board[to];
        if (target !== EMPTY && (target >> 3) === them) list[n++] = encodeMove(from, to, target, 0, 0);
      }
    }
    for (let type = BISHOP; type <= QUEEN; type++) {
      p = cb | type; base = p * LIST_STRIDE; cnt = pc[p];
      const dirs = type === BISHOP ? BISHOP_DIRS : type === ROOK ? ROOK_DIRS : KING_OFFS;
      for (let i = 0; i < cnt; i++) {
        const from = pl[base + i];
        for (let k = 0; k < dirs.length; k++) {
          const d = dirs[k];
          let to = from + d;
          while (!(to & 0x88)) {
            const target = board[to];
            if (target === EMPTY) { to += d; continue; }
            if ((target >> 3) === them) list[n++] = encodeMove(from, to, target, 0, 0);
            break;
          }
        }
      }
    }
    p = cb | KING; base = p * LIST_STRIDE;
    const ksq = pl[base];
    for (let k = 0; k < 8; k++) {
      const to = ksq + KING_OFFS[k];
      if (to & 0x88) continue;
      const target = board[to];
      if (target !== EMPTY && (target >> 3) === them) list[n++] = encodeMove(ksq, to, target, 0, 0);
    }
    return n;
  }

  // Fully legal move list (allocates; for UI and notation, not search).
  legalMoves(): number[] {
    const list = new Int32Array(256);
    const n = this.genMoves(list, 0);
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      if (this.makeMove(list[i])) { this.unmakeMove(); out.push(list[i]); }
    }
    return out;
  }

  // Validates a move (e.g. from the transposition table) against the board.
  isPseudoLegal(m: number): boolean {
    if (m === NO_MOVE) return false;
    const from = moveFrom(m), to = moveTo(m), cap = moveCaptured(m), promo = movePromo(m);
    if ((from & 0x88) || (to & 0x88)) return false;
    const p = this.board[from];
    if (p === EMPTY || (p >> 3) !== this.side) return false;
    const type = p & 7;
    const target = this.board[to];
    if (m & FLAG_EP) {
      if (type !== PAWN || to !== this.ep || target !== EMPTY) return false;
      if (cap !== makePiece(this.side ^ 1, PAWN)) return false;
      const push = this.side === WHITE ? 16 : -16;
      return to === from + push - 1 || to === from + push + 1;
    }
    if (target !== cap) return false;
    if (target !== EMPTY && (target >> 3) === this.side) return false;
    if (m & FLAG_CASTLE) {
      if (type !== KING) return false;
      const home = this.side === WHITE ? E1 : E8;
      if (from !== home || cap !== 0) return false;
      const them = this.side ^ 1;
      if (to === home + 2) {
        const right = this.side === WHITE ? CASTLE_WK : CASTLE_BK;
        return (this.castling & right) !== 0 && this.board[home + 1] === EMPTY && this.board[home + 2] === EMPTY &&
          !this.isAttacked(home, them) && !this.isAttacked(home + 1, them) && !this.isAttacked(home + 2, them);
      }
      if (to === home - 2) {
        const right = this.side === WHITE ? CASTLE_WQ : CASTLE_BQ;
        return (this.castling & right) !== 0 && this.board[home - 1] === EMPTY && this.board[home - 2] === EMPTY && this.board[home - 3] === EMPTY &&
          !this.isAttacked(home, them) && !this.isAttacked(home - 1, them) && !this.isAttacked(home - 2, them);
      }
      return false;
    }
    if (type === PAWN) {
      const push = this.side === WHITE ? 16 : -16;
      const promoRank = this.side === WHITE ? 7 : 0;
      if (((to >> 4) === promoRank) !== (promo !== 0)) return false;
      if (promo && (promo < KNIGHT || promo > QUEEN)) return false;
      if (m & FLAG_DOUBLE) {
        const startRank = this.side === WHITE ? 1 : 6;
        return (from >> 4) === startRank && to === from + 2 * push && target === EMPTY && this.board[from + push] === EMPTY && cap === 0;
      }
      if (to === from + push) return target === EMPTY;
      if (to === from + push - 1 || to === from + push + 1) return target !== EMPTY;
      return false;
    }
    if (promo || (m & FLAG_DOUBLE)) return false;
    const d = to - from + 128;
    if (type === KNIGHT) return (ATTACKS[d] & ATK_KNIGHT) !== 0;
    if (type === KING) return (ATTACKS[d] & ATK_KING) !== 0;
    if (!(ATTACKS[d] & PIECE_ATK[type])) return false;
    const step = DELTAS[d];
    for (let s = from + step; s !== to; s += step) if (this.board[s] !== EMPTY) return false;
    return true;
  }

  // ---- Make / unmake -------------------------------------------------------
  private pushHistory(m: number): void {
    const h = this.hply++;
    this.hMove[h] = m; this.hCastle[h] = this.castling; this.hEp[h] = this.ep; this.hHalf[h] = this.halfmove;
    this.hHashLo[h] = this.hashLo; this.hHashHi[h] = this.hashHi; this.hPawnLo[h] = this.pawnLo; this.hPawnHi[h] = this.pawnHi;
  }

  // Returns false (and leaves the position untouched) if the move is illegal.
  makeMove(m: number): boolean {
    this.pushHistory(m);
    const us = this.side, them = us ^ 1;
    const from = moveFrom(m), to = moveTo(m), cap = moveCaptured(m), promo = movePromo(m);
    const piece = this.board[from];

    if (this.ep !== NO_SQ) {
      this.hashLo = (this.hashLo ^ EP_KEY_LO[this.ep & 7]) >>> 0; this.hashHi = (this.hashHi ^ EP_KEY_HI[this.ep & 7]) >>> 0;
      this.ep = NO_SQ;
    }
    const newCastle = this.castling & CASTLE_MASK[from] & CASTLE_MASK[to];
    if (newCastle !== this.castling) {
      this.hashLo = (this.hashLo ^ CASTLE_KEY_LO[this.castling] ^ CASTLE_KEY_LO[newCastle]) >>> 0;
      this.hashHi = (this.hashHi ^ CASTLE_KEY_HI[this.castling] ^ CASTLE_KEY_HI[newCastle]) >>> 0;
      this.castling = newCastle;
    }
    this.halfmove++;

    if (cap !== 0) {
      this.halfmove = 0;
      if (m & FLAG_EP) this.removePiece(us === WHITE ? to - 16 : to + 16);
      else this.removePiece(to);
    }
    this.movePiece(from, to);

    if ((piece & 7) === PAWN) {
      this.halfmove = 0;
      if (promo !== 0) {
        this.removePiece(to);
        this.addPiece(to, makePiece(us, promo));
      } else if (m & FLAG_DOUBLE) {
        const epSq = us === WHITE ? from + 16 : from - 16;
        const theirPawn = makePiece(them, PAWN);
        const a = to - 1, b = to + 1;
        if ((!(a & 0x88) && this.board[a] === theirPawn) || (!(b & 0x88) && this.board[b] === theirPawn)) {
          this.ep = epSq;
          this.hashLo = (this.hashLo ^ EP_KEY_LO[epSq & 7]) >>> 0; this.hashHi = (this.hashHi ^ EP_KEY_HI[epSq & 7]) >>> 0;
        }
      }
    } else if (m & FLAG_CASTLE) {
      if (to === from + 2) this.movePiece(from + 3, from + 1);
      else this.movePiece(from - 4, from - 1);
    }

    this.side = them;
    this.hashLo = (this.hashLo ^ SIDE_KEY_LO) >>> 0; this.hashHi = (this.hashHi ^ SIDE_KEY_HI) >>> 0;
    if (us === BLACK) this.fullmove++;

    if (this.isAttacked(this.kingSq(us), them)) {
      this.unmakeMove();
      return false;
    }
    return true;
  }

  unmakeMove(): void {
    const h = --this.hply;
    const m = this.hMove[h];
    this.side ^= 1;
    const us = this.side;
    if (us === BLACK) this.fullmove--;
    const from = moveFrom(m), to = moveTo(m), cap = moveCaptured(m), promo = movePromo(m);

    if (m & FLAG_CASTLE) {
      if (to === from + 2) this.movePiece(from + 1, from + 3);
      else this.movePiece(from - 1, from - 4);
    }
    if (promo !== 0) {
      this.removePiece(to);
      this.addPiece(to, makePiece(us, PAWN));
    }
    this.movePiece(to, from);
    if (cap !== 0) {
      if (m & FLAG_EP) this.addPiece(us === WHITE ? to - 16 : to + 16, cap);
      else this.addPiece(to, cap);
    }
    this.castling = this.hCastle[h]; this.ep = this.hEp[h]; this.halfmove = this.hHalf[h];
    this.hashLo = this.hHashLo[h]; this.hashHi = this.hHashHi[h]; this.pawnLo = this.hPawnLo[h]; this.pawnHi = this.hPawnHi[h];
  }

  makeNull(): void {
    this.pushHistory(NO_MOVE);
    if (this.ep !== NO_SQ) {
      this.hashLo = (this.hashLo ^ EP_KEY_LO[this.ep & 7]) >>> 0; this.hashHi = (this.hashHi ^ EP_KEY_HI[this.ep & 7]) >>> 0;
      this.ep = NO_SQ;
    }
    this.side ^= 1;
    this.hashLo = (this.hashLo ^ SIDE_KEY_LO) >>> 0; this.hashHi = (this.hashHi ^ SIDE_KEY_HI) >>> 0;
    this.halfmove++;
  }

  unmakeNull(): void {
    const h = --this.hply;
    this.side ^= 1;
    this.castling = this.hCastle[h]; this.ep = this.hEp[h]; this.halfmove = this.hHalf[h];
    this.hashLo = this.hHashLo[h]; this.hashHi = this.hHashHi[h];
  }

  lastMove(): number {
    return this.hply > 0 ? this.hMove[this.hply - 1] : NO_MOVE;
  }

  // Has the current position occurred before in the history (within the 50-move window)?
  // `minCount` = 1 detects a single prior occurrence (two-fold), 2 detects three-fold.
  repetitionCount(): number {
    let count = 0;
    const limit = Math.max(0, this.hply - this.halfmove);
    for (let i = this.hply - 2; i >= limit; i -= 2) {
      if (this.hHashLo[i] === this.hashLo && this.hHashHi[i] === this.hashHi) count++;
    }
    return count;
  }

  // Non-pawn material of a side (used for null-move safety and endgame checks).
  nonPawnMaterial(color: number): number {
    const cb = color << 3;
    return this.pieceCount[cb | KNIGHT] + this.pieceCount[cb | BISHOP] + this.pieceCount[cb | ROOK] * 2 + this.pieceCount[cb | QUEEN] * 4;
  }

  insufficientMaterial(): boolean {
    const pc = this.pieceCount;
    if (pc[WP] || pc[BP] || pc[makePiece(WHITE, ROOK)] || pc[makePiece(BLACK, ROOK)] ||
      pc[makePiece(WHITE, QUEEN)] || pc[makePiece(BLACK, QUEEN)]) return false;
    const wn = pc[makePiece(WHITE, KNIGHT)], bn = pc[makePiece(BLACK, KNIGHT)];
    const wb = pc[makePiece(WHITE, BISHOP)], bb = pc[makePiece(BLACK, BISHOP)];
    const minors = wn + bn + wb + bb;
    if (minors <= 1) return true;
    if (wn === 0 && bn === 0) {
      // Only bishops: insufficient if all on the same square color.
      let color = -1;
      for (const p of [makePiece(WHITE, BISHOP), makePiece(BLACK, BISHOP)]) {
        for (let i = 0; i < pc[p]; i++) {
          const sq = this.pieceList[p * LIST_STRIDE + i];
          const c = (sqFile(sq) + sqRank(sq)) & 1;
          if (color === -1) color = c; else if (color !== c) return false;
        }
      }
      return true;
    }
    return false;
  }

  // ---- Perft ---------------------------------------------------------------
  perft(depth: number): number {
    const lists: Int32Array[] = [];
    for (let i = 0; i <= depth; i++) lists.push(new Int32Array(256));
    const rec = (d: number): number => {
      const list = lists[d];
      const n = this.genMoves(list, 0);
      if (d === 1) {
        let count = 0;
        for (let i = 0; i < n; i++) if (this.makeMove(list[i])) { count++; this.unmakeMove(); }
        return count;
      }
      let nodes = 0;
      for (let i = 0; i < n; i++) {
        if (!this.makeMove(list[i])) continue;
        nodes += rec(d - 1);
        this.unmakeMove();
      }
      return nodes;
    };
    if (depth <= 0) return 1;
    return rec(depth);
  }

  // Human-readable board (debugging).
  toString(): string {
    let s = '';
    for (let rank = 7; rank >= 0; rank--) {
      s += (rank + 1) + ' ';
      for (let file = 0; file < 8; file++) s += PIECE_CHARS[this.board[(rank << 4) | file]] + ' ';
      s += '\n';
    }
    return s + '  a b c d e f g h\n' + this.fen();
  }
}

export { pieceType, pieceColor };
