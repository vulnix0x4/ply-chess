import { describe, it, expect } from 'vitest';
import { Position } from '../engine/board';
import { Search } from '../engine/search';
import { moveToSan, parseSan } from '../engine/notation';

const search = new Search(32);

function best(fen: string, limits: { depth?: number; movetime?: number }) {
  const pos = new Position(fen);
  search.newGame();
  const r = search.go(pos, limits);
  return { san: moveToSan(pos, r.bestMove), line: r.lines[0], r };
}

describe('mates', () => {
  it('finds mate in 1', () => {
    const a = best('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', { depth: 4 });
    expect(a.san).toBe('Rd8#');
    expect(a.line.scoreType).toBe('mate');
    expect(a.line.score).toBe(1);
    const b = best('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 0 4', { depth: 4 });
    expect(b.san).toBe('Qxf7#');
  });
  it('finds mate in 2 (Legal-style)', () => {
    const a = best('r2qkb1r/pp2nppp/3p4/2pNN1B1/2BnP3/3P4/PPP2PPP/R2bK2R w KQkq - 1 0', { depth: 6 });
    expect(a.san).toBe('Nf6+');
    expect(a.line.scoreType).toBe('mate');
    expect(a.line.score).toBe(2);
  });
  it('finds mate in 3', () => {
    // Philidor's legacy: Nf7+ Kg8 Nh6+ Kh8 Qg8+ Rxg8 Nf7#
    const a = best('r6k/6pp/8/6N1/8/1Q6/8/7K w - - 0 1', { depth: 10 });
    expect(a.line.scoreType).toBe('mate');
    expect(a.line.score).toBe(4);
    expect(a.san).toBe('Nf7+');
  });
  it('sees it is getting mated', () => {
    const a = best('6k1/5ppp/8/8/8/7P/5PP1/3r2K1 w - - 0 1', { depth: 6 });
    expect(a.san).toBe('Kh2');
    const b = best('6k1/5Q2/6K1/8/8/8/8/8 b - - 0 1', { depth: 6 });
    expect(b.line.scoreType).toBe('mate');
    expect(b.line.score).toBeLessThan(0);
  });
});

describe('search sanity', () => {
  it('returns a legal move in a position with one legal move', () => {
    const a = best('k7/8/1K6/8/8/8/8/R7 b - - 0 1', { movetime: 200 });
    expect(a.san).toBe('Kb8');
  });
  it('handles stalemate and checkmate roots', () => {
    const pos = new Position('6k1/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    expect(pos.legalMoves().length).toBe(1);
    const stale = new Position('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    expect(stale.legalMoves().length).toBe(0);
    const r = search.go(stale, { depth: 3 });
    expect(r.bestMove).toBe(0);
  });
  it('multi-pv returns distinct moves in order', () => {
    const pos = new Position();
    const r = search.go(pos, { depth: 7, multiPv: 3 });
    expect(r.lines.length).toBe(3);
    const moves = r.lines.map((l) => l.pv[0]);
    expect(new Set(moves).size).toBe(3);
    const s0 = r.lines[0].score, s1 = r.lines[1].score, s2 = r.lines[2].score;
    expect(s0).toBeGreaterThanOrEqual(s1);
    expect(s1).toBeGreaterThanOrEqual(s2);
  });
  it('respects movetime roughly', () => {
    const pos = new Position('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3');
    const t = performance.now();
    search.go(pos, { movetime: 300 });
    const dt = performance.now() - t;
    expect(dt).toBeLessThan(600);
  });
  it('prefers taking a free queen', () => {
    const a = best('rnb1kbnr/pppp1ppp/8/4p3/4P2q/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1', { depth: 5 });
    expect(a.san).toBe('Nxh4');
  });
  it('position is unchanged after a search', () => {
    const fen = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
    const pos = new Position(fen);
    search.go(pos, { depth: 6 });
    expect(pos.fen()).toBe(fen);
    expect(pos.hply).toBe(0);
  });
});

// Win At Chess (Fred Reinfeld) positions 1-19. The engine should solve nearly all within a short time.
const WAC: [string, string][] = [
  ['2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - 0 1', 'Qg6'],
  ['8/7p/5k2/5p2/p1p2P2/Pr1pPK2/1P1R3P/8 b - - 0 1', 'Rxb2'],
  ['5rk1/1ppb3p/p1pb4/6q1/3P1p1r/2P1R2P/PP1BQ1P1/5RKN w - - 0 1', 'Rg3'],
  ['r1bq2rk/pp3pbp/2p1p1pQ/7P/3P4/2PB1N2/PP3PPR/2KR4 w - - 0 1', 'Qxh7+'],
  ['5k2/6pp/p1qN4/1p1p4/3P4/2PKP2Q/PP3r2/3R4 b - - 0 1', 'Qc4+'],
  ['7k/p7/1R5K/6r1/6p1/6P1/8/8 w - - 0 1', 'Rb7'],
  ['rnbqkb1r/pppp1ppp/8/4P3/6n1/7P/PPPNPPP1/R1BQKBNR b KQkq - 0 1', 'Ne3'],
  ['r4q1k/p2bR1rp/2p2Q1N/5p2/5p2/2P5/PP3PPP/R5K1 w - - 0 1', 'Rf7'],
  ['3q1rk1/p4pp1/2pb3p/3p4/6Pr/1PNQ4/P1PB1PP1/4RRK1 b - - 0 1', 'Bh2+'],
  ['4k1r1/2p3r1/1pR1p3/3pP2p/3P2qP/P4N2/1PQ4P/5R1K b - - 0 1', 'Qxf3+'],
  ['5rk1/pp4p1/2n1p2p/2Npq3/2p5/6P1/P3P1BP/R4Q1K w - - 0 1', 'Qxf8+'],
  ['r2rb1k1/pp1q1p1p/2n1p1p1/2bp4/5P2/PP1BPR1Q/1BPN2PP/R5K1 w - - 0 1', 'Qxh7+'],
  ['1R6/1brk2p1/4p2p/p1P1pp1P/P1P5/2P3P1/8/4K1R1 w - - 0 1', 'Rxb7'],
  ['r4rk1/ppp2ppp/2n5/2bqp3/8/P2PB3/1PP1NPPP/R2Q1RK1 w - - 0 1', 'Nc3'],
  ['1k5r/pppbn1pp/4q1r1/1P3p2/2NPp3/1QP5/P4PPP/R1B1R1K1 w - - 0 1', 'Ne5'],
  ['R7/P4k2/8/8/8/8/r7/6K1 w - - 0 1', 'Rh8'],
  ['r1b2rk1/ppbn1ppp/4p3/1QP4q/3P4/N4N2/5PPP/R1B2RK1 w - - 0 1', 'c6'],
];

describe('tactics (WAC selection)', () => {
  it('solves at least 15 of 17 within 1.5s each', () => {
    let solved = 0;
    const failures: string[] = [];
    for (const [fen, bm] of WAC) {
      const pos = new Position(fen);
      const expected = parseSan(pos, bm);
      expect(expected, `${bm} is legal in ${fen}`).not.toBe(0);
      search.newGame();
      const r = search.go(pos, { movetime: 1500 });
      if (r.bestMove === expected) solved++; else failures.push(`${fen} expected ${bm} got ${moveToSan(pos, r.bestMove)}`);
    }
    if (failures.length) console.log('WAC misses:\n' + failures.join('\n'));
    console.log(`WAC solved ${solved}/${WAC.length}`);
    expect(solved).toBeGreaterThanOrEqual(15);
  });
});
