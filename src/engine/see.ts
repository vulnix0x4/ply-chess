// Static Exchange Evaluation on the 0x88 board with x-ray support.
import { Position, KNIGHT_OFFS, KING_OFFS, DELTAS, ATTACKS, ATK_BISHOP, ATK_ROOK } from './board';
import { WHITE, EMPTY, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, makePiece, moveFrom, moveTo, moveCaptured, movePromo, moveIsEp, pieceType } from './types';
import { PIECE_VALUE } from './eval';

const removed = new Uint8Array(128);
const gain = new Int32Array(40);

// Finds the least valuable piece of `side` attacking `sq`, ignoring removed squares.
// Returns the square or -1. Sets lvaType.
let lvaType = 0;
function leastValuableAttacker(pos: Position, sq: number, side: number): number {
  const board = pos.board;
  // Pawns
  const pawn = makePiece(side, PAWN);
  const pa = side === WHITE ? sq - 15 : sq + 15, pb = side === WHITE ? sq - 17 : sq + 17;
  if (!(pa & 0x88) && !removed[pa] && board[pa] === pawn) { lvaType = PAWN; return pa; }
  if (!(pb & 0x88) && !removed[pb] && board[pb] === pawn) { lvaType = PAWN; return pb; }
  // Knights
  const knight = makePiece(side, KNIGHT);
  for (let k = 0; k < 8; k++) {
    const s = sq + KNIGHT_OFFS[k];
    if (!(s & 0x88) && !removed[s] && board[s] === knight) { lvaType = KNIGHT; return s; }
  }
  // Sliders: walk each of the 8 directions from sq until a non-removed piece.
  let bestSq = -1, bestVal = 1 << 30;
  const cb = side << 3;
  for (let k = 0; k < 8; k++) {
    const d = KING_OFFS[k];
    let s = sq + d;
    while (!(s & 0x88)) {
      if (!removed[s] && board[s] !== EMPTY) {
        const p = board[s];
        if ((p >> 3) === side) {
          const t = p & 7;
          const diag = (d === -17 || d === -15 || d === 15 || d === 17);
          if ((t === QUEEN) || (t === BISHOP && diag) || (t === ROOK && !diag)) {
            if (PIECE_VALUE[t] < bestVal) { bestVal = PIECE_VALUE[t]; bestSq = s; lvaType = t; }
          }
        }
        break;
      }
      s += d;
    }
  }
  if (bestSq >= 0) { lvaType = pieceType(board[bestSq]); return bestSq; }
  // King
  const ksq = pos.kingSq(side);
  if (!removed[ksq] && (ATTACKS[sq - ksq + 128] & 32)) { lvaType = KING; return ksq; }
  return -1;
}

export function see(pos: Position, m: number): number {
  const from = moveFrom(m), to = moveTo(m);
  const attacker = pos.board[from];
  let attackerVal = PIECE_VALUE[attacker & 7];
  const captured = moveCaptured(m);
  const promo = movePromo(m);
  removed.fill(0);
  let side = pos.side ^ 1;
  let d = 0;
  gain[0] = PIECE_VALUE[captured & 7];
  if (promo) { gain[0] += PIECE_VALUE[promo] - PIECE_VALUE[PAWN]; attackerVal = PIECE_VALUE[promo]; }
  removed[from] = 1;
  if (moveIsEp(m)) removed[pos.side === WHITE ? to - 16 : to + 16] = 1;
  // Pretend the moving piece now sits on `to`; it is captured in the next step.
  let sq = leastValuableAttacker(pos, to, side);
  while (sq >= 0) {
    if (lvaType === KING) {
      // The king may only capture if nothing can recapture afterwards.
      if (leastValuableAttacker(pos, to, side ^ 1) >= 0) break;
      lvaType = KING;
    }
    d++;
    gain[d] = attackerVal - gain[d - 1];
    if (Math.max(-gain[d - 1], gain[d]) < 0) break; // neither side can improve
    attackerVal = PIECE_VALUE[lvaType];
    removed[sq] = 1;
    side ^= 1;
    if (d >= 36) break;
    sq = leastValuableAttacker(pos, to, side);
  }
  while (--d > 0) gain[d - 1] = -Math.max(-gain[d - 1], gain[d]);
  return gain[0];
}

void DELTAS; void ATK_BISHOP; void ATK_ROOK;
