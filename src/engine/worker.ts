/// <reference lib="webworker" />
// Engine worker: owns a Position and a Search; answers UCI-like requests.
import { Position } from './board';
import { Search } from './search';
import type { PvLine } from './search';
import { parseUci, pvToSan } from './notation';
import { moveToUci } from './types';
import { evaluate } from './eval';
import type { WorkerRequest, WorkerResponse, GoRequest, SerializedLine } from './protocol';

const ctx: Worker = self as unknown as Worker;
let search = new Search(16);
let stopFlag: Int32Array | null = null;
let stopRequested = false;
let currentId = -1;

function post(msg: WorkerResponse): void {
  ctx.postMessage(msg);
}

function setupPosition(fen: string, moves: string[]): Position {
  // Keep the history buffer bounded: rebase onto a later FEN for very long games.
  let pos = new Position(fen);
  let list = moves;
  if (moves.length > 700) {
    const cut = moves.length - 120;
    for (let i = 0; i < cut; i++) {
      const m = parseUci(pos, moves[i]);
      if (!m) break;
      pos.makeMove(m);
    }
    pos = new Position(pos.fen());
    list = moves.slice(cut);
  }
  for (const u of list) {
    const m = parseUci(pos, u);
    if (!m) break;
    pos.makeMove(m);
  }
  return pos;
}

function serialize(pos: Position, line: PvLine): SerializedLine {
  return { ...line, pv: line.pv.map(moveToUci), san: pvToSan(pos, line.pv) };
}

function shouldStop(): boolean {
  if (stopRequested) return true;
  if (stopFlag && Atomics.load(stopFlag, 0) === 1) return true;
  return false;
}

function runGo(req: GoRequest): void {
  currentId = req.id;
  stopRequested = false;
  if (stopFlag) Atomics.store(stopFlag, 0, 0);
  const pos = setupPosition(req.fen, req.moves);
  const limits = { ...req.limits };
  const chunked = !stopFlag && req.chunkMs && !limits.movetime && limits.wtime === undefined && limits.nodes === undefined;
  if (!chunked) {
    const r = search.go(pos, limits, {
      onInfo: (l) => post({ type: 'info', id: req.id, line: serialize(pos, l) }),
      onProgress: (nodes, time, depth) => post({ type: 'progress', id: req.id, nodes, time, depth }),
      shouldStop,
    });
    post({
      type: 'bestmove', id: req.id, bestMove: moveToUci(r.bestMove), ponder: moveToUci(r.ponderMove),
      lines: r.lines.map((l) => serialize(pos, l)), depth: r.depth, nodes: r.nodes, time: r.time, stopped: shouldStop(),
    });
    return;
  }
  // Chunked infinite analysis: repeatedly search with a time slice; the TT keeps
  // progress so each slice quickly re-reaches the previous depth.
  const started = performance.now();
  let totalNodes = 0;
  let lastLines: SerializedLine[] = [];
  let lastDepth = 0;
  let bestDepthSeen = 0;
  const maxDepth = limits.depth ?? 64;
  const step = (): void => {
    if (currentId !== req.id || shouldStop() || bestDepthSeen >= maxDepth) {
      post({
        type: 'bestmove', id: req.id, bestMove: lastLines[0]?.pv[0] ?? '0000', ponder: lastLines[0]?.pv[1] ?? '0000',
        lines: lastLines, depth: lastDepth, nodes: totalNodes, time: performance.now() - started, stopped: true,
      });
      return;
    }
    const sliceMs = Math.min(req.chunkMs!, 1500) * Math.min(4, 1 + Math.floor(bestDepthSeen / 8));
    const r = search.go(pos, { ...limits, movetime: sliceMs }, {
      onInfo: (l) => {
        // Only report lines that improve on (or match) the best depth already shown.
        if (l.depth >= bestDepthSeen || l.multipv > 1) {
          bestDepthSeen = Math.max(bestDepthSeen, l.depth);
          const s = serialize(pos, l);
          s.nodes = totalNodes + l.nodes; s.time = performance.now() - started;
          s.nps = s.time > 0 ? Math.round((s.nodes * 1000) / s.time) : 0;
          post({ type: 'info', id: req.id, line: s });
        }
      },
      onProgress: (nodes, time, depth) => post({ type: 'progress', id: req.id, nodes: totalNodes + nodes, time: performance.now() - started, depth: Math.max(depth, bestDepthSeen) }),
      shouldStop,
    });
    totalNodes += r.nodes;
    if (r.depth >= lastDepth) { lastLines = r.lines.map((l) => serialize(pos, l)); lastDepth = r.depth; }
    setTimeout(step, 0);
  };
  step();
}

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      search = new Search(msg.hashMb);
      stopFlag = msg.stopFlag ?? null;
      post({ type: 'ready' });
      break;
    case 'newgame':
      search.newGame();
      break;
    case 'stop':
      stopRequested = true;
      currentId = -1;
      break;
    case 'go':
      runGo(msg);
      break;
    case 'eval': {
      const pos = setupPosition(msg.fen, msg.moves);
      post({ type: 'evalresult', id: msg.id, score: evaluate(pos) });
      break;
    }
  }
};

post({ type: 'ready' });
