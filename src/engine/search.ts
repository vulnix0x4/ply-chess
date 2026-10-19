// Alpha-beta search: iterative deepening, aspiration windows, principal
// variation search, transposition table, null-move pruning, reverse futility,
// razoring, futility and late-move pruning, late-move reductions, check
// extensions, killer/history/counter-move ordering, SEE-based capture ordering,
// multi-PV root search and time management.
import { Position } from './board';
import {
  WHITE, PAWN, KING, QUEEN, NO_MOVE, MAX_PLY, MATE_VALUE, MATE_IN_MAX, INFINITE, VALUE_NONE,
  moveFrom, moveTo, moveCaptured, movePromo, moveIsCastle, to64, pieceType,
} from './types';
import { evaluate, PIECE_VALUE } from './eval';
import { see } from './see';
import { TranspositionTable, TT_EXACT, TT_ALPHA, TT_BETA } from './tt';

export interface SearchLimits {
  depth?: number;
  movetime?: number; // ms
  wtime?: number; btime?: number; winc?: number; binc?: number; movestogo?: number;
  nodes?: number;
  infinite?: boolean;
  multiPv?: number;
}

export interface PvLine {
  multipv: number;
  depth: number;
  seldepth: number;
  scoreType: 'cp' | 'mate';
  score: number; // cp, or mate distance in moves (negative = we get mated)
  pv: number[];
  nodes: number;
  time: number;
  nps: number;
  hashfull: number;
}

export interface SearchResult {
  bestMove: number;
  ponderMove: number;
  lines: PvLine[];
  depth: number;
  nodes: number;
  time: number;
}

export interface SearchCallbacks {
  onInfo?: (line: PvLine) => void;
  onProgress?: (nodes: number, time: number, depth: number) => void;
  shouldStop?: () => boolean;
}

const LMR = new Uint8Array(64 * 64);
for (let d = 1; d < 64; d++) for (let m = 1; m < 64; m++) {
  LMR[d * 64 + m] = Math.max(0, Math.floor(0.6 + Math.log(d) * Math.log(m) / 2.1));
}
const LMP_COUNT = [0, 5, 8, 12, 18, 26, 36, 48];
const FUTILITY_MARGIN = [0, 110, 190, 270, 350, 430, 510];

const MOVES_PER_PLY = 256;
const SCORE_TT = 1 << 30;
const SCORE_GOOD_CAPTURE = 1 << 28;
const SCORE_KILLER1 = 1 << 27;
const SCORE_KILLER2 = (1 << 27) - 1;
const SCORE_COUNTER = (1 << 27) - 2;
const SCORE_BAD_CAPTURE = -(1 << 28);
const HISTORY_MAX = 1 << 20;

export class Search {
  tt: TranspositionTable;
  pos!: Position;
  nodes = 0;
  seldepth = 0;
  stopped = false;
  startTime = 0;
  optimumTime = 0;
  maximumTime = 0;
  nodeLimit = 0;
  depthLimit = MAX_PLY - 1;
  shouldStop: () => boolean = () => false;
  onInfo?: (line: PvLine) => void;
  onProgress?: (nodes: number, time: number, depth: number) => void;
  lastProgress = 0;
  rootDepth = 0;

  moves = new Int32Array(MAX_PLY * MOVES_PER_PLY);
  scores = new Int32Array(MAX_PLY * MOVES_PER_PLY);
  killers = new Int32Array(MAX_PLY * 2);
  history = new Int32Array(2 * 64 * 64);
  counterMove = new Int32Array(16 * 128);
  stackMove = new Int32Array(MAX_PLY);
  stackPiece = new Int32Array(MAX_PLY);
  stackEval = new Int32Array(MAX_PLY);
  pvTable = new Int32Array(MAX_PLY * MAX_PLY);
  pvLength = new Int32Array(MAX_PLY);
  excludedRoot: number[] = [];

  constructor(hashMb = 16) {
    this.tt = new TranspositionTable(hashMb);
  }

  newGame(): void {
    this.tt.clear();
    this.history.fill(0);
    this.counterMove.fill(0);
    this.killers.fill(0);
  }

  // ---- Time / stop handling ----------------------------------------------
  private elapsed(): number {
    return performance.now() - this.startTime;
  }

