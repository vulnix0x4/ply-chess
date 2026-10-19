import { describe, it, expect } from 'vitest';
import { Position } from '../engine/board';
import { PERFT_POSITIONS } from './perft-positions';

describe('perft', () => {
  for (const p of PERFT_POSITIONS) {
    it(p.name, () => {
      const pos = new Position(p.fen);
      for (let d = 1; d <= p.counts.length; d++) {
        if (p.counts[d - 1] > 5_000_000) break;
        expect(pos.perft(d), `${p.name} depth ${d}`).toBe(p.counts[d - 1]);
      }
      // Position must be unchanged after perft.
      expect(pos.fen()).toBe(new Position(p.fen).fen());
    });
  }
});
