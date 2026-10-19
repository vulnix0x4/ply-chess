import { describe, it, expect } from 'vitest';
import { parsePgn, toPgn } from '../engine/pgn';
import { Game } from '../ui/game';

const SAMPLE = `[Event "Casual game"]
[Site "Ply"]
[Date "2026.10.18"]
[Round "-"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 {The Ruy Lopez.} a6 (3... Nf6 4. O-O Nxe4 5. d4 (5. Re1 Nd6) 5... Nd6) 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 $1 10. d4 Nbd7 1-0
`;

describe('PGN', () => {
  it('parses tags, comments, NAGs and nested variations', () => {
    const { game, errors } = parsePgn(SAMPLE);
    expect(errors).toEqual([]);
    expect(game.headers.get('White')).toBe('Alice');
    expect(game.headers.get('Result')).toBe('1-0');
    const main = game.mainLine();
    expect(main.length).toBe(20);
    expect(main.map((n) => n.san).slice(0, 6)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']);
    expect(main[4].comment).toBe('The Ruy Lopez.');
    expect(main[17].nags).toEqual([1]);
    const bb5 = main[4];
    expect(bb5.children.length).toBe(2);
    const nf6 = bb5.children[1];
    expect(nf6.san).toBe('Nf6');
    const d4node = nf6.children[0].children[0].children[0]; // O-O Nxe4 d4
    expect(d4node.san).toBe('d4');
    expect(d4node.parent!.children.length).toBe(2);
    expect(d4node.parent!.children[1].san).toBe('Re1');
  });
  it('round-trips through toPgn', () => {
    const { game } = parsePgn(SAMPLE);
    const out = toPgn(game);
    const again = parsePgn(out);
    expect(again.errors).toEqual([]);
    expect(toPgn(again.game)).toBe(out);
    expect(out.replace(/\n/g, ' ')).toContain('3. Bb5 { The Ruy Lopez. } 3... a6 (3... Nf6 4. O-O Nxe4 5. d4 (5. Re1 Nd6) 5... Nd6) 4. Ba4');
    expect(out).toContain('Nb8!');
  });
  it('handles FEN setups and black-to-move starts', () => {
    const g = new Game('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 2 2');
    g.playSan('Nf6'); g.playSan('Bc4');
    const out = toPgn(g);
    expect(out).toContain('[SetUp "1"]');
    expect(out).toContain('2... Nf6 3. Bc4');
    const back = parsePgn(out);
    expect(back.errors).toEqual([]);
    expect(back.game.mainLine().map((n) => n.san)).toEqual(['Nf6', 'Bc4']);
  });
  it('reports illegal moves without crashing', () => {
    const { game, errors } = parsePgn('1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. Qxe5 Nxe5 1-0');
    expect(errors.length).toBe(1);
    expect(game.mainLine().length).toBe(6);
  });
  it('tolerates glued numbers, lichess-style clocks and results', () => {
    const { game, errors } = parsePgn('1.e4 { [%clk 0:05:00] } 1...c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 a6 *');
    expect(errors).toEqual([]);
    expect(game.mainLine().length).toBe(10);
  });
  it('promotes variations and deletes branches', () => {
    const { game } = parsePgn(SAMPLE);
    const bb5 = game.mainLine()[4];
    const nf6 = bb5.children[1];
    game.promoteVariation(nf6);
    expect(bb5.children[0]).toBe(nf6);
    expect(game.mainLine()[5].san).toBe('Nf6');
    game.deleteFrom(nf6);
    expect(bb5.children.length).toBe(1);
    expect(game.mainLine()[5].san).toBe('a6');
  });
});
