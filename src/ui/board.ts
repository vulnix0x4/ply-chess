// Interactive chess board component. Pieces are absolutely positioned and
// moved with CSS transforms so moves animate; input supports drag-and-drop,
// click-click, promotion picking and right-click drawn shapes.
import { Position } from '../engine/board';
import {
  WHITE, BLACK, EMPTY, PAWN, KING, QUEEN, ROOK, BISHOP, KNIGHT, NO_MOVE, NO_SQ,
  moveFrom, moveTo, movePromo, moveIsCastle, moveCaptured, pieceColor, pieceType, sqFile, sqRank, sq88, sqName, makePiece,
} from '../engine/types';
import { pieceSvg } from './pieces';

export interface Shape { from: number; to?: number; color: string; width?: number }

export interface BoardOptions {
  onMove: (move: number) => void;
  onSelect?: (sq: number) => void;
  onShapesChange?: (shapes: Shape[]) => void;
}

interface PieceEl { el: HTMLElement; piece: number; sq: number }

export class Board {
  root: HTMLElement;
  private squaresEl: HTMLElement;
  private piecesEl: HTMLElement;
  private hintsEl: HTMLElement;
  private shapesEl: SVGSVGElement;
  private coordsEl: HTMLElement;
  private promoEl: HTMLElement;
  private pieces: PieceEl[] = [];
  orientation: 0 | 1 = WHITE;
  private pos: Position = new Position();
  private legal: number[] = [];
  private movable: Set<number> = new Set([WHITE, BLACK]); // colors the user may move
  private selected: number = NO_SQ;
  private lastMove: number = NO_MOVE;
  private checkSq: number = NO_SQ;
  private drag: { sq: number; el: HTMLElement; startX: number; startY: number; moved: boolean; pointerId: number } | null = null;
  private shapeDrag: { from: number; pointerId: number } | null = null;
  private userShapes: Shape[] = [];
  private autoShapes: Shape[] = [];
  private pendingPromo: { from: number; to: number } | null = null;
  animate = true;
  showLegal = true;
  showCoords = true;
  showLast = true;
  private opts: BoardOptions;

  constructor(container: HTMLElement, opts: BoardOptions) {
    this.opts = opts;
    this.root = container;
    container.classList.add('board');
    container.innerHTML = `
      <div class="board-squares"></div>
      <div class="board-coords"></div>
      <div class="board-hints"></div>
      <div class="board-pieces"></div>
      <svg class="board-shapes" viewBox="0 0 8 8"></svg>
      <div class="board-promo" hidden></div>`;
    this.squaresEl = container.querySelector('.board-squares')!;
    this.coordsEl = container.querySelector('.board-coords')!;
    this.hintsEl = container.querySelector('.board-hints')!;
    this.piecesEl = container.querySelector('.board-pieces')!;
    this.shapesEl = container.querySelector('.board-shapes')!;
    this.promoEl = container.querySelector('.board-promo')!;
    this.buildSquares();
    this.bindInput();
  }

  private buildSquares(): void {
    let html = '';
    for (let i = 0; i < 64; i++) {
      html += `<div class="sq" data-i="${i}"></div>`;
    }
    this.squaresEl.innerHTML = html;
    this.renderCoords();
  }

  private renderCoords(): void {
    let html = '';
    for (let i = 0; i < 8; i++) {
      const file = this.orientation === WHITE ? i : 7 - i;
      const rank = this.orientation === WHITE ? 7 - i : i;
      html += `<span class="coord file" style="left:${i * 12.5}%">${'abcdefgh'[file]}</span>`;
      html += `<span class="coord rank" style="top:${i * 12.5}%">${rank + 1}</span>`;
    }
    this.coordsEl.innerHTML = html;
    this.coordsEl.hidden = !this.showCoords;
  }

  // Visual grid index (0 = top-left) for a 0x88 square given orientation.
  private gridIndex(sq: number): number {
    const f = sqFile(sq), r = sqRank(sq);
    return this.orientation === WHITE ? (7 - r) * 8 + f : r * 8 + (7 - f);
  }

