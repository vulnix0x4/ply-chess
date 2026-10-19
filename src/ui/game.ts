// Game tree: a root position plus nodes for every move, with variations.
import { Position } from '../engine/board';
import { moveToSan, parseSan, parseUci } from '../engine/notation';
import { moveToUci, STARTPOS_FEN, WHITE, NO_MOVE } from '../engine/types';

export interface GameNode {
  id: number;
  parent: GameNode | null;
  children: GameNode[];
  move: number; // encoded move leading to this node (0 for root)
  uci: string;
  san: string;
  fen: string; // position after the move
  ply: number; // 0 for root
  comment?: string;
  nags: number[];
  // Cached evaluation from the engine (centipawns from White's view, or mate)
  eval?: { type: 'cp' | 'mate'; value: number; depth: number };
}

export type GameStatus =
  | { over: false; check: boolean }
  | { over: true; result: '1-0' | '0-1' | '1/2-1/2'; reason: string; winner?: 0 | 1 };

let nextId = 1;

export class Game {
  root: GameNode;
  current: GameNode;
  headers: Map<string, string> = new Map();
  startFen: string;
  listeners = new Set<() => void>();

  constructor(fen: string = STARTPOS_FEN) {
    this.startFen = fen;
    this.root = { id: nextId++, parent: null, children: [], move: NO_MOVE, uci: '', san: '', fen, ply: 0, nags: [] };
    this.current = this.root;
    this.setDefaultHeaders();
  }

  private setDefaultHeaders(): void {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    this.headers.set('Event', 'Casual game');
    this.headers.set('Site', 'Ply');
    this.headers.set('Date', `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`);
    this.headers.set('Round', '-');
    this.headers.set('White', 'White');
    this.headers.set('Black', 'Black');
    this.headers.set('Result', '*');
    if (this.startFen !== STARTPOS_FEN) { this.headers.set('SetUp', '1'); this.headers.set('FEN', this.startFen); }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  notify(): void { for (const l of this.listeners) l(); }

  position(node: GameNode = this.current): Position {
    return new Position(node.fen);
  }

  // Plays a move from the current node. Reuses an existing child if the move is
  // already there; otherwise creates a variation (or the main line if first).
  play(move: number, node: GameNode = this.current): GameNode {
    const uci = moveToUci(move);
    const existing = node.children.find((c) => c.uci === uci);
    if (existing) { this.current = existing; this.notify(); return existing; }
    const pos = new Position(node.fen);
    const san = moveToSan(pos, move);
    if (!pos.makeMove(move)) throw new Error('illegal move ' + uci);
    const child: GameNode = { id: nextId++, parent: node, children: [], move, uci, san, fen: pos.fen(), ply: node.ply + 1, nags: [] };
    node.children.push(child);
    this.current = child;
    this.notify();
    return child;
  }

  playSan(san: string, node: GameNode = this.current): GameNode | null {
    const m = parseSan(new Position(node.fen), san);
    if (!m) return null;
    return this.play(m, node);
  }

  playUci(uci: string, node: GameNode = this.current): GameNode | null {
    const m = parseUci(new Position(node.fen), uci);
    if (!m) return null;
    return this.play(m, node);
  }

  goTo(node: GameNode): void { this.current = node; this.notify(); }
  back(): void { if (this.current.parent) this.goTo(this.current.parent); }
  forward(): void { if (this.current.children[0]) this.goTo(this.current.children[0]); }
  first(): void { this.goTo(this.root); }
  last(): void { let n = this.current; while (n.children[0]) n = n.children[0]; this.goTo(n); }

  // Main line from the root (first children).
  mainLine(): GameNode[] {
    const out: GameNode[] = [];
    let n = this.root;
    while (n.children[0]) { n = n.children[0]; out.push(n); }
    return out;
  }

  // Path of nodes from root to the given node (excluding root).
  pathTo(node: GameNode): GameNode[] {
    const out: GameNode[] = [];
    for (let n: GameNode | null = node; n && n.parent; n = n.parent) out.unshift(n);
    return out;
  }

  // UCI moves from the start position to the given node.
  uciPath(node: GameNode = this.current): string[] {
    return this.pathTo(node).map((n) => n.uci);
  }

  isOnMainLine(node: GameNode): boolean {
    for (let n: GameNode | null = node; n && n.parent; n = n.parent) if (n.parent.children[0] !== n) return false;
    return true;
  }

  promoteVariation(node: GameNode): void {
    // Make the branch containing `node` the main line at every level.
    for (let n: GameNode | null = node; n && n.parent; n = n.parent) {
      const sib = n.parent.children;
      const i = sib.indexOf(n);
      if (i > 0) { sib.splice(i, 1); sib.unshift(n); }
    }
    this.notify();
  }

  deleteFrom(node: GameNode): void {
    if (!node.parent) { node.children = []; this.current = node; this.notify(); return; }
    const sib = node.parent.children;
    sib.splice(sib.indexOf(node), 1);
    if (this.isAncestorOrSelf(node, this.current)) this.current = node.parent;
    this.notify();
  }

  private isAncestorOrSelf(a: GameNode, b: GameNode): boolean {
    for (let n: GameNode | null = b; n; n = n.parent) if (n === a) return true;
    return false;
  }

  // Truncates everything after the current node (used when a human plays a new move during a game).
  truncateAfterCurrent(): void {
    this.current.children = [];
    this.notify();
  }

  status(node: GameNode = this.current): GameStatus {
    const pos = new Position(node.fen);
    const legal = pos.legalMoves();
    const check = pos.inCheck();
    if (legal.length === 0) {
      if (check) {
        const winner = pos.side === WHITE ? 1 : 0;
        return { over: true, result: winner === 0 ? '1-0' : '0-1', reason: 'Checkmate', winner };
      }
      return { over: true, result: '1/2-1/2', reason: 'Stalemate' };
    }
    if (pos.insufficientMaterial()) return { over: true, result: '1/2-1/2', reason: 'Insufficient material' };
    if (pos.halfmove >= 100) return { over: true, result: '1/2-1/2', reason: 'Fifty-move rule' };
    // Threefold repetition along the path from the root.
    let count = 0;
    const key = node.fen.split(' ').slice(0, 4).join(' ');
    for (let n: GameNode | null = node.parent; n; n = n.parent) {
      if (n.fen.split(' ').slice(0, 4).join(' ') === key) count++;
      if (count >= 2) return { over: true, result: '1/2-1/2', reason: 'Threefold repetition' };
    }
    return { over: false, check };
  }

  reset(fen: string = STARTPOS_FEN): void {
    this.startFen = fen;
    this.root = { id: nextId++, parent: null, children: [], move: NO_MOVE, uci: '', san: '', fen, ply: 0, nags: [] };
    this.current = this.root;
    this.headers = new Map();
    this.setDefaultHeaders();
    this.notify();
  }
}
