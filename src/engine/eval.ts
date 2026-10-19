// Static evaluation: tapered material/PST (incremental) plus pawn structure
// (cached by pawn hash), mobility, king safety, passed pawns, bishop pair,
// rook files and drawish-endgame scaling. Returns centipawns from the side to
// move's perspective.
import { Position, BISHOP_DIRS, ROOK_DIRS, KING_OFFS, KNIGHT_OFFS } from './board';
import {
  WHITE, BLACK, EMPTY, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, makePiece, sqFile, sqRank, to64,
} from './types';
import { TOTAL_PHASE } from './pst';

// ---- Tunable terms (mg, eg) -------------------------------------------------
const PASSED_MG = [0, 5, 10, 18, 35, 60, 95, 0];
const PASSED_EG = [0, 12, 20, 35, 60, 100, 150, 0];
const ISOLATED_MG = -12, ISOLATED_EG = -16;
const DOUBLED_MG = -8, DOUBLED_EG = -18;
const BACKWARD_MG = -6, BACKWARD_EG = -10;
const CONNECTED_MG = 6, CONNECTED_EG = 4;
const BISHOP_PAIR_MG = 28, BISHOP_PAIR_EG = 52;
const ROOK_OPEN_MG = 26, ROOK_OPEN_EG = 8;
const ROOK_SEMI_MG = 12, ROOK_SEMI_EG = 6;
const ROOK_SEVENTH_MG = 10, ROOK_SEVENTH_EG = 22;
const TEMPO = 12;
const KNIGHT_MOB_MG = [-30, -18, -8, 0, 5, 10, 14, 17, 20];
const KNIGHT_MOB_EG = [-35, -20, -8, 0, 6, 12, 16, 19, 21];
const BISHOP_MOB_MG = [-30, -20, -10, -4, 2, 7, 11, 15, 18, 21, 23, 25, 27, 28];
const BISHOP_MOB_EG = [-40, -26, -14, -6, 2, 8, 13, 17, 20, 23, 25, 27, 29, 30];
const ROOK_MOB_MG = [-30, -20, -12, -8, -4, 0, 3, 6, 9, 12, 14, 16, 18, 19, 20];
const ROOK_MOB_EG = [-50, -30, -16, -6, 2, 9, 15, 20, 25, 29, 32, 35, 37, 39, 40];
const QUEEN_MOB_MG = new Array(28).fill(0).map((_, i) => Math.min(20, -20 + i * 3));
const QUEEN_MOB_EG = new Array(28).fill(0).map((_, i) => Math.min(30, -30 + i * 4));
// King attack units -> penalty (mg)
const KING_DANGER = new Int16Array(100);
for (let i = 0; i < 100; i++) KING_DANGER[i] = Math.min(500, Math.floor((i * i) / 2.2));
const ATTACK_WEIGHT = [0, 0, 2, 2, 3, 5, 0, 0];
const SHIELD_BONUS = [0, 0, 0, 0, 0, 0, 0, 0];
const KING_OPEN_FILE_MG = -22, KING_SEMI_OPEN_FILE_MG = -12;

// ---- Pawn hash --------------------------------------------------------------
const PAWN_HASH_BITS = 14;
const PAWN_HASH_SIZE = 1 << PAWN_HASH_BITS;
const phKeyLo = new Uint32Array(PAWN_HASH_SIZE);
const phKeyHi = new Uint32Array(PAWN_HASH_SIZE);
const phMg = new Int16Array(PAWN_HASH_SIZE);
const phEg = new Int16Array(PAWN_HASH_SIZE);
// Passed pawn squares (64-bit sets as two 32-bit halves) per side.
const phPassedLo = new Uint32Array(PAWN_HASH_SIZE * 2);
const phPassedHi = new Uint32Array(PAWN_HASH_SIZE * 2);

// Scratch
const pawnAttack = [new Uint8Array(128), new Uint8Array(128)];
const kingZone = [new Uint8Array(128), new Uint8Array(128)];
const fileMinRank = [new Int8Array(8), new Int8Array(8)]; // lowest rank of a pawn on file (white) / highest (black) etc.
const fileMaxRank = [new Int8Array(8), new Int8Array(8)];
const fileCount = [new Int8Array(8), new Int8Array(8)];
let passedLo = [0, 0];
let passedHi = [0, 0];