  private sqFromGrid(i: number): number {
    const row = Math.floor(i / 8), col = i % 8;
    return this.orientation === WHITE ? sq88(col, 7 - row) : sq88(7 - col, row);
  }

  private xy(sq: number): { x: number; y: number } {
    const i = this.gridIndex(sq);
    return { x: (i % 8) * 100, y: Math.floor(i / 8) * 100 };
  }

  private place(el: HTMLElement, sq: number): void {
    const { x, y } = this.xy(sq);
    el.style.transform = `translate(${x}%, ${y}%)`;
  }

  // ---- Public API ------------------------------------------------------------
  setOrientation(o: 0 | 1): void {
    if (this.orientation === o) return;
    this.orientation = o;
    this.root.dataset.orientation = o === WHITE ? 'white' : 'black';
    this.renderCoords();
    const prev = this.animate;
    this.animate = false;
    for (const p of this.pieces) this.place(p.el, p.sq);
    this.animate = prev;
    this.renderHighlights();
    this.renderShapes();
    this.cancelPromo();
  }

  setMovable(colors: number[]): void {
    this.movable = new Set(colors);
    if (this.selected !== NO_SQ && !this.canPick(this.selected)) this.select(NO_SQ);
    this.root.classList.toggle('board--locked', colors.length === 0);
  }

  setPosition(pos: Position, lastMove: number = NO_MOVE, legal?: number[]): void {
    this.cancelPromo();
    const oldPos = this.pos;
    this.pos = pos.clone();
    this.legal = legal ?? pos.legalMoves();
    this.lastMove = lastMove;
    this.checkSq = pos.inCheck() ? pos.kingSq(pos.side) : NO_SQ;
    this.syncPieces(oldPos, lastMove);
    this.select(NO_SQ);
    this.renderHighlights();
    this.userShapes = [];
    this.renderShapes();
  }

  setAutoShapes(shapes: Shape[]): void {
    this.autoShapes = shapes;
    this.renderShapes();
  }

