import { describe, it, expect } from 'vitest';
import { Position } from '../engine/board';
import { moveToSan, parseSan, parseUci, moveToUci } from '../engine/notation';
import { STARTPOS_FEN } from '../engine/types';

describe('FEN', () => {
  it('round-trips standard positions', () => {
    const fens = [
      STARTPOS_FEN,
      'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
      'rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2',
      '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
      'rnbqkbnr/pp1ppppp/8/2pP4/8/8/PPP1PPPP/RNBQKBNR b KQkq - 0 2',
    ];
    for (const f of fens) expect(new Position(f).fen()).toBe(f);
  });
  it('drops en passant squares that cannot be captured', () => {
    const p = new Position('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
    expect(p.fen()).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  });
  it('rejects garbage', () => {
    expect(new Position().setFen('this is not a fen')).toBe(false);
    expect(new Position().setFen('8/8/8/8/8/8/8/8 w - - 0 1')).toBe(false);
  });
});

describe('SAN', () => {
  it('generates and parses the Italian game', () => {
    const p = new Position();
    const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd4', 'exd4', 'cxd4', 'Bb4+', 'Nc3', 'Nxe4', 'O-O', 'Bxc3', 'd5', 'Bf6'];
    for (const s of sans) {
      const m = parseSan(p, s);
      expect(m, s).not.toBe(0);
      expect(moveToSan(p, m)).toBe(s);
      expect(p.makeMove(m)).toBe(true);
    }
  });
  it('disambiguates by file, rank and both', () => {
    // Two knights can reach d2: Nbd2 / Nfd2
    const p = new Position('r1bqkb1r/pppp1ppp/2n2n2/4p3/4P3/8/PPPPNPPP/RNBQKB1R w KQkq - 0 1');
    expect(parseSan(p, 'Nc3')).toBe(0); // ambiguous
    expect(moveToSan(p, parseSan(p, 'Nec3'))).toBe('Nec3');
    expect(moveToSan(p, parseSan(p, 'Nbc3'))).toBe('Nbc3');
    // Rooks on a1 and a3 both to a2 -> rank disambiguation
    const p2 = new Position('4k3/8/8/8/8/R7/8/R3K3 w - - 0 1');
    expect(moveToSan(p2, parseSan(p2, 'R1a2'))).toBe('R1a2');
    expect(moveToSan(p2, parseSan(p2, 'R3a2'))).toBe('R3a2');
    // Three queens: full disambiguation needed
    const p3 = new Position('4k3/8/8/8/8/8/QQ6/Q3K3 w - - 0 1');
    expect(moveToSan(p3, parseSan(p3, 'Qa1b1'))).toBe('Q1b1');
    expect(moveToSan(p3, parseSan(p3, 'Qb2b1'))).toBe('Qbb1');
    const p4 = new Position('4k3/8/8/8/8/8/Q1Q5/Q3K3 w - - 0 1');
    expect(moveToSan(p4, parseSan(p4, 'Qa2b1'))).toBe('Qa2b1');
  });
  it('marks check and mate, promotions and en passant', () => {
    const p = new Position('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1');
    expect(moveToSan(p, parseSan(p, 'Rd8'))).toBe('Rd8#');
    const q = new Position('8/P6k/8/8/8/8/8/K7 w - - 0 1');
    expect(moveToSan(q, parseUci(q, 'a7a8q'))).toBe('a8=Q');
    expect(moveToSan(q, parseUci(q, 'a7a8n'))).toBe('a8=N');
    const ep = new Position('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3');
    const m = parseSan(ep, 'exf6');
    expect(moveToUci(m)).toBe('e5f6');
    expect(moveToSan(ep, m)).toBe('exf6');
  });
  it('accepts sloppy input', () => {
    const p = new Position();
    expect(moveToSan(p, parseSan(p, 'e2-e4'.replace('-', '').slice(2)))).toBe('e4');
    expect(parseSan(p, 'Nf3!?')).not.toBe(0);
    expect(parseSan(p, 'Ngf3')).not.toBe(0);
    expect(parseSan(p, 'Ng1f3+')).not.toBe(0);
    const c = new Position('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    expect(moveToSan(c, parseSan(c, '0-0-0'))).toBe('O-O-O');
  });
});

describe('draw rules', () => {
  it('detects repetition and insufficient material', () => {
    const p = new Position('4k3/8/8/8/8/8/8/4K2R w - - 0 1');
    const seq = ['Rh2', 'Kd8', 'Rh1', 'Ke8', 'Rh2', 'Kd8', 'Rh1', 'Ke8'];
    for (const s of seq) p.makeMove(parseSan(p, s));
    expect(p.repetitionCount()).toBe(2);
    expect(new Position('4k3/8/8/8/8/8/8/4KB2 w - - 0 1').insufficientMaterial()).toBe(true);
    expect(new Position('4k3/8/8/8/8/8/8/4KBB1 w - - 0 1').insufficientMaterial()).toBe(false);
    expect(new Position('4kb2/8/8/8/8/8/8/4KB2 w - - 0 1').insufficientMaterial()).toBe(false);
    expect(new Position('2b1k3/8/8/8/8/8/8/4KB2 w - - 0 1').insufficientMaterial()).toBe(true);
  });
});
