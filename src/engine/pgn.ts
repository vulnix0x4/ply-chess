// PGN import/export for the game tree, including variations, comments and NAGs.
import { Game, GameNode } from '../ui/game';
import { Position } from './board';
import { parseSan } from './notation';
import { STARTPOS_FEN } from './types';

export const NAG_GLYPHS: Record<number, string> = {
  1: '!', 2: '?', 3: '!!', 4: '??', 5: '!?', 6: '?!', 7: '□', 10: '=', 13: '∞', 14: '⩲', 15: '⩱', 16: '±', 17: '∓', 18: '+−', 19: '−+',
};

type Token = { t: 'tag'; k: string; v: string } | { t: 'move'; s: string } | { t: 'num' } | { t: 'nag'; n: number } | { t: 'comment'; s: string } | { t: 'open' } | { t: 'close' } | { t: 'result'; s: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') { i++; continue; }
    if (c === '[') {
      const end = src.indexOf(']', i);
      if (end < 0) break;
      const m = /^\[\s*(\w+)\s+"((?:[^"\\]|\\.)*)"\s*\]$/.exec(src.slice(i, end + 1));
      if (m) out.push({ t: 'tag', k: m[1], v: m[2].replace(/\\(["\\])/g, '$1') });
      i = end + 1; continue;
    }
    if (c === '{') {
      const end = src.indexOf('}', i);
      out.push({ t: 'comment', s: src.slice(i + 1, end < 0 ? n : end).replace(/\s+/g, ' ').trim() });
      i = end < 0 ? n : end + 1; continue;
    }
    if (c === ';') { const end = src.indexOf('\n', i); out.push({ t: 'comment', s: src.slice(i + 1, end < 0 ? n : end).trim() }); i = end < 0 ? n : end + 1; continue; }
    if (c === '(') { out.push({ t: 'open' }); i++; continue; }
    if (c === ')') { out.push({ t: 'close' }); i++; continue; }
    if (c === '$') { let j = i + 1; while (j < n && src[j] >= '0' && src[j] <= '9') j++; out.push({ t: 'nag', n: parseInt(src.slice(i + 1, j), 10) || 0 }); i = j; continue; }
    // Word
    let j = i;
    while (j < n && !' \n\r\t{}()[;'.includes(src[j])) j++;
    const w = src.slice(i, j);
    i = j;
    if (w === '1-0' || w === '0-1' || w === '1/2-1/2' || w === '*') { out.push({ t: 'result', s: w }); continue; }
    if (/^\d+\.*$/.test(w)) { out.push({ t: 'num' }); continue; }
    if (/^\.+$/.test(w)) continue;
    // Move possibly glued to move number like "1.e4"
    const glued = /^(\d+)\.+(.+)$/.exec(w);
    const mv = glued ? glued[2] : w;
    if (mv === '!' || mv === '?' || mv === '!!' || mv === '??' || mv === '!?' || mv === '?!') {
      const nag = { '!': 1, '?': 2, '!!': 3, '??': 4, '!?': 5, '?!': 6 }[mv]!;
      out.push({ t: 'nag', n: nag }); continue;
    }
    const sufMatch = /^(.*?)([!?]+)$/.exec(mv);
    if (sufMatch && sufMatch[1]) {
      out.push({ t: 'move', s: sufMatch[1] });
      const nag = { '!': 1, '?': 2, '!!': 3, '??': 4, '!?': 5, '?!': 6 }[sufMatch[2]];
      if (nag) out.push({ t: 'nag', n: nag });
      continue;
    }
    out.push({ t: 'move', s: mv });
  }
  return out;
}

export interface PgnParseResult { game: Game; errors: string[] }

// Parses the first game in a PGN string into a Game tree.
export function parsePgn(src: string): PgnParseResult {
  const tokens = tokenize(src);
  const errors: string[] = [];
  const headers = new Map<string, string>();
  let i = 0;
  while (i < tokens.length && tokens[i].t === 'tag') { const t = tokens[i] as { k: string; v: string }; headers.set(t.k, t.v); i++; }
  const fen = headers.get('FEN') && headers.get('SetUp') !== '0' ? headers.get('FEN')! : STARTPOS_FEN;
  const game = new Game(fen);
  if (!new Position().setFen(fen)) { errors.push('Invalid FEN header'); return { game: new Game(), errors }; }
  for (const [k, v] of headers) game.headers.set(k, v);

  // Recursive descent over the movetext.
  type Frame = { node: GameNode };
  const stack: Frame[] = [];
  let node: GameNode = game.root;
  let pendingComment: string | null = null;
  for (; i < tokens.length; i++) {
    const tk = tokens[i];
    switch (tk.t) {
      case 'tag': break; // a second game begins; ignore
      case 'num': break;
      case 'comment':
        if (node === game.root && node.children.length === 0 && !pendingComment) { node.comment = tk.s; }
        else node.comment = node.comment ? node.comment + ' ' + tk.s : tk.s;
        break;
      case 'nag': node.nags.push(tk.n); break;
      case 'result': game.headers.set('Result', tk.s); break;
      case 'open':
        // A variation starts from the parent of the last played move.
        if (!node.parent) { errors.push('Variation before any move'); break; }
        stack.push({ node });
        node = node.parent;
        break;
      case 'close':
        if (stack.length === 0) { errors.push('Unbalanced parenthesis'); break; }
        node = stack.pop()!.node;
        break;
      case 'move': {
        const pos = new Position(node.fen);
        const m = parseSan(pos, tk.s);
        if (!m) { errors.push(`Illegal or unknown move "${tk.s}" at ply ${node.ply + 1}`); i = skipToEnd(tokens, i); break; }
        node = game.play(m, node);
        break;
      }
    }
  }
  void pendingComment;
  game.current = game.root;
  return { game, errors };
}

function skipToEnd(tokens: Token[], i: number): number {
  // After an unreadable move, abandon the rest of the current variation.
  let depth = 0;
  for (let j = i + 1; j < tokens.length; j++) {
    if (tokens[j].t === 'open') depth++;
    else if (tokens[j].t === 'close') { if (depth === 0) return j - 1; depth--; }
  }
  return tokens.length;
}

export function toPgn(game: Game, opts: { comments?: boolean; variations?: boolean; evals?: boolean } = {}): string {
  const comments = opts.comments ?? true, variations = opts.variations ?? true;
  const order = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];
  const lines: string[] = [];
  for (const k of order) lines.push(`[${k} "${(game.headers.get(k) ?? (k === 'Result' ? '*' : '?')).replace(/["\\]/g, '\\$&')}"]`);
  for (const [k, v] of game.headers) if (!order.includes(k)) lines.push(`[${k} "${v.replace(/["\\]/g, '\\$&')}"]`);
  const tokens: string[] = [];
  const startPly = game.root.ply + (game.startFen.split(' ')[1] === 'b' ? 1 : 0);
  const startMoveNo = parseInt(game.startFen.split(' ')[5] ?? '1', 10) || 1;
  const moveNumber = (node: GameNode): string => {
    const plyFromStart = node.ply - 1 + startPly;
    const no = startMoveNo + Math.floor(plyFromStart / 2);
    return plyFromStart % 2 === 0 ? `${no}.` : `${no}...`;
  };
  if (comments && game.root.comment) tokens.push(`{ ${game.root.comment} }`);
  const emit = (node: GameNode, forceNumber: boolean): void => {
    // node is the first move of a line; iterate through first-children while emitting siblings as variations.
    let n: GameNode | null = node;
    let needNumber = forceNumber;
    while (n) {
      const isWhite = ((n.ply - 1 + startPly) % 2) === 0;
      if (isWhite || needNumber) tokens.push(moveNumber(n));
      let s = n.san;
      for (const nag of n.nags) if (NAG_GLYPHS[nag] && nag <= 6) s += NAG_GLYPHS[nag];
      tokens.push(s);
      for (const nag of n.nags) if (nag > 6) tokens.push('$' + nag);
      if (opts.evals && n.eval) tokens.push(`{ [%eval ${n.eval.type === 'cp' ? (n.eval.value / 100).toFixed(2) : '#' + n.eval.value}] }`);
      needNumber = false;
      if (comments && n.comment) { tokens.push(`{ ${n.comment} }`); needNumber = true; }
      const parent: GameNode = n.parent!;
      if (variations && parent.children.length > 1 && parent.children[0] === n) {
        for (let k = 1; k < parent.children.length; k++) {
          tokens.push('(');
          emit(parent.children[k], true);
          tokens.push(')');
        }
        needNumber = true;
      }
      n = n.children[0] ?? null;
    }
  };
  if (game.root.children[0]) emit(game.root.children[0], true);
  tokens.push(game.headers.get('Result') ?? '*');
  // Wrap at ~80 columns.
  const body: string[] = [];
  let line = '';
  let glue = false; // no space after '('
  for (const t of tokens) {
    const sep = line === '' || glue || t === ')' ? '' : ' ';
    if (line.length + t.length + sep.length > 80 && line.length > 0 && t !== ')') { body.push(line); line = t; }
    else line = line + sep + t;
    glue = t === '(';
  }
  if (line) body.push(line);
  return lines.join('\n') + '\n\n' + body.join('\n') + '\n';
}
