// Main-thread wrapper around the engine worker. Handles stop semantics with a
// SharedArrayBuffer flag when the page is cross-origin isolated, and with
// chunked searches (plus worker restart as a last resort) otherwise.
import type { SearchLimits } from './search';
import type { WorkerResponse, SerializedLine, GoRequest } from './protocol';
import EngineWorker from './worker?worker&inline';

export type { SerializedLine };

export interface AnalysisHandlers {
  onLine?: (line: SerializedLine) => void;
  onProgress?: (nodes: number, time: number, depth: number) => void;
  onDone?: (result: { bestMove: string; ponder: string; lines: SerializedLine[]; depth: number; nodes: number; time: number; stopped: boolean }) => void;
}

export class EngineClient {
  private worker!: Worker;
  private ready: Promise<void> = Promise.resolve();
  private stopFlag: Int32Array | null = null;
  private nextId = 1;
  private activeId = 0;
  private handlers: AnalysisHandlers | null = null;
  private activeIsInfinite = false;
  private hashMb: number;
  readonly sharedStop: boolean;

  constructor(hashMb = 16) {
    this.hashMb = hashMb;
    this.sharedStop = typeof SharedArrayBuffer !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
    if (this.sharedStop) this.stopFlag = new Int32Array(new SharedArrayBuffer(4));
    this.spawn();
  }

  private spawn(): void {
    this.worker = new EngineWorker();
    this.ready = new Promise<void>((resolve) => {
      const onReady = (e: MessageEvent<WorkerResponse>) => {
        if (e.data.type === 'ready') { this.worker.removeEventListener('message', onReady); resolve(); }
      };
      this.worker.addEventListener('message', onReady);
    });
    this.worker.postMessage({ type: 'init', hashMb: this.hashMb, stopFlag: this.stopFlag ?? undefined });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data);
  }

  private onMessage(msg: WorkerResponse): void {
    if (msg.type === 'ready') return;
    if (msg.type === 'info' || msg.type === 'progress' || msg.type === 'bestmove' || msg.type === 'evalresult') {
      if (msg.id !== this.activeId) return; // stale
    }
    switch (msg.type) {
      case 'info': this.handlers?.onLine?.(msg.line); break;
      case 'progress': this.handlers?.onProgress?.(msg.nodes, msg.time, msg.depth); break;
      case 'bestmove': {
        const h = this.handlers;
        this.handlers = null; this.activeId = 0; this.activeIsInfinite = false;
        h?.onDone?.({ bestMove: msg.bestMove, ponder: msg.ponder, lines: msg.lines, depth: msg.depth, nodes: msg.nodes, time: msg.time, stopped: msg.stopped });
        break;
      }
    }
  }

  get busy(): boolean { return this.activeId !== 0; }

  newGame(): void {
    this.worker.postMessage({ type: 'newgame' });
  }

  // Starts a search; any running search is stopped first.
  go(fen: string, moves: string[], limits: SearchLimits, handlers: AnalysisHandlers): number {
    this.stop();
    const id = this.nextId++;
    this.activeId = id;
    this.handlers = handlers;
    this.activeIsInfinite = !limits.movetime && limits.wtime === undefined && !limits.nodes;
    const req: GoRequest = { type: 'go', id, fen, moves, limits, chunkMs: this.sharedStop ? undefined : 350 };
    this.ready.then(() => { if (this.activeId === id) this.worker.postMessage(req); });
    return id;
  }

  // Stops the active search. The pending onDone (if any) is dropped: callers that
  // need the result of a stopped search should use stopAndWait instead.
  stop(): void {
    if (this.activeId === 0) return;
    this.handlers = null;
    const wasInfinite = this.activeIsInfinite;
    this.activeId = 0;
    this.activeIsInfinite = false;
    if (this.stopFlag) {
      Atomics.store(this.stopFlag, 0, 1);
      this.worker.postMessage({ type: 'stop' });
    } else if (wasInfinite) {
      // Chunked search: the worker checks between slices.
      this.worker.postMessage({ type: 'stop' });
    } else {
      // A timed/depth-limited search cannot be interrupted without shared memory: restart the worker.
      this.worker.terminate();
      this.spawn();
    }
  }

  // Stops the running search and resolves with its best line so far.
  stopAndWait(): Promise<{ bestMove: string; lines: SerializedLine[] } | null> {
    if (this.activeId === 0) return Promise.resolve(null);
    if (!this.stopFlag && !this.activeIsInfinite) { this.stop(); return Promise.resolve(null); }
    return new Promise((resolve) => {
      const prev = this.handlers;
      this.handlers = {
        onLine: prev?.onLine,
        onDone: (r) => resolve({ bestMove: r.bestMove, lines: r.lines }),
      };
      if (this.stopFlag) Atomics.store(this.stopFlag, 0, 1);
      this.worker.postMessage({ type: 'stop' });
    });
  }

  dispose(): void {
    this.worker.terminate();
  }
}
