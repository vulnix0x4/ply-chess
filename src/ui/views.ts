// Rendering helpers for the side panel: move tree, engine lines, eval chart,
// captured pieces and icons. Pure functions that return HTML strings.
import { Game, GameNode } from './game';
import type { SerializedLine } from '../engine/client';
import { NAG_GLYPHS } from '../engine/pgn';
import { Position } from '../engine/board';
import { WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, makePiece } from '../engine/types';
import { pieceSvg } from './pieces';

export const ICONS = {
  first: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6l-8 6 8 6V6zM6 6v12"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  last: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l8 6-8 6V6zM18 6v12"/></svg>',
  flip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h12l-3-3M20 16H8l3 3"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/></svg>',
  half: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 3v18"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
};

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function nagClass(n: number): string {
  if (n === 4) return 'n-blunder';
  if (n === 2) return 'n-mistake';
  if (n === 6) return 'n-inacc';
  if (n === 1 || n === 3) return 'n-good';
  return '';
}

function moveNo(node: GameNode, startPly: number, startMoveNo: number): { num: string; white: boolean } {
  const p = node.ply - 1 + startPly;
  const no = startMoveNo + Math.floor(p / 2);
  return { num: p % 2 === 0 ? `${no}.` : `${no}…`, white: p % 2 === 0 };
}

function moveHtml(node: GameNode, current: GameNode): string {
  const cls = ['mv'];
  if (node === current) cls.push('current');
  const nag = node.nags.find((n) => NAG_GLYPHS[n]);
  if (nag) cls.push(nagClass(nag));
  const glyph = nag ? `<span class="nag ${nagClass(nag)}">${NAG_GLYPHS[nag]}</span>` : '';
  return `<span class="${cls.join(' ')}" data-id="${node.id}" tabindex="0">${esc(node.san)}${glyph}</span>`;
}

// Renders the game tree with inline main line and indented variations.
export function renderMoves(game: Game): string {
  const startPly = game.startFen.split(' ')[1] === 'b' ? 1 : 0;
  const startMoveNo = parseInt(game.startFen.split(' ')[5] ?? '1', 10) || 1;
  const current = game.current;
  const renderLine = (first: GameNode, forceNum: boolean, depth: number): string => {
    let html = '';
    let n: GameNode | null = first;
    let needNum = forceNum;
    while (n) {
      const { num, white } = moveNo(n, startPly, startMoveNo);
      if (white || needNum) html += `<span class="num">${num}</span>`;
      html += moveHtml(n, current);
      needNum = false;
      if (n.comment) { html += `<span class="comment">${esc(n.comment)}</span>`; needNum = true; }
      const parent: GameNode = n.parent!;
      if (parent.children.length > 1 && parent.children[0] === n) {
        for (let k = 1; k < parent.children.length; k++) {
          html += `<span class="var">${renderLine(parent.children[k], true, depth + 1)}</span>`;
        }
        needNum = true;
      }
      n = n.children[0] ?? null;
    }
    return html;
  };
  if (!game.root.children[0]) return '<div class="moves-empty">No moves yet. Play on the board or import a PGN.</div>';
  const result = game.headers.get('Result');
  return `<div class="ml">${game.root.comment ? `<span class="comment">${esc(game.root.comment)}</span>` : ''}${renderLine(game.root.children[0], true, 0)}${result && result !== '*' ? `<span class="result-line">${result}</span>` : ''}</div>`;
}

export function formatScore(line: { scoreType: 'cp' | 'mate'; score: number }, fromWhite: boolean, sideToMove: number): { text: string; white: boolean } {
  let v = line.score;
  if (fromWhite && sideToMove === BLACK) v = -v;
  if (line.scoreType === 'mate') {
    if (v === 0) return { text: '#', white: true };
    return { text: `#${Math.abs(v)}`, white: v > 0 };
  }
  const pawns = v / 100;
  return { text: (pawns > 0 ? '+' : '') + pawns.toFixed(2), white: v >= 0 };
}