  // ---- Piece diffing ---------------------------------------------------------
  private syncPieces(oldPos: Position, lastMove: number): void {
    const newBoard = this.pos.board;
    const stay: PieceEl[] = [];
    const removed: PieceEl[] = [];
    const added: { sq: number; piece: number }[] = [];
    const seen = new Uint8Array(128);
    for (const p of this.pieces) {
      if (newBoard[p.sq] === p.piece) { stay.push(p); seen[p.sq] = 1; } else removed.push(p);
    }
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const sq = sq88(f, r);
      const piece = newBoard[sq];
      if (piece !== EMPTY && !seen[sq]) added.push({ sq, piece });
    }
    void oldPos;
    const moves: PieceEl[] = [];
    // Match removed pieces to added squares to animate them: prefer the last move's from->to.
    const matchFrom = lastMove !== NO_MOVE ? moveFrom(lastMove) : NO_SQ;
    const matchTo = lastMove !== NO_MOVE ? moveTo(lastMove) : NO_SQ;
    const promo = lastMove !== NO_MOVE ? movePromo(lastMove) : 0;
    const take = (pred: (r: PieceEl, a: { sq: number; piece: number }) => boolean): void => {
      for (let i = removed.length - 1; i >= 0; i--) {
        const r = removed[i];
        const j = added.findIndex((a) => pred(r, a));
        if (j >= 0) {
          const a = added[j];
          added.splice(j, 1); removed.splice(i, 1);
          r.sq = a.sq;
          if (a.piece !== r.piece) { r.piece = a.piece; r.el.innerHTML = pieceSvg(a.piece); r.el.dataset.piece = String(a.piece); }
          moves.push(r);
        }
      }
    };
    take((r, a) => r.sq === matchFrom && a.sq === matchTo && (r.piece === a.piece || (promo !== 0 && pieceType(r.piece) === PAWN)));
    take((r, a) => r.piece === a.piece);
    for (const r of removed) {
      const el = r.el;
      el.classList.add('piece--fading');
      const done = () => el.remove();
      if (this.animate) setTimeout(done, 180); else done();
    }
    for (const a of added) {
      const el = this.createPieceEl(a.piece);
      this.place(el, a.sq);
      if (this.animate) { el.classList.add('piece--appear'); requestAnimationFrame(() => el.classList.remove('piece--appear')); }
      this.piecesEl.appendChild(el);
      stay.push({ el, piece: a.piece, sq: a.sq });
    }
    for (const m of moves) {
      if (!this.animate) m.el.classList.add('no-anim');
      m.el.classList.add('piece--moving');
      this.place(m.el, m.sq);
      setTimeout(() => m.el.classList.remove('piece--moving', 'no-anim'), 220);
      stay.push(m);
    }
    this.pieces = stay;
    this.root.classList.toggle('no-anim', !this.animate);
  }

  private createPieceEl(piece: number): HTMLElement {
    const el = document.createElement('div');
    el.className = 'piece';
    el.dataset.piece = String(piece);
    el.innerHTML = pieceSvg(piece);
    return el;
  }

  private pieceAt(sq: number): PieceEl | undefined {
    return this.pieces.find((p) => p.sq === sq);
  }

  // ---- Highlights ------------------------------------------------------------
  private renderHighlights(): void {
    const sqs = this.squaresEl.children;
    for (let i = 0; i < 64; i++) sqs[i].className = 'sq';
    if (this.showLast && this.lastMove !== NO_MOVE) {
      sqs[this.gridIndex(moveFrom(this.lastMove))].classList.add('sq--last');
      sqs[this.gridIndex(moveTo(this.lastMove))].classList.add('sq--last');
    }
    if (this.checkSq !== NO_SQ) sqs[this.gridIndex(this.checkSq)].classList.add('sq--check');
    if (this.selected !== NO_SQ) sqs[this.gridIndex(this.selected)].classList.add('sq--selected');
    // Legal move hints
    this.hintsEl.innerHTML = '';
    if (this.selected !== NO_SQ && this.showLegal) {
      const seen = new Set<number>();
      for (const m of this.legal) {
        if (moveFrom(m) !== this.selected) continue;
        const to = moveTo(m);
        if (seen.has(to)) continue;
        seen.add(to);
        const hint = document.createElement('div');
        hint.className = 'hint' + (moveCaptured(m) ? ' hint--capture' : '');
        this.place(hint, to);
        this.hintsEl.appendChild(hint);
      }
    }
  }

  // ---- Shapes (arrows / circles) ---------------------------------------------
  private renderShapes(): void {
    const all = [...this.autoShapes, ...this.userShapes];
    let html = '';
    for (const s of all) {
      const a = this.center(s.from);
      if (s.to === undefined || s.to === s.from) {
        html += `<circle cx="${a.x}" cy="${a.y}" r="0.44" fill="none" stroke="${s.color}" stroke-width="0.09" opacity="0.85"/>`;
        continue;
      }
      const b = this.center(s.to);
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const ux = dx / len, uy = dy / len;
      const w = s.width ?? 0.16;
      const headLen = 0.36, headW = 0.36;
      const sx = a.x + ux * 0.32, sy = a.y + uy * 0.32; // start a bit away from centre
      const ex = b.x - ux * headLen * 0.9, ey = b.y - uy * headLen * 0.9;
      const tipx = b.x - ux * 0.05, tipy = b.y - uy * 0.05;
      const lx = ex - uy * headW, ly = ey + ux * headW;
      const rx = ex + uy * headW, ry = ey - ux * headW;
      html += `<g opacity="0.85"><line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" stroke="${s.color}" stroke-width="${w}" stroke-linecap="round"/>` +
        `<polygon points="${tipx},${tipy} ${lx},${ly} ${rx},${ry}" fill="${s.color}"/></g>`;
    }
    this.shapesEl.innerHTML = html;
  }

  private center(sq: number): { x: number; y: number } {
    const i = this.gridIndex(sq);
    return { x: (i % 8) + 0.5, y: Math.floor(i / 8) + 0.5 };
  }

  deselect(): void {
    if (this.selected !== NO_SQ) this.select(NO_SQ);
    this.cancelPromo();
  }

  clearUserShapes(): void {
    if (this.userShapes.length === 0) return;
    this.userShapes = [];
    this.renderShapes();
    this.opts.onShapesChange?.(this.userShapes);
  }

  // ---- Input -----------------------------------------------------------------
  private canPick(sq: number): boolean {
    const p = this.pos.board[sq];
    return p !== EMPTY && pieceColor(p) === this.pos.side && this.movable.has(pieceColor(p));
  }

  private squareAt(clientX: number, clientY: number): number {
    const r = this.root.getBoundingClientRect();
    const x = (clientX - r.left) / r.width, y = (clientY - r.top) / r.height;
    if (x < 0 || y < 0 || x >= 1 || y >= 1) return NO_SQ;
    const col = Math.floor(x * 8), row = Math.floor(y * 8);
    return this.sqFromGrid(row * 8 + col);
  }

  private select(sq: number): void {
    this.selected = sq;
    this.renderHighlights();
    if (sq !== NO_SQ) this.opts.onSelect?.(sq);
  }

  private findMove(from: number, to: number): number[] {
    return this.legal.filter((m) => moveFrom(m) === from && moveTo(m) === to);
  }

  private tryMove(from: number, to: number): boolean {
    const candidates = this.findMove(from, to);
    if (candidates.length === 0) return false;
    if (candidates.length > 1 && movePromo(candidates[0]) !== 0) {
      this.showPromo(from, to);
      return true;
    }
    this.opts.onMove(candidates[0]);
    return true;
  }

  private bindInput(): void {
    const root = this.root;
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    root.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    root.addEventListener('pointermove', (e) => this.onPointerMove(e));
    root.addEventListener('pointerup', (e) => this.onPointerUp(e));
    root.addEventListener('pointercancel', (e) => this.onPointerUp(e, true));
    root.addEventListener('lostpointercapture', () => { /* handled by pointerup */ });
  }

  private onPointerDown(e: PointerEvent): void {
    if (this.pendingPromo) { if (!(e.target as HTMLElement).closest('.board-promo')) this.cancelPromo(); return; }
    const sq = this.squareAt(e.clientX, e.clientY);
    if (e.button === 2 || (e.button === 0 && e.ctrlKey)) {
      if (sq === NO_SQ) return;
      this.shapeDrag = { from: sq, pointerId: e.pointerId };
      this.root.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    if (sq === NO_SQ) return;
    if (this.userShapes.length) this.clearUserShapes();
    // Move to a target square via click-click
    if (this.selected !== NO_SQ && sq !== this.selected && !this.canPick(sq)) {
      const ok = this.tryMove(this.selected, sq);
      this.select(NO_SQ);
      if (ok) return;
    }
    if (this.canPick(sq)) {
      const p = this.pieceAt(sq);
      if (!p) return;
      e.preventDefault();
      this.root.setPointerCapture(e.pointerId);
      this.drag = { sq, el: p.el, startX: e.clientX, startY: e.clientY, moved: false, pointerId: e.pointerId };
      if (this.selected !== sq) this.select(sq);
      p.el.classList.add('piece--dragging');
    } else if (this.selected !== NO_SQ) {
      this.select(NO_SQ);
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const d = this.drag;
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) > 3) d.moved = true;
    if (!d.moved) return;
    const r = this.root.getBoundingClientRect();
    const size = r.width / 8;
    // Position the piece centred under the pointer.
    const px = e.clientX - r.left - size / 2, py = e.clientY - r.top - size / 2;
    d.el.style.transform = `translate(${px}px, ${py}px)`;
    const over = this.squareAt(e.clientX, e.clientY);
    const sqs = this.squaresEl.children;
    for (let i = 0; i < 64; i++) sqs[i].classList.remove('sq--over');
    if (over !== NO_SQ) sqs[this.gridIndex(over)].classList.add('sq--over');
  }

  private onPointerUp(e: PointerEvent, cancelled = false): void {
    if (this.shapeDrag && e.pointerId === this.shapeDrag.pointerId) {
      const to = this.squareAt(e.clientX, e.clientY);
      const from = this.shapeDrag.from;
      this.shapeDrag = null;
      try { this.root.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (cancelled || to === NO_SQ) return;
      const color = e.shiftKey ? 'var(--arrow-alt)' : e.altKey ? 'var(--arrow-alt2)' : 'var(--arrow-user)';
      const shape: Shape = to === from ? { from, color } : { from, to, color };
      const idx = this.userShapes.findIndex((s) => s.from === shape.from && s.to === shape.to);
      if (idx >= 0) this.userShapes.splice(idx, 1); else this.userShapes.push(shape);
      this.renderShapes();
      this.opts.onShapesChange?.(this.userShapes);
      return;
    }
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const d = this.drag;
    this.drag = null;
    try { this.root.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const sqs = this.squaresEl.children;
    for (let i = 0; i < 64; i++) sqs[i].classList.remove('sq--over');
    d.el.classList.remove('piece--dragging');
    if (!d.moved || cancelled) {
      // Simple click: keep the selection (toggle off if already selected before this click).
      d.el.classList.add('no-anim');
      this.place(d.el, d.sq);
      requestAnimationFrame(() => d.el.classList.remove('no-anim'));
      return;
    }
    const to = this.squareAt(e.clientX, e.clientY);
    if (to !== NO_SQ && to !== d.sq && this.tryMove(d.sq, to)) {
      // The app will set the new position; snap instantly to the target meanwhile.
      if (!this.pendingPromo) { d.el.classList.add('no-anim'); this.place(d.el, to); requestAnimationFrame(() => d.el.classList.remove('no-anim')); }
      else { d.el.classList.add('no-anim'); this.place(d.el, d.sq); requestAnimationFrame(() => d.el.classList.remove('no-anim')); }
      this.select(NO_SQ);
      return;
    }
    // Snap back
    this.place(d.el, d.sq);
    if (to === d.sq) return; // keep selected
    this.select(NO_SQ);
  }

  // ---- Promotion -------------------------------------------------------------
  private showPromo(from: number, to: number): void {
    this.pendingPromo = { from, to };
    const color = this.pos.side;
    const { x } = this.xy(to);
    const top = this.gridIndex(to) < 8; // target on the top row of the view
    const order = [QUEEN, KNIGHT, ROOK, BISHOP];
    let html = '';
    order.forEach((t, i) => {
      const y = top ? i * 100 : (7 - i) * 100;
      html += `<button type="button" class="promo-choice" data-promo="${t}" style="transform: translate(${x}%, ${y}%)" aria-label="Promote to ${['', 'pawn', 'knight', 'bishop', 'rook', 'queen'][t]}">${pieceSvg(makePiece(color, t))}</button>`;
    });
    this.promoEl.innerHTML = html;
    this.promoEl.hidden = false;
    this.root.classList.add('board--promo');
    this.promoEl.querySelectorAll<HTMLButtonElement>('.promo-choice').forEach((b) => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const promo = Number(b.dataset.promo);
        const m = this.findMove(from, to).find((mv) => movePromo(mv) === promo);
        this.cancelPromo();
        if (m) this.opts.onMove(m);
      });
    });
  }

  private cancelPromo(): void {
    if (!this.pendingPromo) return;
    this.pendingPromo = null;
    this.promoEl.hidden = true;
    this.promoEl.innerHTML = '';
    this.root.classList.remove('board--promo');
  }

  // Programmatic highlight of a square pair (e.g. hovering a move in the list).
  previewMove(m: number | null): void {
    const sqs = this.squaresEl.children;
    for (let i = 0; i < 64; i++) sqs[i].classList.remove('sq--preview');
    if (m === null || m === NO_MOVE) return;
    sqs[this.gridIndex(moveFrom(m))].classList.add('sq--preview');
    sqs[this.gridIndex(moveTo(m))].classList.add('sq--preview');
  }
}

export { sqName, moveIsCastle, KING };
