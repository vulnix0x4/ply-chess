# Ply — a complete chess platform in the browser

**Live:** https://ply-chess.lukewhaley.workers.dev

Ply is a chess engine and playing/analysis interface written from scratch in TypeScript. Everything runs client-side; the engine lives in a Web Worker.

## Run it

```bash
pnpm install
pnpm dev        # http://localhost:5173
pnpm test       # perft, notation, PGN and search test suites
pnpm perft      # perft against the standard reference positions
pnpm bench 10   # fixed-depth engine benchmark
pnpm build      # production build in dist/
pnpm deploy     # build and deploy to Cloudflare Workers (static assets)
```

## Engine (`src/engine`)

- `board.ts` — 0x88 board with piece lists, pseudo-legal move generation, make/unmake with incremental Zobrist hashing and tapered PST scores, FEN, perft. Verified exact against all seven reference perft positions (626 million nodes).
- `search.ts` — iterative deepening, aspiration windows, principal variation search, transposition table (`tt.ts`), null-move pruning with verification, reverse futility, futility and late-move pruning, late-move reductions, check extensions, killer/history/counter-move ordering, SEE-based capture ordering (`see.ts`), multi-PV, time management.
- `eval.ts` — tapered material/PST evaluation (PeSTO tables) with cached pawn structure, mobility, king safety, passed pawns, bishop pair, rook files and drawish endgame scaling.
- `notation.ts`, `pgn.ts` — SAN/UCI, PGN import/export with variations, comments and NAGs.
- `worker.ts`, `client.ts` — worker protocol; immediate stop via a SharedArrayBuffer flag when cross-origin isolated, chunked searching otherwise.

## Interface (`src/ui`)

Play against the computer at ten levels with clocks, watch engine vs engine, or use the analysis board with multi-PV lines, best-move arrows, an evaluation bar and chart, opening names, user-drawn arrows, variations with promote/delete, PGN/FEN import and export, game review with accuracy and blunder marking, synthesised sounds, light/dark themes and six board colour schemes. Keyboard: arrows navigate, Space toggles analysis, F flips, N starts a new game, Cmd/Ctrl+Z takes back.