export function renderLines(lines: SerializedLine[], sideToMove: number, startMoveNo: number, startPly: number): string {
  if (lines.length === 0) return '<div class="engine-idle">Thinking…</div>';
  return lines.map((l) => {
    const s = formatScore(l, true, sideToMove);
    let pv = '';
    const plyOffset = startPly;
    for (let i = 0; i < l.san.length; i++) {
      const p = plyOffset + i;
      const no = startMoveNo + Math.floor(p / 2);
      if (p % 2 === 0) pv += `<span class="num">${no}.</span>`;
      else if (i === 0) pv += `<span class="num">${no}…</span>`;
      pv += `<span class="san">${esc(l.san[i])}</span>`;
    }
    return `<div class="line" data-pv="${l.pv.join(' ')}" title="Click to play this line" tabindex="0"><span class="score ${s.white ? '' : 'black'}">${s.text}</span><span class="pv">${pv}</span></div>`;
  }).join('');
}

// Win probability (0-100) for White from a centipawn score.
export function winPercent(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

export function evalToWhiteCp(ev: { type: 'cp' | 'mate'; value: number }): number {
  if (ev.type === 'cp') return ev.value;
  return ev.value > 0 ? 10000 : -10000;
}

export function renderChart(game: Game, width: number, height: number): string {
  const main = game.mainLine();
  const pts: { x: number; y: number; node: GameNode }[] = [];
  const n = main.length;
  if (n === 0) return '';
  const xs = (i: number) => (n <= 1 ? width / 2 : (i / (n - 1)) * width);
  let hasAny = false;
  main.forEach((node, i) => {
    if (!node.eval) return;
    hasAny = true;
    const wp = winPercent(Math.max(-1000, Math.min(1000, evalToWhiteCp(node.eval))));
    pts.push({ x: xs(i), y: height - (wp / 100) * height, node });
  });
  if (!hasAny) return '';
  // Build areas: white area is below the curve from the top? White advantage => more white.
  let path = `M0,${height / 2}`;
  let prevY = height / 2;
  for (const p of pts) { path += ` L${p.x.toFixed(1)},${p.y.toFixed(1)}`; prevY = p.y; }
  path += ` L${width},${prevY.toFixed(1)}`;
  const areaW = `${path} L${width},${height} L0,${height} Z`;
  const curIdx = main.indexOf(game.current);
  const cursor = curIdx >= 0 ? `<line class="cursor" x1="${xs(curIdx).toFixed(1)}" y1="0" x2="${xs(curIdx).toFixed(1)}" y2="${height}"/>` : '';
  const marks = main.map((node, i) => {
    const nag = node.nags.find((v) => v === 4 || v === 2);
    if (!nag || !node.eval) return '';
    const wp = winPercent(Math.max(-1000, Math.min(1000, evalToWhiteCp(node.eval))));
    return `<circle class="pt" cx="${xs(i).toFixed(1)}" cy="${(height - (wp / 100) * height).toFixed(1)}" r="${nag === 4 ? 3 : 2.2}" opacity="${nag === 4 ? 1 : 0.7}"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><rect class="area-b" x="0" y="0" width="${width}" height="${height}"/><path class="area-w" d="${areaW}"/><line class="zero" x1="0" y1="${height / 2}" x2="${width}" y2="${height / 2}"/>${marks}${cursor}</svg>`;
}

const VALUES = [0, 1, 3, 3, 5, 9, 0, 0];

// Captured pieces per side plus material balance, derived from the position.
export function renderCaptured(pos: Position, forColor: number): string {
  // Pieces captured by `forColor` = missing enemy pieces relative to the standard set.
  const enemy = forColor ^ 1;
  const start: Record<number, number> = { [PAWN]: 8, [KNIGHT]: 2, [BISHOP]: 2, [ROOK]: 2, [QUEEN]: 1 };
  let html = '';
  let mine = 0, theirs = 0;
  for (const t of [PAWN, KNIGHT, BISHOP, ROOK, QUEEN]) {
    const missing = Math.max(0, start[t] - pos.pieceCount[makePiece(enemy, t)]);
    for (let i = 0; i < missing; i++) html += `<span class="cap">${pieceSvg(makePiece(enemy, t))}</span>`;
    theirs += pos.pieceCount[makePiece(enemy, t)] * VALUES[t];
    mine += pos.pieceCount[makePiece(forColor, t)] * VALUES[t];
  }
  const diff = mine - theirs;
  return `<span class="captured">${html}</span>${diff > 0 ? `<span class="adv">+${diff}</span>` : ''}`;
}

export { WHITE };
