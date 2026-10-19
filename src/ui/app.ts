// Application controller: wires the board, game tree, engine, clocks, panel and dialogs.
import { Position } from '../engine/board';
import { EngineClient, SerializedLine } from '../engine/client';
import { parsePgn, toPgn } from '../engine/pgn';
import { parseSan, parseUci, moveToSan } from '../engine/notation';
import { WHITE, BLACK, NO_MOVE, STARTPOS_FEN, moveCaptured, moveIsCastle, movePromo, moveToUci } from '../engine/types';
import type { SearchLimits } from '../engine/search';
import { Board, Shape } from './board';
import { Game, GameNode, GameStatus } from './game';
import { Clock, TimeControl } from './clock';
import { SoundKit } from './sound';
import { Settings, loadSettings, saveSettings, loadJson, saveJson } from './storage';
import { findOpening, bookMoves } from './openings';
import { ICONS, esc, renderMoves, renderLines, renderChart, renderCaptured, formatScore, winPercent, evalToWhiteCp } from './views';

type Mode = 'analysis' | 'play' | 'watch';

interface PlaySetup {
  mode: Mode;
  humanColor: 0 | 1;
  level: number;        // vs engine
  levelWhite: number;   // engine vs engine
  levelBlack: number;
  tc: TimeControl | null;
  fen: string;
}

interface Outcome { result: '1-0' | '0-1' | '1/2-1/2'; reason: string }

const LEVEL_DESC = [
  '', 'Beginner — plays almost at random', 'Novice — one move ahead', 'Casual — sees simple tactics', 'Club — solid but fallible',
  'Strong club — short combinations', 'Expert — thinks about half a second', 'Master — one second per move', 'Grandmaster — two seconds',
  'Super-GM — four seconds', 'Maximum — uses the full clock',
];

const TC_PRESETS: { label: string; tc: TimeControl | null }[] = [
  { label: 'Unlimited', tc: null }, { label: '1+0', tc: { initial: 60, increment: 0 } }, { label: '3+2', tc: { initial: 180, increment: 2 } },
  { label: '5+0', tc: { initial: 300, increment: 0 } }, { label: '10+0', tc: { initial: 600, increment: 0 } }, { label: '15+10', tc: { initial: 900, increment: 10 } },
  { label: '30+0', tc: { initial: 1800, increment: 0 } },
];

