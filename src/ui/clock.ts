// Chess clock with increment. Times are milliseconds.
export interface TimeControl { initial: number; increment: number } // seconds

export class Clock {
  time = [0, 0];
  running: 0 | 1 | null = null;
  private lastTick = 0;
  private timer: number | null = null;
  onTick: (() => void) | null = null;
  onFlag: ((side: 0 | 1) => void) | null = null;
  tc: TimeControl | null = null;

  reset(tc: TimeControl | null): void {
    this.stop();
    this.tc = tc;
    const ms = tc ? tc.initial * 1000 : 0;
    this.time = [ms, ms];
    this.onTick?.();
  }

  start(side: 0 | 1): void {
    if (!this.tc) return;
    this.running = side;
    this.lastTick = performance.now();
    if (this.timer === null) this.timer = window.setInterval(() => this.tick(), 100);
  }

  // Switch the running side after a move, applying the increment.
  press(side: 0 | 1): void {
    if (!this.tc) return;
    this.tick();
    if (this.running === side) this.time[side] += this.tc.increment * 1000;
    this.start((side ^ 1) as 0 | 1);
  }

  stop(): void {
    this.tick();
    this.running = null;
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }

  private tick(): void {
    if (this.running === null) return;
    const now = performance.now();
    const dt = now - this.lastTick;
    this.lastTick = now;
    const side = this.running;
    this.time[side] = Math.max(0, this.time[side] - dt);
    this.onTick?.();
    if (this.time[side] === 0) {
      this.stop();
      this.onFlag?.(side);
    }
  }

  static format(ms: number): string {
    const total = Math.max(0, ms);
    const s = Math.ceil(total / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    if (total < 10000) return `${m}:${String(sec).padStart(2, '0')}.${Math.floor((total % 1000) / 100)}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }
}
