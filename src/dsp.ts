/** Small DSP building blocks shared by instruments, drums and effects. */

export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => (g > 0 ? 20 * Math.log10(g) : -120);
export const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** Deterministic PRNG (mulberry32) so renders are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** PolyBLEP residual: removes most aliasing from saw and square edges. */
function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

export type Wave = 'sine' | 'saw' | 'square' | 'triangle';

/** Band-limited oscillator. phase in [0,1). */
export class Osc {
  phase: number;
  private tri = 0;
  constructor(public wave: Wave, phase = 0) {
    this.phase = phase;
  }
  next(dt: number): number {
    const t = this.phase;
    let y: number;
    switch (this.wave) {
      case 'sine':
        y = Math.sin(2 * Math.PI * t);
        break;
      case 'saw':
        y = 2 * t - 1 - polyBlep(t, dt);
        break;
      case 'square':
      case 'triangle': {
        y = (t < 0.5 ? 1 : -1) + polyBlep(t, dt) - polyBlep((t + 0.5) % 1, dt);
        if (this.wave === 'triangle') {
          // Leaky-integrated square gives a band-limited triangle.
          this.tri = dt * 4 * y + (1 - dt) * this.tri;
          y = this.tri;
        }
        break;
      }
    }
    this.phase += dt;
    if (this.phase >= 1) this.phase -= 1;
    return y;
  }
}

/** Chamberlin-style state-variable filter (TPT form, stable at high cutoffs). */
export class Svf {
  private ic1 = 0;
  private ic2 = 0;
  constructor(private sampleRate: number) {}
  /** Returns [low, band, high]. q: 0.5 (soft) .. 10 (resonant). */
  process(x: number, cutoff: number, q: number): [number, number, number] {
    const fc = Math.min(cutoff, this.sampleRate * 0.45);
    const g = Math.tan((Math.PI * fc) / this.sampleRate);
    const k = 1 / Math.max(0.5, q);
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - this.ic2;
    const v1 = a1 * this.ic1 + a2 * v3;
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return [v2, v1, x - k * v1 - v2];
  }
}

/** One-pole filters for EQ cuts and smoothing. */
export class OnePole {
  private z = 0;
  constructor(private sampleRate: number) {}
  low(x: number, hz: number): number {
    const a = 1 - Math.exp((-2 * Math.PI * hz) / this.sampleRate);
    this.z += a * (x - this.z);
    return this.z;
  }
  high(x: number, hz: number): number {
    return x - this.low(x, hz);
  }
}

export interface Adsr {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

/**
 * Envelope level at time t (seconds since note-on) for a note held `hold` seconds.
 * Exponential-shaped decay and release sound more natural than linear ramps.
 */
export function adsrAt(e: Adsr, t: number, hold: number): number {
  const held = (x: number) => {
    if (x < e.attack) return x / e.attack;
    const d = x - e.attack;
    return e.sustain + (1 - e.sustain) * Math.exp((-5 * d) / Math.max(e.decay, 1e-4));
  };
  if (t < 0) return 0;
  if (t < hold) return held(t);
  return held(hold) * Math.exp((-5 * (t - hold)) / Math.max(e.release, 1e-4));
}