function kingDistance(a: number, b: number): number {
  return Math.max(Math.abs(sqFile(a) - sqFile(b)), Math.abs(sqRank(a) - sqRank(b)));
}

function pawnStructure(pos: Position): { mg: number; eg: number } {
  const idx = pos.pawnLo & (PAWN_HASH_SIZE - 1);
  if (phKeyLo[idx] === pos.pawnLo && phKeyHi[idx] === pos.pawnHi) {
    passedLo[0] = phPassedLo[idx * 2]; passedLo[1] = phPassedLo[idx * 2 + 1];
    passedHi[0] = phPassedHi[idx * 2]; passedHi[1] = phPassedHi[idx * 2 + 1];
    return { mg: phMg[idx], eg: phEg[idx] };
  }
  let mg = 0, eg = 0;
  for (let c = 0; c < 2; c++) {
    fileCount[c].fill(0); fileMinRank[c].fill(8); fileMaxRank[c].fill(-1);
    const p = makePiece(c, PAWN);
    const n = pos.pieceCount[p];
    for (let i = 0; i < n; i++) {
      const sq = pos.pieceSq(p, i);
      const f = sqFile(sq), r = sqRank(sq);
      fileCount[c][f]++;
      if (r < fileMinRank[c][f]) fileMinRank[c][f] = r;
      if (r > fileMaxRank[c][f]) fileMaxRank[c][f] = r;
    }
  }
  for (let c = 0; c < 2; c++) {
    const sign = c === WHITE ? 1 : -1;
    const them = c ^ 1;
    let pLo = 0, pHi = 0;
    const p = makePiece(c, PAWN);
    const n = pos.pieceCount[p];
    for (let i = 0; i < n; i++) {
      const sq = pos.pieceSq(p, i);
      const f = sqFile(sq), r = sqRank(sq);
      const relRank = c === WHITE ? r : 7 - r;
      // Passed: no enemy pawn ahead on this or adjacent files.
      let passed = true;
      for (let df = -1; df <= 1 && passed; df++) {
        const ff = f + df;
        if (ff < 0 || ff > 7) continue;
        if (c === WHITE ? fileMaxRank[them][ff] > r : fileMinRank[them][ff] < r) passed = false;
      }
      // Doubled pawns behind another own pawn on the same file are not passed.
      if (passed && (c === WHITE ? fileMaxRank[c][f] > r : fileMinRank[c][f] < r)) passed = false;
      if (passed) {
        mg += sign * PASSED_MG[relRank]; eg += sign * PASSED_EG[relRank];
        const b = to64(sq);
        if (b < 32) pLo |= (1 << b) >>> 0; else pHi |= (1 << (b - 32)) >>> 0;
      }
      const leftCount = f > 0 ? fileCount[c][f - 1] : 0;
      const rightCount = f < 7 ? fileCount[c][f + 1] : 0;
      if (leftCount + rightCount === 0) { mg += sign * ISOLATED_MG; eg += sign * ISOLATED_EG; }
      else {
        // Connected / phalanx: an own pawn on an adjacent file on the same or previous rank.
        const behind = c === WHITE ? r - 1 : r + 1;
        let connected = false;
        for (let df = -1; df <= 1; df += 2) {
          const ff = f + df;
          if (ff < 0 || ff > 7) continue;
          const a = pos.board[(r << 4) | ff], bsq = (behind << 4) | ff;
          if (a === p || (behind >= 0 && behind <= 7 && pos.board[bsq] === p)) connected = true;
        }
        if (connected) { mg += sign * (CONNECTED_MG + relRank * 2); eg += sign * (CONNECTED_EG + relRank); }
        else {
          // Backward: no supporting pawn can advance to protect it and the stop square is attacked by an enemy pawn.
          const stop = sq + (c === WHITE ? 16 : -16);
          const stopAttacked = !(stop & 0x88) && pawnAttackedBy(pos, stop, them);
          let support = false;
          for (let df = -1; df <= 1; df += 2) {
            const ff = f + df;
            if (ff < 0 || ff > 7) continue;
            if (c === WHITE ? (fileCount[c][ff] && fileMinRank[c][ff] <= r) : (fileCount[c][ff] && fileMaxRank[c][ff] >= r)) support = true;
          }
          if (!support && stopAttacked) { mg += sign * BACKWARD_MG; eg += sign * BACKWARD_EG; }
        }
      }
      if (fileCount[c][f] > 1 && (c === WHITE ? fileMinRank[c][f] === r : fileMaxRank[c][f] === r)) {
        // Charge the doubled penalty once per extra pawn on the file (on the rearmost pawn).
        mg += sign * DOUBLED_MG * (fileCount[c][f] - 1); eg += sign * DOUBLED_EG * (fileCount[c][f] - 1);
      }
    }
    passedLo[c] = pLo; passedHi[c] = pHi;
  }
  phKeyLo[idx] = pos.pawnLo; phKeyHi[idx] = pos.pawnHi; phMg[idx] = mg; phEg[idx] = eg;
  phPassedLo[idx * 2] = passedLo[0]; phPassedLo[idx * 2 + 1] = passedLo[1];
  phPassedHi[idx * 2] = passedHi[0]; phPassedHi[idx * 2 + 1] = passedHi[1];
  return { mg, eg };
}