export class App {
  root: HTMLElement;
  settings: Settings;
  game: Game = new Game();
  board!: Board;
  engine: EngineClient;
  sound = new SoundKit();
  clock = new Clock();
  mode: Mode = 'analysis';
  setup: PlaySetup = { mode: 'analysis', humanColor: WHITE, level: 5, levelWhite: 6, levelBlack: 6, tc: null, fen: STARTPOS_FEN };
  outcome: Outcome | null = null;
  analysisOn = false;
  lines: SerializedLine[] = [];
  analysisNode: GameNode | null = null;
  analysisInfo = { depth: 0, nodes: 0, nps: 0, time: 0 };
  engineThinking = false;
  engineRequestToken = 0;
  paused = false;
  reviewing = false;
  reviewProgress = 0;
  lastEvalCp: number | null = null;
  orientation: 0 | 1 = WHITE;
  els: Record<string, HTMLElement> = {};
  toastTimer: number | null = null;
  chartWidth = 360;
  drawOffered = false;
  gameStarted = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.settings = loadSettings();
    this.engine = new EngineClient(this.settings.hashMb);
    this.sound.enabled = this.settings.sound;
    this.buildDom();
    this.applyTheme();
    this.board = new Board(this.els.board, {
      onMove: (m) => this.userMove(m),
    });
    this.board.animate = this.settings.animate;
    this.board.showLegal = this.settings.showLegal;
    this.board.showCoords = this.settings.showCoords;
    this.board.showLast = this.settings.highlightLast;
    this.clock.onTick = () => this.renderClocks();
    this.clock.onFlag = (side) => this.onFlag(side);
    this.game.subscribe(() => this.onGameChange());
    this.bindEvents();
    this.restoreSession();
    this.render();
    if (this.settings.autoAnalysis && this.mode === 'analysis') this.setAnalysis(true);
    window.addEventListener('beforeunload', () => this.persistSession());
  }

  // ---- DOM --------------------------------------------------------------------
  private buildDom(): void {
    this.root.innerHTML = `
      <header class="topbar">
        <div class="brand"><div class="brand-mark"><i></i><i></i><i></i><i></i></div><span class="brand-name">Ply</span><span class="brand-sub">chess, entirely in your browser</span></div>
        <div class="topbar-actions">
          <button class="btn btn--primary" data-act="new">${ICONS.plus}<span>New game</span></button>
          <button class="btn" data-act="analysis-board" title="Open an empty analysis board">${ICONS.search}<span class="label-lg">Analysis</span></button>
          <button class="btn btn--icon" data-act="flip" title="Flip board (F)">${ICONS.flip}</button>
          <button class="btn btn--icon" data-act="pgn" title="Import / export PGN & FEN">${ICONS.file}</button>
          <button class="btn btn--icon" data-act="settings" title="Settings">${ICONS.gear}</button>
          <button class="btn btn--icon" data-act="help" title="Keyboard shortcuts & help">${ICONS.help}</button>
        </div>
      </header>
      <main class="layout">
        <section class="board-area">
          <div class="player-strip top" data-strip="top"></div>
          <div class="board-row">
            <div class="evalbar" data-el="evalbar"><div class="fill" style="height:50%"></div><div class="mid"></div><div class="label top"></div><div class="label bottom"></div></div>
            <div class="board-wrap"><div data-el="board"></div><div data-el="banner"></div></div>
          </div>
          <div class="player-strip bottom" data-strip="bottom"></div>
        </section>
        <aside class="panel">
          <div class="card engine-box">
            <div class="card-head">
              <h2>Engine</h2>
              <span class="engine-status" data-el="engine-status"></span>
              <span class="spacer"></span>
              <button class="switch" role="switch" aria-checked="false" data-act="toggle-analysis" title="Toggle analysis (Space)"></button>
            </div>
            <div class="lines" data-el="lines"></div>
            <div class="opening" data-el="opening"></div>
          </div>
          <div class="card moves-card">
            <div class="status-line" data-el="status" style="border-top:0;border-bottom:1px solid var(--border)"></div>
            <div class="moves" data-el="moves"></div>
            <div class="chart" data-el="chart" hidden></div>
            <div class="review" data-el="review" hidden></div>
            <div class="progress" data-el="progress" hidden><i style="width:0%"></i></div>
            <div class="nav">
              <button class="btn btn--icon" data-act="first" title="First move (↑)">${ICONS.first}</button>
              <button class="btn btn--icon" data-act="prev" title="Previous move (←)">${ICONS.prev}</button>
              <button class="btn btn--icon" data-act="next" title="Next move (→)">${ICONS.next}</button>
              <button class="btn btn--icon" data-act="last" title="Last move (↓)">${ICONS.last}</button>
            </div>
            <div class="actions" data-el="actions"></div>
          </div>
        </aside>
      </main>
      <div class="toast" data-el="toast"></div>
      ${this.dialogsHtml()}`;
    this.root.querySelectorAll<HTMLElement>('[data-el]').forEach((el) => { this.els[el.dataset.el!] = el; });
    this.els.stripTop = this.root.querySelector('[data-strip="top"]')!;
    this.els.stripBottom = this.root.querySelector('[data-strip="bottom"]')!;
  }

  private dialogsHtml(): string {
    const swatches = [['walnut', '#ecd9b9', '#a87a4e'], ['slate', '#d8dee9', '#6b7f99'], ['forest', '#eeeed2', '#769656'], ['ivory', '#f0e9df', '#8f867a'], ['ocean', '#dbe7f0', '#4f7ea1'], ['rose', '#f1e2dc', '#a86a69']]
      .map(([k, l, d]) => `<button class="swatch" data-board="${k}" title="${k}" style="--l:${l};--d:${d}"><i></i><i></i><i></i><i></i></button>`).join('');
    return `
      <dialog data-dlg="new">
        <form method="dialog">
          <div class="dlg-head"><h2>New game</h2></div>
          <div class="dlg-body">
            <div class="field"><span class="lbl">Mode</span>
              <div class="seg" data-field="mode">
                <button type="button" data-v="play" aria-pressed="true">Play vs computer</button>
                <button type="button" data-v="analysis">Analysis board</button>
                <button type="button" data-v="watch">Computer vs computer</button>
              </div>
            </div>
            <div class="field" data-show="play"><span class="lbl">Play as</span>
              <div class="seg" data-field="color">
                <button type="button" data-v="white" aria-pressed="true">White</button>
                <button type="button" data-v="black">Black</button>
                <button type="button" data-v="random">Random</button>
              </div>
            </div>
            <div class="field" data-show="play"><label>Computer strength <span class="level-val" data-el="level-val">5</span></label>
              <input type="range" min="1" max="10" value="5" data-field="level" />
              <div class="level-desc" data-el="level-desc">${LEVEL_DESC[5]}</div>
            </div>
            <div class="field" data-show="watch"><label>White engine level <span class="level-val" data-el="lw-val">6</span></label><input type="range" min="1" max="10" value="6" data-field="levelWhite" /></div>
            <div class="field" data-show="watch"><label>Black engine level <span class="level-val" data-el="lb-val">6</span></label><input type="range" min="1" max="10" value="6" data-field="levelBlack" /></div>
            <div class="field" data-show="play watch"><span class="lbl">Time control</span>
              <div class="seg" data-field="tc">${TC_PRESETS.map((p, i) => `<button type="button" data-v="${i}" aria-pressed="${i === 0}">${p.label}</button>`).join('')}</div>
              <div class="row" data-el="tc-custom" hidden></div>
            </div>
            <div class="field"><label>Start position (FEN, optional)</label><input type="text" data-field="fen" placeholder="Leave empty for the standard start position" spellcheck="false" /></div>
          </div>
          <div class="dlg-foot"><button class="btn" value="cancel">Cancel</button><button class="btn btn--primary" value="ok" data-act="start-game">Start</button></div>
        </form>
      </dialog>
      <dialog data-dlg="settings">
        <form method="dialog">
          <div class="dlg-head"><h2>Settings</h2></div>
          <div class="dlg-body">
            <div class="field"><span class="lbl">Appearance</span>
              <div class="seg" data-field="theme"><button type="button" data-v="system">System</button><button type="button" data-v="dark">Dark</button><button type="button" data-v="light">Light</button></div>
            </div>
            <div class="field"><span class="lbl">Board</span><div class="swatches" data-field="boardTheme">${swatches}</div></div>
            <div class="field"><span class="lbl">Board options</span>
              <label class="chk"><input type="checkbox" data-field="showLegal" /> Show legal moves</label>
              <label class="chk"><input type="checkbox" data-field="showCoords" /> Show coordinates</label>
              <label class="chk"><input type="checkbox" data-field="highlightLast" /> Highlight last move</label>
              <label class="chk"><input type="checkbox" data-field="animate" /> Animate pieces</label>
              <label class="chk"><input type="checkbox" data-field="sound" /> Sounds</label>
            </div>
            <div class="field"><span class="lbl">Engine</span>
              <label class="chk"><input type="checkbox" data-field="autoAnalysis" /> Analyse automatically on the analysis board</label>
              <label class="chk"><input type="checkbox" data-field="showBestArrow" /> Show best-move arrows</label>
              <label class="chk"><input type="checkbox" data-field="evalBar" /> Show evaluation bar</label>
              <label>Lines shown <span class="level-val" data-el="mpv-val"></span></label>
              <input type="range" min="1" max="5" data-field="multiPv" />
              <label>Hash table (MB)</label>
              <select data-field="hashMb"><option>16</option><option>32</option><option>64</option><option>128</option><option>256</option></select>
              <div class="hint-text">Larger hash helps deep analysis. Applies to new searches.</div>
            </div>
          </div>
          <div class="dlg-foot"><button class="btn btn--primary" value="ok">Done</button></div>
        </form>
      </dialog>
      <dialog data-dlg="pgn">
        <form method="dialog">
          <div class="dlg-head"><h2>PGN &amp; FEN</h2></div>
          <div class="dlg-body">
            <div class="field"><label>FEN</label><div class="row"><input type="text" data-field="fen" spellcheck="false" style="font-family:var(--mono);font-size:12.5px" /><button type="button" class="btn btn--sm" data-act="copy-fen">${ICONS.copy}Copy</button><button type="button" class="btn btn--sm" data-act="load-fen">Load</button></div></div>
            <div class="field"><label>PGN</label><textarea data-field="pgn" spellcheck="false"></textarea><div class="hint-text" data-el="pgn-msg"></div></div>
          </div>
          <div class="dlg-foot"><button type="button" class="btn" data-act="copy-pgn">${ICONS.copy}Copy PGN</button><button type="button" class="btn" data-act="download-pgn">Download</button><button type="button" class="btn btn--primary" data-act="load-pgn">Import PGN</button><button class="btn" value="cancel">Close</button></div>
        </form>
      </dialog>
      <dialog data-dlg="confirm" style="width:min(92vw,360px)">
        <form method="dialog">
          <div class="dlg-body"><p style="margin:4px 0" data-el="confirm-text"></p></div>
          <div class="dlg-foot"><button class="btn" value="cancel">Cancel</button><button class="btn btn--primary" value="ok" data-el="confirm-ok">OK</button></div>
        </form>
      </dialog>
      <dialog data-dlg="help">
        <form method="dialog">
          <div class="dlg-head"><h2>Help</h2></div>
          <div class="dlg-body">
            <div class="help-list">
              <span><span class="kbd">←</span> <span class="kbd">→</span></span><span>Step through moves</span>
              <span><span class="kbd">↑</span> <span class="kbd">↓</span></span><span>Jump to start / end</span>
              <span><span class="kbd">Space</span></span><span>Toggle engine analysis</span>
              <span><span class="kbd">F</span></span><span>Flip the board</span>
              <span><span class="kbd">N</span></span><span>New game</span>
              <span><span class="kbd">⌘/Ctrl</span> <span class="kbd">Z</span></span><span>Take back (vs computer)</span>
              <span><span class="kbd">Esc</span></span><span>Deselect / close dialog</span>
              <span>Right-drag</span><span>Draw arrows (Shift / Alt for colours); right-click a square to circle it</span>
              <span>Click a line</span><span>Play the engine's suggested variation on the board</span>
            </div>
            <p class="hint-text">Ply runs a hand-written chess engine inside a Web Worker: 0x88 board, alpha-beta search with transposition table, null-move and late-move pruning, tapered evaluation. Nothing leaves your browser.</p>
          </div>
          <div class="dlg-foot"><button class="btn btn--primary" value="ok">Close</button></div>
        </form>
      </dialog>`;
  }

  private dlg(name: string): HTMLDialogElement {
    return this.root.querySelector(`dialog[data-dlg="${name}"]`) as HTMLDialogElement;
  }

  // ---- Theme & settings -----------------------------------------------------------
  applyTheme(): void {
    const t = this.settings.theme;
    const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.board = this.settings.boardTheme;
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#121316' : '#f3f1ec');
  }

  private applySettings(): void {
    saveSettings(this.settings);
    this.applyTheme();
    this.sound.enabled = this.settings.sound;
    this.board.animate = this.settings.animate;
    this.board.showLegal = this.settings.showLegal;
    this.board.showCoords = this.settings.showCoords;
    this.board.showLast = this.settings.highlightLast;
    this.board.setOrientation(this.orientation); // re-render coords
    this.board.root.querySelector<HTMLElement>('.board-coords')!.hidden = !this.settings.showCoords;
    this.render();
    if (this.analysisOn) this.restartAnalysis();
  }

  // ---- Session persistence ---------------------------------------------------------
  private persistSession(): void {
    saveJson('ply.session.v1', { pgn: toPgn(this.game, { evals: true }), mode: this.mode, setup: this.setup, outcome: this.outcome, orientation: this.orientation, currentPath: this.game.uciPath() });
  }

  private restoreSession(): void {
    const s = loadJson<{ pgn: string; mode: Mode; setup: PlaySetup; outcome: Outcome | null; orientation: 0 | 1; currentPath: string[] } | null>('ply.session.v1', null);
    if (!s || !s.pgn) return;
    try {
      const { game } = parsePgn(s.pgn);
      if (game.mainLine().length === 0 && game.startFen === STARTPOS_FEN) return;
      this.swapGame(game);
      this.restoreEvalsFromComments();
      this.mode = s.mode ?? 'analysis';
      this.setup = { ...this.setup, ...(s.setup ?? {}) };
      this.outcome = s.outcome ?? null;
      this.orientation = s.orientation ?? WHITE;
      this.gameStarted = game.mainLine().length > 0;
      // Restore position in the tree.
      let node = game.root;
      for (const u of s.currentPath ?? []) { const c = node.children.find((x) => x.uci === u); if (!c) break; node = c; }
      game.current = node;
      if (this.mode === 'play' && !this.outcome && !this.game.status(this.lastNode()).over) {
        // A game in progress against the computer resumes without clocks.
        this.setup.tc = null;
      }
      if (this.mode === 'watch') this.mode = 'analysis';
    } catch { /* ignore corrupt session */ }
  }

  private restoreEvalsFromComments(): void {
    // Evals were written as "[%eval x]" comments; pull them back into node.eval.
    const walk = (n: GameNode) => {
      if (n.comment) {
        const m = /\[%eval (#?-?\d+(?:\.\d+)?)\]/.exec(n.comment);
        if (m) {
          const v = m[1];
          n.eval = v.startsWith('#') ? { type: 'mate', value: parseInt(v.slice(1), 10), depth: 0 } : { type: 'cp', value: Math.round(parseFloat(v) * 100), depth: 0 };
          n.comment = n.comment.replace(m[0], '').trim() || undefined;
        }
      }
      n.children.forEach(walk);
    };
    walk(this.game.root);
  }

  private swapGame(game: Game): void {
    this.game = game;
    this.game.subscribe(() => this.onGameChange());
  }

  // ---- Events ------------------------------------------------------------------------
  private bindEvents(): void {
    this.root.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (btn) { this.sound.unlock(); this.action(btn.dataset.act!, btn); return; }
      const mv = (e.target as HTMLElement).closest<HTMLElement>('.mv');
      if (mv) { const node = this.findNode(Number(mv.dataset.id)); if (node) this.game.goTo(node); return; }
      const line = (e.target as HTMLElement).closest<HTMLElement>('.line');
      if (line) { this.playPv(line.dataset.pv!.split(' ')); return; }
    });
    this.root.addEventListener('contextmenu', (e) => {
      const mv = (e.target as HTMLElement).closest<HTMLElement>('.mv');
      if (!mv) return;
      e.preventDefault();
      const node = this.findNode(Number(mv.dataset.id));
      if (!node) return;
      this.moveContextMenu(node, e.clientX, e.clientY);
    });
    this.els.chart.addEventListener('click', (e) => {
      const main = this.game.mainLine();
      if (!main.length) return;
      const r = this.els.chart.getBoundingClientRect();
      const i = Math.round(((e.clientX - r.left) / r.width) * (main.length - 1));
      this.game.goTo(main[Math.max(0, Math.min(main.length - 1, i))]);
    });
    document.addEventListener('keydown', (e) => this.onKey(e));
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());
    this.els.moves.addEventListener('mouseover', (e) => {
      const mv = (e.target as HTMLElement).closest<HTMLElement>('.mv');
      const node = mv ? this.findNode(Number(mv.dataset.id)) : null;
      this.board.previewMove(node && node !== this.game.current ? node.move : null);
    });
    this.els.moves.addEventListener('mouseleave', () => this.board.previewMove(null));
    // Dialog wiring
    this.bindNewGameDialog();
    this.bindSettingsDialog();
    this.bindPgnDialog();
    window.addEventListener('resize', () => this.renderChart());
  }

  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
    if (document.querySelector('dialog[open]')) { if (e.key === 'Escape') return; return; }
    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); this.game.back(); break;
      case 'ArrowRight': e.preventDefault(); this.game.forward(); break;
      case 'ArrowUp': e.preventDefault(); this.game.first(); break;
      case 'ArrowDown': e.preventDefault(); this.game.last(); break;
      case ' ': e.preventDefault(); this.setAnalysis(!this.analysisOn); break;
      case 'f': case 'F': this.action('flip'); break;
      case 'n': case 'N': this.action('new'); break;
      case 'Escape': this.board.clearUserShapes(); this.board.deselect(); break;
      case 'z': case 'Z': if (e.metaKey || e.ctrlKey) { e.preventDefault(); this.action('takeback'); } break;
    }
  }

  private action(act: string, el?: HTMLElement): void {
    switch (act) {
      case 'new': this.openNewGameDialog(); break;
      case 'analysis-board': this.startAnalysisBoard(); break;
      case 'flip': this.orientation = (this.orientation ^ 1) as 0 | 1; this.board.setOrientation(this.orientation); this.render(); break;
      case 'pgn': this.openPgnDialog(); break;
      case 'settings': this.openSettingsDialog(); break;
      case 'help': this.dlg('help').showModal(); break;
      case 'toggle-analysis': this.setAnalysis(!this.analysisOn); break;
      case 'first': this.game.first(); break;
      case 'prev': this.game.back(); break;
      case 'next': this.game.forward(); break;
      case 'last': this.game.last(); break;
      case 'takeback': this.takeback(); break;
      case 'resign': this.resign(); break;
      case 'draw': this.offerDraw(); break;
      case 'rematch': this.rematch(); break;
      case 'back-to-game': this.game.last(); break;
      case 'review': void this.reviewGame(); break;
      case 'pause': this.paused = !this.paused; if (!this.paused) this.engineTurnIfNeeded(); this.render(); break;
      case 'analyse-here': this.startAnalysisBoard(true); break;
      case 'promote-var': { const n = this.findNode(Number(el?.dataset.id)); if (n) this.game.promoteVariation(n); break; }
      case 'delete-var': { const n = this.findNode(Number(el?.dataset.id)); if (n) this.game.deleteFrom(n); break; }
      case 'close-banner': this.els.banner.innerHTML = ''; break;
    }
  }

  // ---- Game lifecycle ------------------------------------------------------------------
  private openNewGameDialog(): void {
    const d = this.dlg('new');
    (d.querySelector('[data-field="fen"]') as HTMLInputElement).value = '';
    d.showModal();
  }

  private bindNewGameDialog(): void {
    const d = this.dlg('new');
    const segs = d.querySelectorAll<HTMLElement>('.seg');
    segs.forEach((seg) => seg.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      if (seg.dataset.field === 'mode') this.updateNewGameVisibility();
    }));
    const level = d.querySelector('[data-field="level"]') as HTMLInputElement;
    level.addEventListener('input', () => { d.querySelector('[data-el="level-val"]')!.textContent = level.value; d.querySelector('[data-el="level-desc"]')!.textContent = LEVEL_DESC[Number(level.value)]; });
    const lw = d.querySelector('[data-field="levelWhite"]') as HTMLInputElement;
    const lb = d.querySelector('[data-field="levelBlack"]') as HTMLInputElement;
    lw.addEventListener('input', () => { d.querySelector('[data-el="lw-val"]')!.textContent = lw.value; });
    lb.addEventListener('input', () => { d.querySelector('[data-el="lb-val"]')!.textContent = lb.value; });
    d.addEventListener('close', () => {
      if (d.returnValue !== 'ok') return;
      const seg = (f: string) => d.querySelector<HTMLElement>(`.seg[data-field="${f}"] button[aria-pressed="true"]`)?.dataset.v ?? '';
      const mode = seg('mode') as Mode;
      const colorV = seg('color');
      const color: 0 | 1 = colorV === 'white' ? WHITE : colorV === 'black' ? BLACK : (Math.random() < 0.5 ? WHITE : BLACK);
      const tc = TC_PRESETS[Number(seg('tc'))]?.tc ?? null;
      const fenIn = (d.querySelector('[data-field="fen"]') as HTMLInputElement).value.trim();
      let fen = STARTPOS_FEN;
      if (fenIn) {
        if (new Position().setFen(fenIn)) fen = new Position(fenIn).fen(); else { this.toast('That FEN is not valid; using the standard start position.'); }
      }
      this.startGame({ mode, humanColor: color, level: Number(level.value), levelWhite: Number(lw.value), levelBlack: Number(lb.value), tc: mode === 'analysis' ? null : tc, fen });
    });
    this.updateNewGameVisibility();
  }

  private updateNewGameVisibility(): void {
    const d = this.dlg('new');
    const mode = d.querySelector<HTMLElement>('.seg[data-field="mode"] button[aria-pressed="true"]')?.dataset.v ?? 'play';
    d.querySelectorAll<HTMLElement>('[data-show]').forEach((el) => { el.hidden = !el.dataset.show!.split(' ').includes(mode); });
  }

  startGame(setup: PlaySetup): void {
    this.stopEverything();
    this.setup = setup;
    this.mode = setup.mode;
    this.outcome = null;
    this.drawOffered = false;
    this.paused = false;
    this.gameStarted = false;
    this.swapGame(new Game(setup.fen));
    this.engine.newGame();
    if (setup.mode === 'play') {
      this.game.headers.set('White', setup.humanColor === WHITE ? 'You' : `Ply level ${setup.level}`);
      this.game.headers.set('Black', setup.humanColor === BLACK ? 'You' : `Ply level ${setup.level}`);
      this.orientation = setup.humanColor;
    } else if (setup.mode === 'watch') {
      this.game.headers.set('White', `Ply level ${setup.levelWhite}`);
      this.game.headers.set('Black', `Ply level ${setup.levelBlack}`);
    } else {
      this.game.headers.set('White', 'White');
      this.game.headers.set('Black', 'Black');
    }
    if (setup.tc) this.game.headers.set('TimeControl', `${setup.tc.initial}+${setup.tc.increment}`);
    this.clock.reset(setup.tc);
    this.board.setOrientation(this.orientation);
    this.els.banner.innerHTML = '';
    this.render();
    if (setup.mode === 'analysis') { if (this.settings.autoAnalysis) this.setAnalysis(true); }
    else { this.setAnalysis(false); this.engineTurnIfNeeded(); }
    this.sound.play('notify');
  }

  private startAnalysisBoard(keepGame = false): void {
    this.stopEverything();
    this.mode = 'analysis';
    this.outcome = null;
    this.clock.reset(null);
    if (!keepGame) { this.swapGame(new Game()); this.engine.newGame(); }
    this.els.banner.innerHTML = '';
    this.render();
    if (this.settings.autoAnalysis) this.setAnalysis(true);
  }

  private rematch(): void {
    const s = { ...this.setup };
    if (s.mode === 'play') s.humanColor = (s.humanColor ^ 1) as 0 | 1;
    this.startGame(s);
  }

  private stopEverything(): void {
    this.engine.stop();
    this.engineThinking = false;
    this.engineRequestToken++;
    this.clock.stop();
    this.analysisOn = false;
    this.lines = [];
    this.reviewing = false;
    this.els.banner.innerHTML = '';
  }

  private lastNode(): GameNode {
    let n = this.game.root;
    while (n.children[0]) n = n.children[0];
    return n;
  }

  private atLiveEnd(): boolean {
    return this.game.current === this.lastNode();
  }

  // ---- Human move -------------------------------------------------------------------------
  private userMove(m: number): void {
    this.sound.unlock();
    if (this.mode === 'play' || this.mode === 'watch') {
      if (this.outcome || !this.atLiveEnd()) return;
      if (this.mode === 'watch') return;
      const pos = this.game.position();
      if (pos.side !== this.setup.humanColor) return;
    }
    const before = this.game.position();
    const node = this.game.play(m);
    this.afterMove(before, node);
    if (this.mode === 'play') {
      this.gameStarted = true;
      this.drawOffered = false;
      if (this.setup.tc) { if (this.clock.running === null) this.clock.start((before.side ^ 1) as 0 | 1); else this.clock.press(before.side as 0 | 1); }
      this.checkGameEnd();
      this.engineTurnIfNeeded();
    }
  }

  private afterMove(before: Position, node: GameNode): void {
    const after = this.game.position(node);
    const check = after.inCheck();
    if (moveIsCastle(node.move)) this.sound.play('castle');
    else if (movePromo(node.move)) this.sound.play('promote');
    else if (check) this.sound.play('check');
    else if (moveCaptured(node.move)) this.sound.play('capture');
    else this.sound.play('move');
    void before;
  }

  // ---- Engine play --------------------------------------------------------------------------
  private engineColorToMove(): boolean {
    if (this.mode === 'play') return this.game.position(this.lastNode()).side !== this.setup.humanColor;
    if (this.mode === 'watch') return true;
    return false;
  }

  private engineTurnIfNeeded(): void {
    if (this.mode === 'analysis' || this.outcome || this.paused || this.engineThinking) return;
    if (!this.engineColorToMove()) return;
    const node = this.lastNode();
    const status = this.game.status(node);
    if (status.over) { this.checkGameEnd(); return; }
    const pos = this.game.position(node);
    const level = this.mode === 'watch' ? (pos.side === WHITE ? this.setup.levelWhite : this.setup.levelBlack) : this.setup.level;
    const token = ++this.engineRequestToken;
    this.engineThinking = true;
    this.render();
    const started = performance.now();
    const finish = (uci: string | null): void => {
      if (token !== this.engineRequestToken) return;
      this.engineThinking = false;
      if (!uci) { this.render(); return; }
      const minDelay = this.mode === 'watch' ? 250 : 350;
      const wait = Math.max(0, minDelay - (performance.now() - started));
      setTimeout(() => {
        if (token !== this.engineRequestToken) return;
        const target = this.lastNode();
        const before = this.game.position(target);
        const m = parseUci(before, uci);
        if (!m) { this.render(); return; }
        const wasViewingEnd = this.atLiveEnd();
        const node = this.game.play(m, target);
        if (!wasViewingEnd) this.game.goTo(this.game.current === node ? node : node); // play() moved current; keep it at the new move
        this.afterMove(before, node);
        if (this.setup.tc) { if (this.clock.running === null) this.clock.start((before.side ^ 1) as 0 | 1); else this.clock.press(before.side as 0 | 1); }
        this.gameStarted = true;
        this.checkGameEnd();
        this.engineTurnIfNeeded();
      }, wait);
    };
    // Opening book for variety at level 3+ from the standard start position.
    if (level >= 3 && this.game.startFen === STARTPOS_FEN && node.ply < 16) {
      const sans = this.game.pathTo(node).map((n) => n.san);
      const book = bookMoves(sans);
      if (book.length && Math.random() < 0.85) {
        const san = book[Math.floor(Math.random() * book.length)];
        const m = parseSan(pos, san);
        if (m) { setTimeout(() => finish(moveToUci(m)), 150); return; }
      }
    }
    const limits = this.limitsForLevel(level, pos.side);
    const multiPv = level <= 4 ? 4 : 1;
    this.engine.go(pos.fen(), [], { ...limits, multiPv }, {
      onDone: (r) => {
        if (!r.lines.length || r.bestMove === '0000') { finish(null); return; }
        finish(this.chooseMoveForLevel(r.lines, level));
      },
    });
  }

  private limitsForLevel(level: number, side: number): SearchLimits {
    const tc = this.setup.tc;
    const myTime = this.clock.time[side];
    const inc = tc ? tc.increment * 1000 : 0;
    if (level >= 10 && tc) {
      return { wtime: side === WHITE ? myTime : this.clock.time[WHITE], btime: side === BLACK ? myTime : this.clock.time[BLACK], winc: inc, binc: inc };
    }
    let limits: SearchLimits;
    switch (level) {
      case 1: limits = { depth: 1 }; break;
      case 2: limits = { depth: 2 }; break;
      case 3: limits = { depth: 3 }; break;
      case 4: limits = { depth: 4 }; break;
      case 5: limits = { depth: 6 }; break;
      case 6: limits = { movetime: 500 }; break;
      case 7: limits = { movetime: 1000 }; break;
      case 8: limits = { movetime: 2000 }; break;
      case 9: limits = { movetime: 4000 }; break;
      default: limits = { movetime: 8000 }; break;
    }
    if (tc && limits.movetime) limits.movetime = Math.max(50, Math.min(limits.movetime, myTime / 25 + inc * 0.8));
    return limits;
  }

  // Weaker levels pick among the top lines with a temperature-based softmax.
  private chooseMoveForLevel(lines: SerializedLine[], level: number): string {
    const best = lines[0];
    if (level >= 5 || lines.length === 1) return best.pv[0];
    const toCp = (l: SerializedLine) => (l.scoreType === 'mate' ? (l.score > 0 ? 3000 : -3000) : l.score);
    const temps = [0, 220, 140, 90, 50];
    const t = temps[level];
    const base = toCp(best);
    const weights = lines.map((l) => Math.exp((toCp(l) - base) / t));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < lines.length; i++) { r -= weights[i]; if (r <= 0) return lines[i].pv[0]; }
    return best.pv[0];
  }

  private checkGameEnd(): void {
    if (this.outcome) return;
    const node = this.lastNode();
    const st = this.game.status(node);
    if (st.over) this.endGame({ result: st.result, reason: st.reason });
    else this.render();
  }

  private endGame(o: Outcome): void {
    this.outcome = o;
    this.clock.stop();
    this.engine.stop();
    this.engineThinking = false;
    this.engineRequestToken++;
    this.game.headers.set('Result', o.result);
    this.sound.play('gameEnd');
    this.render();
    this.showBanner();
    this.persistSession();
  }

  private showBanner(): void {
    if (!this.outcome) return;
    const o = this.outcome;
    const title = o.result === '1/2-1/2' ? 'Draw' : o.result === '1-0' ? 'White wins' : 'Black wins';
    let sub = o.reason;
    if (this.mode === 'play') {
      const humanWon = (o.result === '1-0' && this.setup.humanColor === WHITE) || (o.result === '0-1' && this.setup.humanColor === BLACK);
      sub = o.result === '1/2-1/2' ? o.reason : `${humanWon ? 'You won' : 'You lost'} · ${o.reason}`;
    }
    this.els.banner.innerHTML = `<div class="banner"><h3>${title}</h3><p>${esc(sub)}</p><div class="row">
      ${this.mode !== 'analysis' ? `<button class="btn btn--primary" data-act="rematch">Rematch</button>` : ''}
      <button class="btn" data-act="review">Review game</button>
      <button class="btn btn--ghost" data-act="close-banner">Close</button></div></div>`;
  }

  private onFlag(side: 0 | 1): void {
    if (this.outcome) return;
    const pos = this.game.position(this.lastNode());
    // A side with insufficient mating material cannot win on time.
    const other = (side ^ 1) as 0 | 1;
    const cantWin = pos.nonPawnMaterial(other) <= 1 && pos.pieceCount[other === WHITE ? 1 : 9] === 0;
    if (cantWin) this.endGame({ result: '1/2-1/2', reason: 'Time out, but insufficient material' });
    else this.endGame({ result: side === WHITE ? '0-1' : '1-0', reason: `${side === WHITE ? 'White' : 'Black'} ran out of time` });
  }

  private resign(): void {
    if (this.mode !== 'play' || this.outcome) return;
    this.confirmDialog('Resign this game?', 'Resign', () => {
      if (this.outcome) return;
      this.endGame({ result: this.setup.humanColor === WHITE ? '0-1' : '1-0', reason: 'Resignation' });
    });
  }

  private confirmDialog(text: string, okLabel: string, onOk: () => void): void {
    const d = this.dlg('confirm');
    d.querySelector('[data-el="confirm-text"]')!.textContent = text;
    d.querySelector('[data-el="confirm-ok"]')!.textContent = okLabel;
    const handler = () => { d.removeEventListener('close', handler); if (d.returnValue === 'ok') onOk(); };
    d.addEventListener('close', handler);
    d.showModal();
  }

  private offerDraw(): void {
    if (this.mode !== 'play' || this.outcome) return;
    // The engine accepts when it is not better than +0.3 for itself, after move 10.
    const node = this.lastNode();
    const ev = this.lastEvalCp;
    const engineColor = this.setup.humanColor ^ 1;
    const engineCp = ev === null ? 0 : (engineColor === WHITE ? ev : -ev);
    if (node.ply >= 20 && engineCp <= 30) this.endGame({ result: '1/2-1/2', reason: 'Draw by agreement' });
    else { this.drawOffered = true; this.toast('The computer declines the draw.'); }
  }

  private takeback(): void {
    if (this.mode !== 'play' || this.outcome) return;
    const human = this.setup.humanColor;
    // Go back to the most recent position where it is the human's turn, then truncate.
    this.engine.stop();
    this.engineThinking = false;
    this.engineRequestToken++;
    let n = this.lastNode();
    if (n === this.game.root) return;
    n = n.parent!;
    while (n.parent && this.game.position(n).side !== human) n = n.parent;
    this.game.goTo(n);
    this.game.truncateAfterCurrent();
    this.clock.stop();
    if (this.setup.tc && this.gameStarted) this.clock.start(human);
    this.render();
  }

  // ---- Analysis -------------------------------------------------------------------------
  setAnalysis(on: boolean): void {
    if (on === this.analysisOn) return;
    this.analysisOn = on;
    if (on) this.restartAnalysis(); else { this.engine.stop(); this.lines = []; this.analysisNode = null; }
    this.render();
  }

  private restartAnalysis(): void {
    if (!this.analysisOn) return;
    const node = this.game.current;
    const pos = this.game.position(node);
    this.analysisNode = node;
    this.lines = [];
    this.analysisInfo = { depth: 0, nodes: 0, nps: 0, time: 0 };
    if (pos.legalMoves().length === 0) { this.renderEngine(); return; }
    // Send the path so the engine sees repetitions.
    const moves = this.game.uciPath(node);
    this.engine.go(this.game.startFen, moves, { multiPv: this.settings.multiPv, depth: 60 }, {
      onLine: (line) => {
        if (this.analysisNode !== node) return;
        const i = this.lines.findIndex((l) => l.multipv === line.multipv);
        // Drop stale lower-depth lines when depth increases for multipv 1.
        if (line.multipv === 1 && this.lines.length && this.lines[0].depth < line.depth) this.lines = this.lines.filter((l) => l.multipv === 1);
        if (i >= 0) this.lines[i] = line; else this.lines.push(line);
        this.lines.sort((a, b) => a.multipv - b.multipv);
        this.analysisInfo = { depth: line.depth, nodes: line.nodes, nps: line.nps, time: line.time };
        if (line.multipv === 1 && line.depth >= 8 && (!node.eval || node.eval.depth <= line.depth)) {
          const whiteSign = pos.side === WHITE ? 1 : -1;
          node.eval = { type: line.scoreType, value: line.score * whiteSign, depth: line.depth };
        }
        this.renderEngine();
      },
      onProgress: (nodes, time, depth) => { if (this.analysisNode !== node) return; this.analysisInfo = { ...this.analysisInfo, nodes, time, nps: time > 0 ? Math.round((nodes * 1000) / time) : 0, depth: Math.max(depth, this.analysisInfo.depth) }; this.renderEngineStatus(); },
    });
    this.renderEngine();
  }

  private playPv(uci: string[]): void {
    if (!uci.length) return;
    if (this.mode === 'play' && !this.outcome) { this.toast('Finish or leave the game before exploring lines.'); return; }
    let node = this.game.current;
    for (const u of uci) {
      const n = this.game.playUci(u, node);
      if (!n) break;
      node = n;
    }
    this.game.goTo(uci.length ? this.game.current : node);
  }

  // ---- Game review ------------------------------------------------------------------------
  private async reviewGame(): Promise<void> {
    if (this.reviewing) return;
    const main = this.game.mainLine();
    if (main.length === 0) { this.toast('Nothing to review yet.'); return; }
    this.els.banner.innerHTML = '';
    const wasAnalysis = this.analysisOn;
    this.setAnalysis(false);
    this.reviewing = true;
    this.reviewProgress = 0;
    const nodes = [this.game.root, ...main];
    const evalAt = (node: GameNode): Promise<{ eval: { type: 'cp' | 'mate'; value: number; depth: number }; best: string }> => new Promise((resolve) => {
      const pos = this.game.position(node);
      if (pos.legalMoves().length === 0) {
        const st = this.game.status(node);
        const v = st.over && st.result === '1-0' ? 1 : st.over && st.result === '0-1' ? -1 : 0;
        resolve({ eval: v === 0 ? { type: 'cp', value: 0, depth: 99 } : { type: 'mate', value: v === 1 ? 0 : 0, depth: 99 }, best: '' });
        return;
      }
      this.engine.go(pos.fen(), [], { movetime: 280, depth: 16 }, {
        onDone: (r) => {
          const l = r.lines[0];
          const sign = pos.side === WHITE ? 1 : -1;
          resolve({ eval: l ? { type: l.scoreType, value: l.score * sign, depth: l.depth } : { type: 'cp', value: 0, depth: 0 }, best: r.bestMove });
        },
      });
    });
    const bestMoves: string[] = [];
    for (let i = 0; i < nodes.length; i++) {
      if (!this.reviewing) return;
      const r = await evalAt(nodes[i]);
      nodes[i].eval = r.eval;
      bestMoves.push(r.best);
      this.reviewProgress = (i + 1) / nodes.length;
      this.renderProgress();
      if (i % 4 === 0) this.renderChart();
    }
    // Classify each move by the change in win probability for the mover.
    const stats = [{ cpl: 0, n: 0, blunders: 0, mistakes: 0, inacc: 0, acc: 0 }, { cpl: 0, n: 0, blunders: 0, mistakes: 0, inacc: 0, acc: 0 }];
    for (let i = 1; i < nodes.length; i++) {
      const before = nodes[i - 1].eval!, after = nodes[i].eval!;
      const mover = this.game.position(nodes[i - 1]).side;
      const sign = mover === WHITE ? 1 : -1;
      const wpBefore = winPercent(sign * Math.max(-1000, Math.min(1000, evalToWhiteCp(before))));
      const wpAfter = winPercent(sign * Math.max(-1000, Math.min(1000, evalToWhiteCp(after))));
      const drop = Math.max(0, wpBefore - wpAfter);
      const cpBefore = sign * evalToWhiteCp(before), cpAfter = sign * evalToWhiteCp(after);
      const cpl = Math.max(0, Math.min(1000, cpBefore - cpAfter));
      stats[mover].cpl += cpl; stats[mover].n++;
      nodes[i].nags = nodes[i].nags.filter((n) => n > 6);
      const wasBest = bestMoves[i - 1] && nodes[i].uci === bestMoves[i - 1];
      if (!wasBest) {
        if (drop >= 20) { nodes[i].nags.unshift(4); stats[mover].blunders++; }
        else if (drop >= 10) { nodes[i].nags.unshift(2); stats[mover].mistakes++; }
        else if (drop >= 5) { nodes[i].nags.unshift(6); stats[mover].inacc++; }
      }
      // Accuracy per move (lichess-style curve)
      stats[mover].acc += Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));
    }
    this.reviewing = false;
    this.reviewProgress = 0;
    const summary = stats.map((s) => ({ accuracy: s.n ? s.acc / s.n : 100, acpl: s.n ? Math.round(s.cpl / s.n) : 0, ...s }));
    this.els.review.hidden = false;
    this.els.review.innerHTML = [WHITE, BLACK].map((c) => {
      const s = summary[c];
      return `<div class="side"><b>${esc(this.game.headers.get(c === WHITE ? 'White' : 'Black') ?? (c === WHITE ? 'White' : 'Black'))}</b><span class="acc">${s.accuracy.toFixed(1)}%</span><span class="tags"><span title="Blunders">?? ${s.blunders}</span><span title="Mistakes">? ${s.mistakes}</span><span title="Inaccuracies">?! ${s.inacc}</span><span title="Average centipawn loss">ACPL ${s.acpl}</span></span></div>`;
    }).join('');
    this.render();
    this.game.notify();
    if (wasAnalysis) this.setAnalysis(true);
    this.toast('Review complete. Blunders are marked in the move list and on the chart.');
  }

  // ---- Rendering ----------------------------------------------------------------------------
  private onGameChange(): void {
    this.render();
    if (this.analysisOn && this.analysisNode !== this.game.current) this.restartAnalysis();
    this.persistSessionSoon();
  }

  private persistTimer: number | null = null;
  private persistSessionSoon(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => this.persistSession(), 800);
  }

  render(): void {
    const node = this.game.current;
    const pos = this.game.position(node);
    const live = this.atLiveEnd();
    // Board
    const legal = pos.legalMoves();
    let movable: number[] = [];
    if (this.mode === 'analysis') movable = [WHITE, BLACK];
    else if (this.mode === 'play' && live && !this.outcome && pos.side === this.setup.humanColor && !this.reviewing) movable = [this.setup.humanColor];
    this.board.setPosition(pos, node.move, legal);
    this.board.setMovable(movable);
    this.renderStrips(pos);
    this.renderStatus(pos, live);
    this.renderMovesList();
    this.renderOpening();
    this.renderEngine();
    this.renderChart();
    this.renderActions(live);
    this.renderClocks();
    (this.root.querySelector('[data-act="toggle-analysis"]') as HTMLElement).setAttribute('aria-checked', String(this.analysisOn));
    this.els.evalbar.hidden = !this.settings.evalBar || !this.analysisOn;
  }

  private renderStrips(pos: Position): void {
    const topColor = this.orientation === WHITE ? BLACK : WHITE;
    const strip = (color: number, el: HTMLElement) => {
      const name = this.game.headers.get(color === WHITE ? 'White' : 'Black') ?? (color === WHITE ? 'White' : 'Black');
      const you = this.mode === 'play' && color === this.setup.humanColor;
      el.innerHTML = `<span class="name"><span class="dot ${color === WHITE ? 'white' : 'black'}"></span>${esc(name)}${you ? '<span class="sub">(you)</span>' : ''}</span>${renderCaptured(pos, color)}<span class="clock" data-clock="${color}" ${this.setup.tc && this.mode !== 'analysis' ? '' : 'hidden'}></span>`;
    };
    strip(topColor, this.els.stripTop);
    strip(topColor ^ 1, this.els.stripBottom);
  }

  private renderClocks(): void {
    if (!this.setup.tc || this.mode === 'analysis') return;
    this.root.querySelectorAll<HTMLElement>('[data-clock]').forEach((el) => {
      const c = Number(el.dataset.clock) as 0 | 1;
      const ms = this.clock.time[c];
      el.textContent = Clock.format(ms);
      el.classList.toggle('running', this.clock.running === c);
      el.classList.toggle('low', ms < 20000);
      el.hidden = false;
    });
    if (this.clock.running !== null && this.clock.time[this.clock.running] < 10000 && this.clock.running === this.setup.humanColor && this.mode === 'play') {
      const t = this.clock.time[this.clock.running];
      if (Math.floor(t / 1000) !== Math.floor((t + 100) / 1000)) this.sound.play('lowTime');
    }
  }

  private renderStatus(pos: Position, live: boolean): void {
    const st = this.game.status();
    let html = '';
    if (this.outcome && live) html = `<span class="pill over">${this.outcome.result}</span><span>${esc(this.outcome.reason)}</span>`;
    else if (st.over) html = `<span class="pill over">${st.result}</span><span>${esc(st.reason)}</span>`;
    else {
      const side = pos.side === WHITE ? 'White' : 'Black';
      if (this.engineThinking && live) html = `<span class="pill thinking">Thinking…</span><span>${side} (computer) to move</span>`;
      else html = `<span class="pill">${side} to move</span>${st.check ? '<span class="pill check">Check</span>' : ''}`;
      if (this.mode === 'play' && !live) html += '<span class="pill">Viewing history</span>';
      if (this.paused) html += '<span class="pill">Paused</span>';
    }
    this.els.status.innerHTML = html;
  }

  private renderMovesList(): void {
    this.els.moves.innerHTML = renderMoves(this.game);
    const cur = this.els.moves.querySelector<HTMLElement>('.mv.current');
    if (cur) {
      const box = this.els.moves.getBoundingClientRect();
      const r = cur.getBoundingClientRect();
      if (r.top < box.top || r.bottom > box.bottom) cur.scrollIntoView({ block: 'center' });
    }
  }

  private renderOpening(): void {
    const sans = this.game.pathTo(this.game.current).map((n) => n.san);
    const o = this.game.startFen === STARTPOS_FEN ? findOpening(sans) : null;
    this.els.opening.innerHTML = o ? `<span class="eco">${o.eco}</span><span class="name">${esc(o.name)}</span>` : (sans.length ? '' : '<span>Standard start position</span>');
    this.els.opening.hidden = !o && sans.length > 0;
  }

  private renderEngineStatus(): void {
    const i = this.analysisInfo;
    if (!this.analysisOn) { this.els['engine-status'].innerHTML = this.engine.sharedStop ? '' : ''; return; }
    const nodes = i.nodes >= 1e6 ? (i.nodes / 1e6).toFixed(1) + 'M' : i.nodes >= 1e3 ? (i.nodes / 1e3).toFixed(0) + 'k' : String(i.nodes);
    const nps = i.nps >= 1e6 ? (i.nps / 1e6).toFixed(1) + 'M' : (i.nps / 1e3).toFixed(0) + 'k';
    this.els['engine-status'].innerHTML = i.depth ? `<span class="depth">d${i.depth}</span>·${nodes} n·${nps} n/s` : '';
  }

  private renderEngine(): void {
    this.renderEngineStatus();
    const pos = this.game.position();
    if (!this.analysisOn) {
      this.els.lines.innerHTML = this.mode === 'analysis' ? '<div class="engine-idle">Analysis is off. Press <b>Space</b> or flip the switch to analyse this position.</div>' : '<div class="engine-idle">Engine analysis is available after the game, or on the analysis board.</div>';
      this.board.setAutoShapes([]);
      this.renderEvalBar(null);
      return;
    }
    if (pos.legalMoves().length === 0) {
      const st = this.game.status();
      this.els.lines.innerHTML = `<div class="engine-idle">${esc(st.over ? st.reason : 'No legal moves')}</div>`;
      this.board.setAutoShapes([]);
      this.renderEvalBar(st.over && st.result !== '1/2-1/2' ? (st.result === '1-0' ? 10000 : -10000) : 0);
      return;
    }
    const startMoveNo = parseInt(this.game.current.fen.split(' ')[5] ?? '1', 10) || 1;
    const startPly = pos.side === WHITE ? 0 : 1;
    this.els.lines.innerHTML = renderLines(this.lines, pos.side, startMoveNo, startPly);
    const shapes: Shape[] = [];
    if (this.settings.showBestArrow) {
      this.lines.slice(0, 2).forEach((l, i) => {
        const m = parseUci(pos, l.pv[0]);
        if (!m) return;
        const from = m & 127, to = (m >> 7) & 127;
        shapes.push({ from, to, color: i === 0 ? 'var(--arrow-best)' : 'var(--arrow-second)', width: i === 0 ? 0.17 : 0.11 });
      });
    }
    this.board.setAutoShapes(shapes);
    if (this.lines[0]) {
      const l = this.lines[0];
      const sign = pos.side === WHITE ? 1 : -1;
      const cp = l.scoreType === 'mate' ? (l.score > 0 ? 10000 : -10000) * sign : l.score * sign;
      this.lastEvalCp = cp;
      this.renderEvalBar(cp, l);
    } else this.renderEvalBar(null);
  }

  private renderEvalBar(whiteCp: number | null, line?: SerializedLine): void {
    const bar = this.els.evalbar;
    const fill = bar.querySelector<HTMLElement>('.fill')!;
    const top = bar.querySelector<HTMLElement>('.label.top')!;
    const bottom = bar.querySelector<HTMLElement>('.label.bottom')!;
    bar.classList.toggle('flipped', this.orientation === BLACK);
    if (whiteCp === null) { fill.style.height = '50%'; top.textContent = ''; bottom.textContent = ''; return; }
    const pct = Math.max(2, Math.min(98, winPercent(Math.max(-1200, Math.min(1200, whiteCp)))));
    fill.style.height = `${pct}%`;
    const pos = this.game.position();
    const s = line ? formatScore(line, true, pos.side)
      : Math.abs(whiteCp) >= 10000 ? { text: whiteCp > 0 ? '1-0' : '0-1', white: whiteCp > 0 }
      : { text: (whiteCp / 100).toFixed(1), white: whiteCp >= 0 };
    const text = s.text.replace('+', '').replace(/^-/, '');
    const showAtBottom = (whiteCp >= 0) === (this.orientation === WHITE);
    top.textContent = showAtBottom ? '' : text;
    bottom.textContent = showAtBottom ? text : '';
  }

  private renderChart(): void {
    const main = this.game.mainLine();
    const has = main.filter((n) => n.eval).length >= 4;
    this.els.chart.hidden = !has;
    if (!has) return;
    const w = Math.max(100, this.els.chart.clientWidth || this.chartWidth);
    this.els.chart.innerHTML = renderChart(this.game, w, 70);
  }

  private renderProgress(): void {
    const p = this.els.progress;
    p.hidden = !this.reviewing;
    p.querySelector<HTMLElement>('i')!.style.width = `${Math.round(this.reviewProgress * 100)}%`;
  }

  private renderActions(live: boolean): void {
    const a: string[] = [];
    if (this.mode === 'play') {
      if (!this.outcome) {
        if (!live) a.push(`<button class="btn btn--sm" data-act="back-to-game">${ICONS.last}Back to game</button>`);
        a.push(`<button class="btn btn--sm" data-act="takeback" ${this.lastNode() === this.game.root ? 'disabled' : ''}>${ICONS.undo}Take back</button>`);
        a.push(`<button class="btn btn--sm" data-act="draw">${ICONS.half}Offer draw</button>`);
        a.push(`<button class="btn btn--sm btn--danger" data-act="resign">${ICONS.flag}Resign</button>`);
      } else {
        a.push(`<button class="btn btn--sm btn--primary" data-act="rematch">Rematch</button>`);
        a.push(`<button class="btn btn--sm" data-act="review" ${this.reviewing ? 'disabled' : ''}>${ICONS.search}Review game</button>`);
        a.push(`<button class="btn btn--sm" data-act="analyse-here">Analysis board</button>`);
      }
    } else if (this.mode === 'watch') {
      if (!this.outcome) a.push(`<button class="btn btn--sm" data-act="pause">${this.paused ? ICONS.play : ICONS.pause}${this.paused ? 'Resume' : 'Pause'}</button>`);
      else a.push(`<button class="btn btn--sm btn--primary" data-act="rematch">Play again</button>`);
      a.push(`<button class="btn btn--sm" data-act="review" ${this.reviewing ? 'disabled' : ''}>${ICONS.search}Review game</button>`);
      a.push(`<button class="btn btn--sm" data-act="analyse-here">Analysis board</button>`);
    } else {
      a.push(`<button class="btn btn--sm" data-act="review" ${this.reviewing || this.game.mainLine().length === 0 ? 'disabled' : ''}>${ICONS.search}Review game</button>`);
      a.push(`<button class="btn btn--sm" data-act="pgn">${ICONS.file}PGN / FEN</button>`);
    }
    this.els.actions.innerHTML = a.join('');
    this.renderProgress();
  }

  // ---- Move context menu (variations) ---------------------------------------------
  private moveContextMenu(node: GameNode, x: number, y: number): void {
    document.querySelector('.ctx')?.remove();
    const menu = document.createElement('div');
    menu.className = 'ctx card';
    menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:60;padding:6px;display:flex;flex-direction:column;gap:2px;min-width:180px`;
    const isMain = this.game.isOnMainLine(node);
    menu.innerHTML = `
      ${!isMain ? `<button class="btn btn--ghost btn--sm" style="justify-content:flex-start" data-act="promote-var" data-id="${node.id}">${ICONS.up}Promote variation</button>` : ''}
      <button class="btn btn--ghost btn--sm btn--danger" style="justify-content:flex-start" data-act="delete-var" data-id="${node.id}">${ICONS.trash}Delete from here</button>`;
    document.body.appendChild(menu);
    const close = () => { menu.remove(); document.removeEventListener('pointerdown', onDown, true); };
    const onDown = (e: Event) => { if (!menu.contains(e.target as Node)) close(); };
    menu.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (b) { this.action(b.dataset.act!, b); close(); }
    });
    setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
  }

  private findNode(id: number): GameNode | null {
    const walk = (n: GameNode): GameNode | null => {
      if (n.id === id) return n;
      for (const c of n.children) { const r = walk(c); if (r) return r; }
      return null;
    };
    return walk(this.game.root);
  }

  // ---- Dialogs: settings / PGN -------------------------------------------------------
  private openSettingsDialog(): void {
    const d = this.dlg('settings');
    const s = this.settings;
    d.querySelectorAll<HTMLElement>('.seg[data-field="theme"] button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === s.theme)));
    d.querySelectorAll<HTMLElement>('.swatch').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.board === s.boardTheme)));
    for (const k of ['showLegal', 'showCoords', 'highlightLast', 'animate', 'sound', 'autoAnalysis', 'showBestArrow', 'evalBar'] as const) {
      (d.querySelector(`[data-field="${k}"]`) as HTMLInputElement).checked = s[k];
    }
    (d.querySelector('[data-field="multiPv"]') as HTMLInputElement).value = String(s.multiPv);
    d.querySelector('[data-el="mpv-val"]')!.textContent = String(s.multiPv);
    (d.querySelector('[data-field="hashMb"]') as HTMLSelectElement).value = String(s.hashMb);
    d.showModal();
  }

  private bindSettingsDialog(): void {
    const d = this.dlg('settings');
    d.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const theme = t.closest<HTMLElement>('.seg[data-field="theme"] button');
      if (theme) { this.settings.theme = theme.dataset.v as Settings['theme']; d.querySelectorAll('.seg[data-field="theme"] button').forEach((b) => b.setAttribute('aria-pressed', String(b === theme))); this.applySettings(); }
      const sw = t.closest<HTMLElement>('.swatch');
      if (sw) { this.settings.boardTheme = sw.dataset.board as Settings['boardTheme']; d.querySelectorAll('.swatch').forEach((b) => b.setAttribute('aria-pressed', String(b === sw))); this.applySettings(); }
    });
    d.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement | HTMLSelectElement;
      const f = t.dataset.field as keyof Settings | undefined;
      if (!f) return;
      if (t instanceof HTMLInputElement && t.type === 'checkbox') (this.settings as unknown as Record<string, unknown>)[f] = t.checked;
      else if (f === 'multiPv') { this.settings.multiPv = Number(t.value); d.querySelector('[data-el="mpv-val"]')!.textContent = t.value; }
      else if (f === 'hashMb') { this.settings.hashMb = Number(t.value); }
      this.applySettings();
    });
    d.querySelector('[data-field="multiPv"]')!.addEventListener('input', (e) => { d.querySelector('[data-el="mpv-val"]')!.textContent = (e.target as HTMLInputElement).value; });
  }

  private openPgnDialog(): void {
    const d = this.dlg('pgn');
    (d.querySelector('[data-field="fen"]') as HTMLInputElement).value = this.game.current.fen;
    (d.querySelector('[data-field="pgn"]') as HTMLTextAreaElement).value = toPgn(this.game);
    d.querySelector('[data-el="pgn-msg"]')!.textContent = 'Paste a PGN (variations and comments are supported) and press Import.';
    d.showModal();
  }

  private bindPgnDialog(): void {
    const d = this.dlg('pgn');
    d.addEventListener('click', async (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      const fenEl = d.querySelector('[data-field="fen"]') as HTMLInputElement;
      const pgnEl = d.querySelector('[data-field="pgn"]') as HTMLTextAreaElement;
      const msg = d.querySelector('[data-el="pgn-msg"]')!;
      switch (b.dataset.act) {
        case 'copy-fen': await this.copy(fenEl.value); break;
        case 'copy-pgn': await this.copy(pgnEl.value); break;
        case 'download-pgn': {
          const blob = new Blob([pgnEl.value], { type: 'application/x-chess-pgn' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob); a.download = `ply-${Date.now()}.pgn`; a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          break;
        }
        case 'load-fen': {
          const fen = fenEl.value.trim();
          if (!new Position().setFen(fen)) { msg.textContent = 'That FEN is not valid.'; return; }
          d.close();
          this.startGame({ ...this.setup, mode: 'analysis', fen: new Position(fen).fen(), tc: null });
          break;
        }
        case 'load-pgn': {
          const { game, errors } = parsePgn(pgnEl.value);
          if (game.mainLine().length === 0 && errors.length) { msg.textContent = 'Could not read that PGN: ' + errors[0]; return; }
          d.close();
          this.stopEverything();
          this.mode = 'analysis';
          this.outcome = null;
          this.clock.reset(null);
          this.swapGame(game);
          this.engine.newGame();
          this.game.last();
          this.render();
          if (this.settings.autoAnalysis) this.setAnalysis(true);
          this.toast(errors.length ? `Imported with ${errors.length} problem(s): ${errors[0]}` : `Imported ${game.mainLine().length} moves.`);
          break;
        }
      }
    });
  }

  private async copy(text: string): Promise<void> {
    try { await navigator.clipboard.writeText(text); this.toast('Copied to clipboard.'); }
    catch { this.toast('Clipboard unavailable — select the text and copy manually.'); }
  }

  toast(msg: string): void {
    const t = this.els.toast;
    t.textContent = msg;
    t.classList.add('show');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.remove('show'), 2600);
  }
}

export { moveToSan };
