import { Position } from '../engine/board';
import { Search } from '../engine/search';
import { moveToSan } from '../engine/notation';

const depth = Number(process.argv[2] ?? 10);
const fens = [
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  'r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N2N2/PPQ1BPPP/R1B2RK1 w - - 0 1',
  '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
  'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
  '2r3k1/pppR1pp1/4p3/4P1P1/5P2/1P4K1/P1P5/8 w - - 0 1',
];
const search = new Search(64);
let totalNodes = 0, totalTime = 0;
for (const fen of fens) {
  const pos = new Position(fen);
  search.newGame();
  const r = search.go(pos, { depth });
  totalNodes += r.nodes; totalTime += r.time;
  const l = r.lines[0];
  console.log(`${fen.padEnd(72)} d${r.depth} ${l.scoreType === 'cp' ? (l.score / 100).toFixed(2) : 'M' + l.score} ${moveToSan(pos, r.bestMove).padEnd(6)} ${r.nodes} nodes ${(r.nodes / r.time).toFixed(0)} knps`);
}
console.log(`total ${totalNodes} nodes in ${(totalTime / 1000).toFixed(2)}s = ${(totalNodes / totalTime).toFixed(0)} knps`);
