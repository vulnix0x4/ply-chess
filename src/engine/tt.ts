// Transposition table with two-slot buckets, stored in typed arrays.
import { MATE_IN_MAX, NO_MOVE } from './types';

export const TT_NONE = 0, TT_EXACT = 1, TT_ALPHA = 2, TT_BETA = 3; // ALPHA = upper bound, BETA = lower bound

export class TranspositionTable {
  size = 0;
  mask = 0;
  keyLo!: Uint32Array;
  keyHi!: Uint32Array;
  move!: Int32Array;
  score!: Int16Array;
  evalv!: Int16Array;
  depth!: Uint8Array;
  flagAge!: Uint8Array; // flag in low 2 bits, age in the upper 6
  age = 0;
  used = 0;

  // Probe results (avoid allocation)
  hit = false;
  hitMove = NO_MOVE;
  hitScore = 0;
  hitEval = 0;
  hitDepth = 0;
  hitFlag = TT_NONE;

  constructor(megabytes = 16) {
    this.resize(megabytes);
  }

  resize(megabytes: number): void {
    const bytesPerEntry = 4 + 4 + 4 + 2 + 2 + 1 + 1;
    let n = 1024;
    while (n * 2 * bytesPerEntry <= megabytes * 1024 * 1024) n *= 2;
    this.size = n;
    this.mask = n - 1;
    this.keyLo = new Uint32Array(n); this.keyHi = new Uint32Array(n); this.move = new Int32Array(n);
    this.score = new Int16Array(n); this.evalv = new Int16Array(n); this.depth = new Uint8Array(n); this.flagAge = new Uint8Array(n);
    this.age = 0; this.used = 0;
  }

  clear(): void {
    this.keyLo.fill(0); this.keyHi.fill(0); this.move.fill(0); this.score.fill(0); this.evalv.fill(0); this.depth.fill(0); this.flagAge.fill(0);
    this.age = 0; this.used = 0;
  }

  newSearch(): void {
    this.age = (this.age + 1) & 63;
  }

  // Permille of entries written during the current age (sampled).
  hashfull(): number {
    let n = 0;
    const samples = Math.min(1000, this.size);
    for (let i = 0; i < samples; i++) if (this.flagAge[i] !== 0 && (this.flagAge[i] >> 2) === this.age) n++;
    return Math.round((n * 1000) / samples);
  }

  probe(lo: number, hi: number, ply: number): boolean {
    const i0 = lo & this.mask;
    const i1 = i0 ^ 1;
    let i = -1;
    if (this.keyLo[i0] === lo && this.keyHi[i0] === hi && this.flagAge[i0] !== 0) i = i0;
    else if (this.keyLo[i1] === lo && this.keyHi[i1] === hi && this.flagAge[i1] !== 0) i = i1;
    if (i < 0) { this.hit = false; this.hitMove = NO_MOVE; return false; }
    this.hit = true;
    this.hitMove = this.move[i];
    let s = this.score[i];
    if (s >= MATE_IN_MAX) s -= ply; else if (s <= -MATE_IN_MAX) s += ply;
    this.hitScore = s;
    this.hitEval = this.evalv[i];
    this.hitDepth = this.depth[i];
    this.hitFlag = this.flagAge[i] & 3;
    // Refresh age so useful entries survive.
    this.flagAge[i] = (this.age << 2) | this.hitFlag;
    return true;
  }

  store(lo: number, hi: number, depth: number, score: number, flag: number, move: number, evalv: number, ply: number): void {
    const i0 = lo & this.mask;
    const i1 = i0 ^ 1;
    let i: number;
    if ((this.keyLo[i0] === lo && this.keyHi[i0] === hi) || this.flagAge[i0] === 0) i = i0;
    else if ((this.keyLo[i1] === lo && this.keyHi[i1] === hi) || this.flagAge[i1] === 0) i = i1;
    else {
      // Replace the entry that is older, or shallower when both are current.
      const a0 = this.flagAge[i0] >> 2, a1 = this.flagAge[i1] >> 2;
      if (a0 !== this.age && a1 === this.age) i = i0;
      else if (a1 !== this.age && a0 === this.age) i = i1;
      else i = this.depth[i0] <= this.depth[i1] ? i0 : i1;
    }
    const sameKey = this.keyLo[i] === lo && this.keyHi[i] === hi && this.flagAge[i] !== 0;
    // Do not overwrite a deeper exact entry of the same position with a shallow bound.
    if (sameKey && flag !== TT_EXACT && this.depth[i] > depth + 3 && (this.flagAge[i] >> 2) === this.age) {
      return;
    }
    if (this.flagAge[i] === 0) this.used++;
    if (score >= MATE_IN_MAX) score += ply; else if (score <= -MATE_IN_MAX) score -= ply;
    this.keyLo[i] = lo; this.keyHi[i] = hi;
    this.move[i] = move !== NO_MOVE || !sameKey ? move : this.move[i];
    this.score[i] = score; this.evalv[i] = evalv; this.depth[i] = depth;
    this.flagAge[i] = (this.age << 2) | flag;
  }
}