function pawnAttackedBy(pos: Position, sq: number, by: number): boolean {
  const p = makePiece(by, PAWN);
  const a = by === WHITE ? sq - 15 : sq + 15, b = by === WHITE ? sq - 17 : sq + 17;
  return (!(a & 0x88) && pos.board[a] === p) || (!(b & 0x88) && pos.board[b] === p);
}

function isPassed(c: number, sq: number): boolean {
  const b = to64(sq);
  return b < 32 ? (passedLo[c] & (1 << b)) !== 0 : (passedHi[c] & (1 << (b - 32))) !== 0;
}

export function evaluate(pos: Position): number {
  const us = pos.side, them = us ^ 1;
  let mg = pos.mg[WHITE] - pos.mg[BLACK];
  let eg = pos.eg[WHITE] - pos.eg[BLACK];

  const ps = pawnStructure(pos);
  mg += ps.mg; eg += ps.eg;

  // Pawn attack maps and king zones.
  for (let c = 0; c < 2; c++) {
    pawnAttack[c].fill(0); kingZone[c].fill(0);
    const p = makePiece(c, PAWN);
    const n = pos.pieceCount[p];
    const d1 = c === WHITE ? 15 : -15, d2 = c === WHITE ? 17 : -17;
    for (let i = 0; i < n; i++) {
      const sq = pos.pieceSq(p, i);
      const a = sq + d1, b = sq + d2;
      if (!(a & 0x88)) pawnAttack[c][a] = 1;
      if (!(b & 0x88)) pawnAttack[c][b] = 1;
    }
    const ksq = pos.kingSq(c);
    kingZone[c][ksq] = 1;
    for (let k = 0; k < 8; k++) {
      const s = ksq + KING_OFFS[k];
      if (!(s & 0x88)) kingZone[c][s] = 1;
    }
    // Extend the zone one rank toward the enemy.
    const fwd = c === WHITE ? 16 : -16;
    for (let df = -1; df <= 1; df++) {
      const s = ksq + fwd * 2 + df;
      if (!(s & 0x88)) kingZone[c][s] = 1;
    }
  }

  const attackUnits = [0, 0]; // units against each side's king
  const attackerCount = [0, 0];

  for (let c = 0; c < 2; c++) {
    const sign = c === WHITE ? 1 : -1;
    const opp = c ^ 1;
    const oppZone = kingZone[opp];
    const oppPawnAtk = pawnAttack[opp];
    const cb = c << 3;

    // Knights
    let p = cb | KNIGHT, n = pos.pieceCount[p];
    for (let i = 0; i < n; i++) {
      const from = pos.pieceSq(p, i);
      let mob = 0, zone = 0;
      for (let k = 0; k < 8; k++) {
        const to = from + KNIGHT_OFFS[k];
        if (to & 0x88) continue;
        const t = pos.board[to];
        if (oppZone[to]) zone++;
        if ((t !== EMPTY && (t >> 3) === c) || oppPawnAtk[to]) continue;
        mob++;
      }
      mg += sign * KNIGHT_MOB_MG[mob]; eg += sign * KNIGHT_MOB_EG[mob];
      if (zone) { attackUnits[opp] += ATTACK_WEIGHT[KNIGHT] * zone; attackerCount[opp]++; }
      // Outpost: knight on relative rank 4-6 protected by a pawn and not attackable by enemy pawns.
      const relRank = c === WHITE ? sqRank(from) : 7 - sqRank(from);
      if (relRank >= 3 && relRank <= 5 && pawnAttack[c][from] && !oppPawnAtk[from]) {
        // Not attackable later: no enemy pawns on adjacent files ahead.
        mg += sign * 18; eg += sign * 10;
      }
    }

    // Bishops
    p = cb | BISHOP; n = pos.pieceCount[p];
    if (n >= 2) { mg += sign * BISHOP_PAIR_MG; eg += sign * BISHOP_PAIR_EG; }
    for (let i = 0; i < n; i++) {
      const from = pos.pieceSq(p, i);
      let mob = 0, zone = 0;
      for (let k = 0; k < 4; k++) {
        const d = BISHOP_DIRS[k];
        let to = from + d;
        while (!(to & 0x88)) {
          const t = pos.board[to];
          if (oppZone[to]) zone++;
          if (t !== EMPTY && (t >> 3) === c) break;
          if (!oppPawnAtk[to]) mob++;
          if (t !== EMPTY) break;
          to += d;
        }
      }
      mg += sign * BISHOP_MOB_MG[Math.min(mob, 13)]; eg += sign * BISHOP_MOB_EG[Math.min(mob, 13)];
      if (zone) { attackUnits[opp] += ATTACK_WEIGHT[BISHOP] * zone; attackerCount[opp]++; }
    }

    // Rooks
    p = cb | ROOK; n = pos.pieceCount[p];
    for (let i = 0; i < n; i++) {
      const from = pos.pieceSq(p, i);
      let mob = 0, zone = 0;
      for (let k = 0; k < 4; k++) {
        const d = ROOK_DIRS[k];
        let to = from + d;
        while (!(to & 0x88)) {
          const t = pos.board[to];
          if (oppZone[to]) zone++;
          if (t !== EMPTY && (t >> 3) === c) break;
          if (!oppPawnAtk[to]) mob++;
          if (t !== EMPTY) break;
          to += d;
        }
      }
      mg += sign * ROOK_MOB_MG[Math.min(mob, 14)]; eg += sign * ROOK_MOB_EG[Math.min(mob, 14)];
      if (zone) { attackUnits[opp] += ATTACK_WEIGHT[ROOK] * zone; attackerCount[opp]++; }
      const f = sqFile(from);
      const ownPawns = fileCountFor(pos, c, f), oppPawns = fileCountFor(pos, opp, f);
      if (ownPawns === 0) {
        if (oppPawns === 0) { mg += sign * ROOK_OPEN_MG; eg += sign * ROOK_OPEN_EG; }
        else { mg += sign * ROOK_SEMI_MG; eg += sign * ROOK_SEMI_EG; }
      }
      const relRank = c === WHITE ? sqRank(from) : 7 - sqRank(from);
      const oppKingRank = c === WHITE ? sqRank(pos.kingSq(opp)) : 7 - sqRank(pos.kingSq(opp));
      if (relRank === 6 && oppKingRank >= 6) { mg += sign * ROOK_SEVENTH_MG; eg += sign * ROOK_SEVENTH_EG; }
    }

    // Queens
    p = cb | QUEEN; n = pos.pieceCount[p];
    for (let i = 0; i < n; i++) {
      const from = pos.pieceSq(p, i);
      let mob = 0, zone = 0;
      for (let k = 0; k < 8; k++) {
        const d = KING_OFFS[k];
        let to = from + d;
        while (!(to & 0x88)) {
          const t = pos.board[to];
          if (oppZone[to]) zone++;
          if (t !== EMPTY && (t >> 3) === c) break;
          if (!oppPawnAtk[to]) mob++;
          if (t !== EMPTY) break;
          to += d;
        }
      }
      mg += sign * QUEEN_MOB_MG[Math.min(mob, 27)]; eg += sign * QUEEN_MOB_EG[Math.min(mob, 27)];
      if (zone) { attackUnits[opp] += ATTACK_WEIGHT[QUEEN] * zone; attackerCount[opp]++; }
    }

    // Passed pawn king proximity and free path (endgame).
    p = cb | PAWN; n = pos.pieceCount[p];
    const ownKing = pos.kingSq(c), oppKing = pos.kingSq(opp);
    for (let i = 0; i < n; i++) {
      const sq = pos.pieceSq(p, i);
      if (!isPassed(c, sq)) continue;
      const relRank = c === WHITE ? sqRank(sq) : 7 - sqRank(sq);
      const stop = sq + (c === WHITE ? 16 : -16);
      if (stop & 0x88) continue;
      const w = relRank * relRank;
      eg += sign * (kingDistance(oppKing, stop) * 2 - kingDistance(ownKing, stop)) * Math.max(1, w) / 4;
      if (pos.board[stop] === EMPTY) eg += sign * w;
      // Unstoppable-ish: enemy has no pieces and king is outside the square.
      if (pos.nonPawnMaterial(opp) === 0) {
        const promoRank = c === WHITE ? 7 : 0;
        const dist = Math.abs(promoRank - sqRank(sq));
        const kingDist = kingDistance(oppKing, (promoRank << 4) | sqFile(sq)) - (pos.side === opp ? 1 : 0);
        if (dist < kingDist) eg += sign * 200;
      }
    }

    // King shelter (middlegame).
    const ksq = pos.kingSq(c);
    const kf = sqFile(ksq), kr = sqRank(ksq);
    const relKingRank = c === WHITE ? kr : 7 - kr;
    if (relKingRank <= 1) {
      let shelter = 0;
      for (let df = -1; df <= 1; df++) {
        const ff = kf + df;
        if (ff < 0 || ff > 7) continue;
        const r1 = kr + (c === WHITE ? 1 : -1), r2 = kr + (c === WHITE ? 2 : -2);
        const own = makePiece(c, PAWN);
        if (r1 >= 0 && r1 <= 7 && pos.board[(r1 << 4) | ff] === own) shelter += 12;
        else if (r2 >= 0 && r2 <= 7 && pos.board[(r2 << 4) | ff] === own) shelter += 6;
        const ownPawns = fileCountFor(pos, c, ff);
        if (ownPawns === 0) shelter += fileCountFor(pos, opp, ff) === 0 ? KING_OPEN_FILE_MG : KING_SEMI_OPEN_FILE_MG;
      }
      mg += sign * shelter;
    }
    void SHIELD_BONUS;
  }

  // King danger: scaled down when the attacker has no queen.
  for (let c = 0; c < 2; c++) {
    const attacker = c ^ 1;
    let units = attackUnits[c];
    if (attackerCount[c] < 2) units = units >> 1;
    if (pos.pieceCount[makePiece(attacker, QUEEN)] === 0) units = units >> 1;
    const danger = KING_DANGER[Math.min(99, units)];
    mg += c === WHITE ? -danger : danger;
  }

  const phase = Math.min(TOTAL_PHASE, pos.phase);
  let score = Math.round((mg * phase + eg * (TOTAL_PHASE - phase)) / TOTAL_PHASE);

  // Drawish endgame scaling: side ahead has no pawns and at most a minor piece's advantage.
  const strong = score > 0 ? WHITE : BLACK;
  if (pos.pieceCount[makePiece(strong, PAWN)] === 0) {
    const diff = pos.nonPawnMaterial(strong) - pos.nonPawnMaterial(strong ^ 1);
    if (diff <= 1) score = (score / 8) | 0;
    else if (diff === 2 && pos.nonPawnMaterial(strong) <= 2) score = (score / 4) | 0; // e.g. two knights
  }
  // Opposite-colored bishops with no other pieces: drawish.
  if (pos.nonPawnMaterial(WHITE) === 1 && pos.nonPawnMaterial(BLACK) === 1 &&
    pos.pieceCount[makePiece(WHITE, BISHOP)] === 1 && pos.pieceCount[makePiece(BLACK, BISHOP)] === 1) {
    const wb = pos.pieceSq(makePiece(WHITE, BISHOP), 0), bb = pos.pieceSq(makePiece(BLACK, BISHOP), 0);
    if (((sqFile(wb) + sqRank(wb)) & 1) !== ((sqFile(bb) + sqRank(bb)) & 1)) score = (score / 2) | 0;
  }

  score = us === WHITE ? score : -score;
  return score + TEMPO;
}

function fileCountFor(pos: Position, c: number, f: number): number {
  // Small helper reading pawn counts per file. Cheap enough: at most 8 pawns.
  const p = makePiece(c, PAWN);
  const n = pos.pieceCount[p];
  let cnt = 0;
  for (let i = 0; i < n; i++) if (sqFile(pos.pieceSq(p, i)) === f) cnt++;
  return cnt;
}

// Simple material-only estimate used by SEE and pruning margins.
export const PIECE_VALUE = [0, 100, 320, 330, 500, 950, 20000, 0];
export { KING };