  private checkStop(): void {
    if (this.stopped) return;
    if (this.nodeLimit && this.nodes >= this.nodeLimit) { this.stopped = true; return; }
    if ((this.nodes & 1023) === 0) {
      const t = this.elapsed();
      if (this.maximumTime && t >= this.maximumTime) { this.stopped = true; return; }
      if (this.shouldStop()) { this.stopped = true; return; }
      if (this.onProgress && t - this.lastProgress > 400) {
        this.lastProgress = t;
        this.onProgress(this.nodes, t, this.rootDepth);
      }
    }
  }

  // ---- Public entry point ---------------------------------------------------
  go(pos: Position, limits: SearchLimits, cb: SearchCallbacks = {}): SearchResult {
    this.pos = pos;
    this.nodes = 0; this.seldepth = 0; this.stopped = false; this.lastProgress = 0;
    this.startTime = performance.now();
    this.shouldStop = cb.shouldStop ?? (() => false);
    this.onInfo = cb.onInfo; this.onProgress = cb.onProgress;
    this.tt.newSearch();
    this.killers.fill(0);
    // Soften history between searches so it stays relevant but adapts.
    for (let i = 0; i < this.history.length; i++) this.history[i] = this.history[i] >> 1;

    this.depthLimit = Math.min(limits.depth ?? MAX_PLY - 1, MAX_PLY - 1);
    this.nodeLimit = limits.nodes ?? 0;
    this.optimumTime = 0; this.maximumTime = 0;
    if (limits.movetime) { this.optimumTime = limits.movetime; this.maximumTime = limits.movetime; }
    else if (limits.wtime !== undefined || limits.btime !== undefined) {
      const time = (pos.side === WHITE ? limits.wtime : limits.btime) ?? 0;
      const inc = (pos.side === WHITE ? limits.winc : limits.binc) ?? 0;
      const mtg = limits.movestogo ?? Math.max(20, 45 - Math.floor(pos.fullmove / 2));
      const overhead = 30;
      const base = Math.max(1, time - overhead);
      this.optimumTime = Math.min(base * 0.8, base / mtg + inc * 0.75);
      this.maximumTime = Math.min(base * 0.8, this.optimumTime * 5);
      if (this.optimumTime < 5) this.optimumTime = 5;
      if (this.maximumTime < 10) this.maximumTime = 10;
    }

    const multiPv = Math.max(1, limits.multiPv ?? 1);
    const rootMoves = pos.legalMoves();
    const result: SearchResult = { bestMove: NO_MOVE, ponderMove: NO_MOVE, lines: [], depth: 0, nodes: 0, time: 0 };
    if (rootMoves.length === 0) return result;

    const pvCount = Math.min(multiPv, rootMoves.length);
    let lines: PvLine[] = [];
    let lastBest = NO_MOVE;
    let stableIterations = 0;
    let prevScores: number[] = [];

    for (let depth = 1; depth <= this.depthLimit; depth++) {
      this.rootDepth = depth;
      const iterLines: PvLine[] = [];
      this.excludedRoot = [];
      let iterationAborted = false;
      for (let k = 0; k < pvCount; k++) {
        let alpha = -INFINITE, beta = INFINITE;
        let delta = 0;
        const prev = prevScores[k];
        if (depth >= 5 && prev !== undefined && Math.abs(prev) < MATE_IN_MAX) {
          delta = 20;
          alpha = Math.max(-INFINITE, prev - delta);
          beta = Math.min(INFINITE, prev + delta);
        }
        let score = 0;
        for (;;) {
          this.seldepth = 0;
          score = this.searchRoot(depth, alpha, beta);
          if (this.stopped) break;
          if (score <= alpha) { beta = Math.floor((alpha + beta) / 2); alpha = Math.max(-INFINITE, score - delta); delta += Math.floor(delta / 2) + 10; }
          else if (score >= beta) { beta = Math.min(INFINITE, score + delta); delta += Math.floor(delta / 2) + 10; }
          else break;
        }
        if (this.stopped) {
          // Keep the partially searched line only if it completed with a real PV at depth 1.
          if (depth === 1 && this.pvLength[0] > 0 && k === 0) {
            iterLines.push(this.makeLine(k, depth, score));
          }
          iterationAborted = true;
          break;
        }
        const line = this.makeLine(k, depth, score);
        iterLines.push(line);
        this.excludedRoot.push(line.pv[0]);
        this.onInfo?.(line);
      }
      if (iterLines.length > 0 && (!iterationAborted || lines.length === 0)) {
        if (!iterationAborted) {
          lines = iterLines;
          prevScores = lines.map((l) => this.lineToInternal(l));
        } else if (lines.length === 0) {
          lines = iterLines;
        }
      }
      if (this.stopped) break;
      result.depth = depth;
      const best = lines[0]?.pv[0] ?? NO_MOVE;
      if (best === lastBest) stableIterations++; else stableIterations = 0;
      lastBest = best;
      // Easy exits
      if (rootMoves.length === 1 && depth >= 4 && !limits.infinite && limits.depth === undefined) break;
      if (lines[0] && lines[0].scoreType === 'mate' && Math.abs(lines[0].score) * 2 <= depth && !limits.infinite && limits.depth === undefined && pvCount === 1) break;
      if (this.optimumTime) {
        const t = this.elapsed();
        const factor = stableIterations >= 3 ? 0.6 : stableIterations >= 1 ? 0.85 : 1.25;
        if (t >= this.optimumTime * factor) break;
      }
    }
    if (lines.length === 0) {
      // Should not happen, but never return without a move.
      lines = [{ multipv: 1, depth: 1, seldepth: 1, scoreType: 'cp', score: 0, pv: [rootMoves[0]], nodes: this.nodes, time: this.elapsed(), nps: 0, hashfull: 0 }];
    }
    result.lines = lines;
    result.bestMove = lines[0].pv[0] ?? rootMoves[0];
    result.ponderMove = lines[0].pv[1] ?? NO_MOVE;
    result.nodes = this.nodes;
    result.time = this.elapsed();
    return result;
  }

