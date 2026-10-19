// Synthesised sound effects (no audio files). Short, soft and unobtrusive.
export type SoundName = 'move' | 'capture' | 'check' | 'castle' | 'promote' | 'gameEnd' | 'lowTime' | 'illegal' | 'notify';

export class SoundKit {
  private ctx: AudioContext | null = null;
  enabled = true;
  volume = 0.6;

  private ac(): AudioContext | null {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
      if (!Ctor) return null;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  // Must be called from a user gesture at least once so the context can start.
  unlock(): void { this.ac(); }

  private tone(freq: number, dur: number, type: OscillatorType, gain: number, at = 0, freqEnd?: number): void {
    const ctx = this.ac();
    if (!ctx) return;
    const t0 = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain * this.volume, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  private thud(gain: number, dur = 0.09, at = 0): void {
    const ctx = this.ac();
    if (!ctx) return;
    const t0 = ctx.currentTime + at;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(1400, t0);
    filt.frequency.exponentialRampToValueAtTime(300, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain * this.volume, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt).connect(g).connect(ctx.destination);
    src.start(t0);
  }

  play(name: SoundName): void {
    if (!this.enabled) return;
    switch (name) {
      case 'move': this.thud(0.5, 0.07); this.tone(190, 0.08, 'sine', 0.18); break;
      case 'capture': this.thud(0.9, 0.11); this.tone(140, 0.12, 'sine', 0.28, 0, 90); break;
      case 'castle': this.thud(0.5, 0.07); this.thud(0.4, 0.07, 0.09); this.tone(200, 0.1, 'sine', 0.15); break;
      case 'check': this.thud(0.5, 0.07); this.tone(660, 0.1, 'triangle', 0.14); this.tone(880, 0.16, 'triangle', 0.12, 0.08); break;
      case 'promote': this.tone(523, 0.1, 'triangle', 0.12); this.tone(659, 0.1, 'triangle', 0.12, 0.08); this.tone(784, 0.2, 'triangle', 0.14, 0.16); break;
      case 'gameEnd': this.tone(392, 0.25, 'triangle', 0.12); this.tone(523, 0.25, 'triangle', 0.12, 0.12); this.tone(659, 0.45, 'triangle', 0.14, 0.24); break;
      case 'lowTime': this.tone(1200, 0.05, 'square', 0.05); break;
      case 'illegal': this.tone(160, 0.12, 'sawtooth', 0.06, 0, 110); break;
      case 'notify': this.tone(880, 0.08, 'sine', 0.1); this.tone(1175, 0.14, 'sine', 0.1, 0.07); break;
    }
  }
}
