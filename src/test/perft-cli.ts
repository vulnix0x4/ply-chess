import { Position } from '../engine/board';
import { PERFT_POSITIONS } from './perft-positions';

const maxNodes = Number(process.argv[2] ?? 5_000_000);
let ok = true;
let total = 0;
const t0 = performance.now();
for (const p of PERFT_POSITIONS) {
  const pos = new Position(p.fen);
  for (let d = 1; d <= p.counts.length; d++) {
    if (p.counts[d - 1] > maxNodes) break;
    const t = performance.now();
    const n = pos.perft(d);
    total += n;
    const ms = performance.now() - t;
    const pass = n === p.counts[d - 1];
    if (!pass) ok = false;
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${p.name.padEnd(20)} depth ${d}: ${n} ${pass ? '' : `(expected ${p.counts[d - 1]})`} ${ms.toFixed(0)}ms`);
  }
}
const secs = (performance.now() - t0) / 1000;
console.log(`${ok ? 'ALL PASS' : 'FAILURES'} — ${total} nodes in ${secs.toFixed(2)}s (${(total / secs / 1e6).toFixed(2)} Mnps)`);
process.exit(ok ? 0 : 1);