  private lineToInternal(l: PvLine): number {
    if (l.scoreType === 'cp') return l.score;
    return l.score > 0 ? MATE_VALUE - (l.score * 2 - 1) : -MATE_VALUE + (-l.score * 2);
  }

  private makeLine(k: number, depth: number, score: number): PvLine {
    const pv: number[] = [];
    for (let i = 0; i < this.pvLength[0]; i++) pv.push(this.pvTable[i]);
    const time = this.elapsed();
    let scoreType: 'cp' | 'mate' = 'cp';
    let s = score;
    if (score >= MATE_IN_MAX) { scoreType = 'mate'; s = Math.ceil((MATE_VALUE - score) / 2); }
    else if (score <= -MATE_IN_MAX) { scoreType = 'mate'; s = -Math.floor((MATE_VALUE + score) / 2); }
    return {
      multipv: k + 1, depth, seldepth: this.seldepth, scoreType, score: s, pv,
      nodes: this.nodes, time, nps: time > 0 ? Math.round((this.nodes * 1000) / time) : 0, hashfull: this.tt.hashfull(),
    };
  }

  // ---- Root search ----------------------------------------------------------
  private searchRoot(depth: number, alpha: number, beta: number): number {
    const pos = this.pos;
    const ply = 0;
    const base = 0;
    const moves = this.moves, scores = this.scores;
    let n = pos.genMoves(moves, base) - base;
    this.pvLength[0] = 0;
    const inCheck = pos.inCheck();
    pos.hashLo; // keep key fresh
    this.tt.probe(pos.hashLo, pos.hashHi, ply);
    const ttMove = this.tt.hit ? this.tt.hitMove : NO_MOVE;
    this.stackEval[0] = evaluate(pos);
    this.scoreMoves(base, n, ttMove, ply);
    // Remove excluded root moves (multi-PV).
    for (let i = 0; i < n; i++) {
      if (this.excludedRoot.includes(moves[base + i])) { moves[base + i] = moves[base + n - 1]; scores[base + i] = scores[base + n - 1]; n--; i--; }
    }
    let bestScore = -INFINITE, bestMove = NO_MOVE;
    let legal = 0;
    const origAlpha = alpha;
    for (let i = 0; i < n; i++) {
      this.pickMove(base, i, n);
      const m = moves[base + i];
      if (!pos.makeMove(m)) continue;
      legal++;
      this.stackMove[ply] = m;
      this.stackPiece[ply] = pos.board[moveTo(m)];
      const givesCheck = pos.inCheck();
      const isQuiet = moveCaptured(m) === 0 && movePromo(m) === 0;
      let newDepth = depth - 1 + (givesCheck ? 1 : 0);
      let score: number;
      if (legal === 1) {
        score = -this.search(newDepth, -beta, -alpha, ply + 1, true);
      } else {
        let reduction = 0;
        if (depth >= 3 && legal >= 4 && isQuiet && !inCheck && !givesCheck) {
          reduction = LMR[Math.min(63, depth) * 64 + Math.min(63, legal)];
          if (reduction > 0) reduction--; // be gentle at the root
        }
        score = -this.search(newDepth - reduction, -alpha - 1, -alpha, ply + 1, false);
        if (score > alpha && reduction > 0) score = -this.search(newDepth, -alpha - 1, -alpha, ply + 1, false);
        if (score > alpha && score < beta) score = -this.search(newDepth, -beta, -alpha, ply + 1, true);
      }
      pos.unmakeMove();
      if (this.stopped) return bestScore;
      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
        if (score > alpha) {
          alpha = score;
          this.updatePv(ply, m);
          if (score >= beta) break;
        }
      }
    }
    if (legal === 0) return inCheck ? -MATE_VALUE : 0;
    if (bestMove !== NO_MOVE && this.excludedRoot.length === 0) {
      const flag = bestScore >= beta ? TT_BETA : bestScore > origAlpha ? TT_EXACT : TT_ALPHA;
      this.tt.store(pos.hashLo, pos.hashHi, depth, bestScore, flag, bestMove, this.stackEval[0], ply);
    }
    if (this.pvLength[0] === 0 && bestMove !== NO_MOVE) { this.pvTable[0] = bestMove; this.pvLength[0] = 1; }
    return bestScore;
  }

  private updatePv(ply: number, m: number): void {
    const row = ply * MAX_PLY, next = (ply + 1) * MAX_PLY;
    this.pvTable[row] = m;
    const len = ply + 1 < MAX_PLY ? this.pvLength[ply + 1] : 0;
    for (let i = 0; i < len; i++) this.pvTable[row + 1 + i] = this.pvTable[next + i];
    this.pvLength[ply] = len + 1;
  }

  // ---- Main search ----------------------------------------------------------
  private search(depth: number, alpha: number, beta: number, ply: number, pvNode: boolean): number {
    const pos = this.pos;
    this.pvLength[ply] = 0;
    if (depth <= 0) return this.qsearch(alpha, beta, ply);
    this.nodes++;
    this.checkStop();
    if (this.stopped) return 0;
    if (ply > this.seldepth) this.seldepth = ply;
    if (ply >= MAX_PLY - 1) return evaluate(pos);

    // Draw detection
    if (pos.repetitionCount() >= 1 || pos.halfmove >= 100 || pos.insufficientMaterial()) return 0;

    // Mate distance pruning
    const mateAlpha = -MATE_VALUE + ply, mateBeta = MATE_VALUE - ply - 1;
    if (alpha < mateAlpha) alpha = mateAlpha;
    if (beta > mateBeta) beta = mateBeta;
    if (alpha >= beta) return alpha;

    const inCheck = pos.inCheck();
    const tt = this.tt;
    const ttHit = tt.probe(pos.hashLo, pos.hashHi, ply);
    const ttMove = ttHit ? tt.hitMove : NO_MOVE;
    const ttScore = ttHit ? tt.hitScore : VALUE_NONE;
    const ttFlag = ttHit ? tt.hitFlag : 0;
    if (ttHit && !pvNode && tt.hitDepth >= depth) {
      if (ttFlag === TT_EXACT) return ttScore;
      if (ttFlag === TT_BETA && ttScore >= beta) return ttScore;
      if (ttFlag === TT_ALPHA && ttScore <= alpha) return ttScore;
    }

    let staticEval: number;
    if (inCheck) staticEval = -INFINITE;
    else if (ttHit && tt.hitEval !== VALUE_NONE && tt.hitEval > -INFINITE && tt.hitEval < INFINITE && tt.hitEval !== 0) staticEval = tt.hitEval;
    else staticEval = evaluate(pos);
    this.stackEval[ply] = staticEval;
    // Use a TT score as a better eval estimate when its bound allows.
    let evalEst = staticEval;
    if (ttHit && !inCheck && ((ttFlag === TT_BETA && ttScore > staticEval) || (ttFlag === TT_ALPHA && ttScore < staticEval) || ttFlag === TT_EXACT)) evalEst = ttScore;
    const improving = !inCheck && ply >= 2 && (this.stackEval[ply - 2] === -INFINITE || staticEval > this.stackEval[ply - 2]);

    const prevMove = ply > 0 ? this.stackMove[ply - 1] : NO_MOVE;

    if (!pvNode && !inCheck) {
      // Reverse futility pruning
      if (depth <= 7 && evalEst - 70 * depth + (improving ? 40 : 0) >= beta && Math.abs(beta) < MATE_IN_MAX) return evalEst;
      // Null move pruning
      if (depth >= 3 && evalEst >= beta && prevMove !== NO_MOVE && pos.nonPawnMaterial(pos.side) > 0 && (ply < 2 || this.stackMove[ply - 2] !== NO_MOVE || true)) {
        const r = 3 + Math.floor(depth / 4) + Math.min(3, Math.floor((evalEst - beta) / 200));
        pos.makeNull();
        this.stackMove[ply] = NO_MOVE;
        this.stackPiece[ply] = 0;
        const score = -this.search(depth - 1 - r, -beta, -beta + 1, ply + 1, false);
        pos.unmakeNull();
        if (this.stopped) return 0;
        if (score >= beta) {
          if (score >= MATE_IN_MAX) return beta; // do not trust mate scores from null move
          if (depth >= 12) {
            // Verification search at high depth.
            const v = this.search(depth - 1 - r, beta - 1, beta, ply, false);
            if (v >= beta) return score;
          } else return score;
        }
      }
    }
    // Internal iterative reduction when no TT move is available.
    if (depth >= 4 && ttMove === NO_MOVE && !inCheck) depth--;

    const base = ply * MOVES_PER_PLY;
    const moves = this.moves;
    const n = pos.genMoves(moves, base) - base;
    this.scoreMoves(base, n, ttMove, ply);

    let bestScore = -INFINITE, bestMove = NO_MOVE;
    const origAlpha = alpha;
    let legal = 0;
    let quietsSearched = 0;
    const quietList: number[] = [];
    const futilityOk = !inCheck && depth <= 6 && !pvNode;
    const futilityBase = staticEval + FUTILITY_MARGIN[Math.min(6, depth)];
    const lmpOk = !inCheck && depth <= 7 && !pvNode;
    const lmpLimit = LMP_COUNT[Math.min(7, depth)] + (improving ? 4 : 0);
    const us = pos.side;

    for (let i = 0; i < n; i++) {
      this.pickMove(base, i, n);
      const m = moves[base + i];
      const mscore = this.scores[base + i];
      const captured = moveCaptured(m), promo = movePromo(m);
      const isQuiet = captured === 0 && promo === 0;
      const isKillerOrCounter = mscore === SCORE_KILLER1 || mscore === SCORE_KILLER2 || mscore === SCORE_COUNTER;

      if (!pos.makeMove(m)) continue;
      const givesCheck = pos.inCheck();
      // Pruning of late quiet moves and losing captures (never prune checks).
      if (!givesCheck && bestScore > -MATE_IN_MAX && m !== ttMove && legal > 0) {
        let prune = false;
        if (isQuiet) {
          if (lmpOk && quietsSearched >= lmpLimit) prune = true;
          else if (futilityOk && futilityBase <= alpha && !isKillerOrCounter) prune = true;
          else if (!pvNode && depth <= 3 && !inCheck && !isKillerOrCounter && this.historyOf(us, m) < -4000 * depth) prune = true;
        } else if (!pvNode && !inCheck && depth <= 5 && mscore <= SCORE_BAD_CAPTURE + (1 << 20)) {
          if (see(pos, m) < -30 * depth * depth) prune = true;
        }
        if (prune) { pos.unmakeMove(); continue; }
      }
      legal++;
      this.stackMove[ply] = m;
      this.stackPiece[ply] = pos.board[moveTo(m)];
      let ext = 0;
      if (givesCheck) ext = 1;
      // Pawn push to the seventh rank
      if (isQuiet && pieceType(this.stackPiece[ply]) === PAWN) {
        const r = moveTo(m) >> 4;
        if (r === 6 || r === 1) ext = 1;
      }
      const newDepth = depth - 1 + ext;
      let score: number;
      if (legal === 1) {
        score = -this.search(newDepth, -beta, -alpha, ply + 1, pvNode);
      } else {
        let reduction = 0;
        if (depth >= 3 && legal >= (pvNode ? 4 : 2) && isQuiet && !inCheck) {
          reduction = LMR[Math.min(63, depth) * 64 + Math.min(63, legal)];
          if (pvNode) reduction--;
          if (isKillerOrCounter) reduction--;
          if (!improving) reduction++;
          if (givesCheck) reduction--;
          const h = this.historyOf(us, m);
          reduction -= Math.max(-2, Math.min(2, Math.trunc(h / 6000)));
          if (reduction < 0) reduction = 0;
          if (reduction > newDepth - 1) reduction = Math.max(0, newDepth - 1);
        } else if (depth >= 3 && legal >= 3 && !isQuiet && mscore <= SCORE_BAD_CAPTURE + (1 << 20)) {
          reduction = 1;
        }
        score = -this.search(newDepth - reduction, -alpha - 1, -alpha, ply + 1, false);
        if (reduction > 0 && score > alpha) score = -this.search(newDepth, -alpha - 1, -alpha, ply + 1, false);
        if (pvNode && score > alpha && score < beta) score = -this.search(newDepth, -beta, -alpha, ply + 1, true);
      }
      pos.unmakeMove();
      if (this.stopped) return 0;
      if (isQuiet) { quietsSearched++; quietList.push(m); }

      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
        if (score > alpha) {
          alpha = score;
          if (pvNode) this.updatePv(ply, m);
          if (score >= beta) {
            if (isQuiet) this.updateQuietStats(m, depth, ply, quietList, us, prevMove);
            break;
          }
        }
      }
    }

    if (legal === 0) return inCheck ? -MATE_VALUE + ply : 0;
    const flag = bestScore >= beta ? TT_BETA : bestScore > origAlpha ? TT_EXACT : TT_ALPHA;
    tt.store(pos.hashLo, pos.hashHi, depth, bestScore, flag, bestMove, staticEval, ply);
    return bestScore;
  }

  // ---- Quiescence ----------------------------------------------------------
  private qsearch(alpha: number, beta: number, ply: number): number {
    const pos = this.pos;
    this.nodes++;
    this.checkStop();
    if (this.stopped) return 0;
    if (ply > this.seldepth) this.seldepth = ply;
    this.pvLength[ply] = 0;
    if (ply >= MAX_PLY - 1) return evaluate(pos);
    if (pos.repetitionCount() >= 1 || pos.halfmove >= 100) return 0;

    const tt = this.tt;
    const ttHit = tt.probe(pos.hashLo, pos.hashHi, ply);
    if (ttHit) {
      const f = tt.hitFlag, s = tt.hitScore;
      if (f === TT_EXACT) return s;
      if (f === TT_BETA && s >= beta) return s;
      if (f === TT_ALPHA && s <= alpha) return s;
    }
    const inCheck = pos.inCheck();
    let staticEval = -INFINITE;
    let bestScore = -INFINITE;
    if (!inCheck) {
      staticEval = (ttHit && tt.hitEval !== 0) ? tt.hitEval : evaluate(pos);
      bestScore = staticEval;
      if (bestScore >= beta) {
        if (!ttHit) tt.store(pos.hashLo, pos.hashHi, 0, bestScore, TT_BETA, NO_MOVE, staticEval, ply);
        return bestScore;
      }
      if (bestScore > alpha) alpha = bestScore;
    }
    const base = ply * MOVES_PER_PLY;
    const moves = this.moves, scores = this.scores;
    const n = (inCheck ? pos.genMoves(moves, base) : pos.genCaptures(moves, base)) - base;
    const ttMove = ttHit ? tt.hitMove : NO_MOVE;
    for (let i = 0; i < n; i++) {
      const m = moves[base + i];
      if (m === ttMove) { scores[base + i] = SCORE_TT; continue; }
      const cap = moveCaptured(m), promo = movePromo(m);
      scores[base + i] = PIECE_VALUE[cap & 7] * 16 - PIECE_VALUE[pieceType(pos.board[moveFrom(m)])] / 10 + (promo ? PIECE_VALUE[promo] : 0);
    }
    let bestMove = NO_MOVE;
    let legal = 0;
    const origAlpha = alpha;
    for (let i = 0; i < n; i++) {
      this.pickMove(base, i, n);
      const m = moves[base + i];
      const cap = moveCaptured(m), promo = movePromo(m);
      if (!inCheck && cap !== 0) {
        // Delta pruning
        if (staticEval + PIECE_VALUE[cap & 7] + (promo ? PIECE_VALUE[promo] : 0) + 180 <= alpha && pos.nonPawnMaterial(pos.side ^ 1) > 0) continue;
        // Skip losing captures
        if (PIECE_VALUE[pieceType(pos.board[moveFrom(m)])] > PIECE_VALUE[cap & 7] && see(pos, m) < 0) continue;
      }
      if (!pos.makeMove(m)) continue;
      legal++;
      const score = -this.qsearch(-beta, -alpha, ply + 1);
      pos.unmakeMove();
      if (this.stopped) return 0;
      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
        if (score > alpha) {
          alpha = score;
          this.updatePv(ply, m);
          if (score >= beta) break;
        }
      }
    }
    if (inCheck && legal === 0) return -MATE_VALUE + ply;
    const flag = bestScore >= beta ? TT_BETA : bestScore > origAlpha ? TT_EXACT : TT_ALPHA;
    tt.store(pos.hashLo, pos.hashHi, 0, bestScore, flag, bestMove, staticEval === -INFINITE ? 0 : staticEval, ply);
    return bestScore;
  }

  // ---- Move ordering ------------------------------------------------------
  private historyOf(color: number, m: number): number {
    return this.history[(color * 64 + to64(moveFrom(m))) * 64 + to64(moveTo(m))];
  }

  private scoreMoves(base: number, n: number, ttMove: number, ply: number): void {
    const pos = this.pos, moves = this.moves, scores = this.scores;
    const k1 = this.killers[ply * 2], k2 = this.killers[ply * 2 + 1];
    const prev = ply > 0 ? this.stackMove[ply - 1] : NO_MOVE;
    const counter = prev !== NO_MOVE ? this.counterMove[this.stackPiece[ply - 1] * 128 + moveTo(prev)] : NO_MOVE;
    const us = pos.side;
    for (let i = 0; i < n; i++) {
      const m = moves[base + i];
      if (m === ttMove) { scores[base + i] = SCORE_TT; continue; }
      const cap = moveCaptured(m), promo = movePromo(m);
      if (cap !== 0 || promo !== 0) {
        const attacker = pieceType(pos.board[moveFrom(m)]);
        const victim = PIECE_VALUE[cap & 7];
        let s = victim * 16 - attacker + (promo === QUEEN ? 800 : promo ? -200 : 0);
        if (cap !== 0 && PIECE_VALUE[attacker] > victim && promo === 0 && see(pos, m) < 0) scores[base + i] = SCORE_BAD_CAPTURE + s;
        else scores[base + i] = SCORE_GOOD_CAPTURE + s;
        continue;
      }
      if (m === k1) scores[base + i] = SCORE_KILLER1;
      else if (m === k2) scores[base + i] = SCORE_KILLER2;
      else if (m === counter) scores[base + i] = SCORE_COUNTER;
      else {
        let s = this.historyOf(us, m);
        if (moveIsCastle(m)) s += 2000;
        scores[base + i] = s;
      }
    }
  }

  // Selection step: swap the best remaining move into slot i.
  private pickMove(base: number, i: number, n: number): void {
    const moves = this.moves, scores = this.scores;
    let best = i, bestScore = scores[base + i];
    for (let j = i + 1; j < n; j++) {
      if (scores[base + j] > bestScore) { bestScore = scores[base + j]; best = j; }
    }
    if (best !== i) {
      const tm = moves[base + i], ts = scores[base + i];
      moves[base + i] = moves[base + best]; scores[base + i] = scores[base + best];
      moves[base + best] = tm; scores[base + best] = ts;
    }
  }

  private updateQuietStats(m: number, depth: number, ply: number, quiets: number[], us: number, prevMove: number): void {
    const k = ply * 2;
    if (this.killers[k] !== m) { this.killers[k + 1] = this.killers[k]; this.killers[k] = m; }
    if (prevMove !== NO_MOVE) this.counterMove[this.stackPiece[ply - 1] * 128 + moveTo(prevMove)] = m;
    const bonus = Math.min(depth * depth * 8 + depth * 16, 1200);
    this.bumpHistory(us, m, bonus);
    for (const q of quiets) if (q !== m) this.bumpHistory(us, q, -bonus);
  }

  private bumpHistory(us: number, m: number, bonus: number): void {
    const idx = (us * 64 + to64(moveFrom(m))) * 64 + to64(moveTo(m));
    const h = this.history[idx];
    this.history[idx] = h + bonus - Math.trunc((h * Math.abs(bonus)) / HISTORY_MAX);
  }
}

export { KING };
