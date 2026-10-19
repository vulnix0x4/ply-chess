// Messages between the UI thread and the engine worker.
import type { PvLine, SearchLimits } from './search';

export interface GoRequest {
  type: 'go';
  id: number;
  fen: string;
  moves: string[]; // UCI moves played from `fen`
  limits: SearchLimits;
  // For the non-SharedArrayBuffer fallback: search in chunks of this many ms so
  // stop requests can be honoured between chunks.
  chunkMs?: number;
}
export interface StopRequest { type: 'stop' }
export interface NewGameRequest { type: 'newgame' }
export interface InitRequest { type: 'init'; hashMb: number; stopFlag?: Int32Array }
export interface EvalRequest { type: 'eval'; id: number; fen: string; moves: string[] }
export type WorkerRequest = GoRequest | StopRequest | NewGameRequest | InitRequest | EvalRequest;

export interface InfoMessage { type: 'info'; id: number; line: SerializedLine }
export interface ProgressMessage { type: 'progress'; id: number; nodes: number; time: number; depth: number }
export interface BestMoveMessage { type: 'bestmove'; id: number; bestMove: string; ponder: string; lines: SerializedLine[]; depth: number; nodes: number; time: number; stopped: boolean }
export interface ReadyMessage { type: 'ready' }
export interface EvalMessage { type: 'evalresult'; id: number; score: number }
export type WorkerResponse = InfoMessage | ProgressMessage | BestMoveMessage | ReadyMessage | EvalMessage;

// A PV line with moves as UCI and SAN strings (serialisable).
export interface SerializedLine extends Omit<PvLine, 'pv'> {
  pv: string[];
  san: string[];
}
