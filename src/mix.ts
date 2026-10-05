/** Per-track channel strip: RBJ biquad EQ, stereo-linked compressor, LFO shapes. */

export type BiquadType = 'highpass' | 'lowpass' | 'lowshelf' | 'highshelf' | 'peak';

export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  constructor(type: BiquadType, sampleRate: number, freq: number, q = Math.SQRT1_2, gainDb = 0) {
    const f = Math.min(Math.max(10, freq), sampleRate * 0.45);
    const w0 = (2 * Math.PI * f) / sampleRate;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    const A = Math.pow(10, gainDb / 40);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;

    if (type === 'highpass' || type === 'lowpass') {
      const alpha = sin / (2 * q);
      const sign = type === 'highpass' ? -1 : 1;
      b1 = type === 'highpass' ? -(1 + cos) : 1 - cos;
      b0 = (1 - sign * cos) / 2;
      b2 = b0;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
    } else if (type === 'peak') {
      const alpha = sin / (2 * q);
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
    } else {
      const alpha = (sin / 2) * Math.SQRT2;
      const sq = 2 * Math.sqrt(A) * alpha;
      if (type === 'lowshelf') {
        b0 = A * (A + 1 - (A - 1) * cos + sq);
        b1 = 2 * A * (A - 1 - (A + 1) * cos);
        b2 = A * (A + 1 - (A - 1) * cos - sq);
        a0 = A + 1 + (A - 1) * cos + sq;
        a1 = -2 * (A - 1 + (A + 1) * cos);
        a2 = A + 1 + (A - 1) * cos - sq;
      } else {
        b0 = A * (A + 1 + (A - 1) * cos + sq);
        b1 = -2 * A * (A - 1 + (A + 1) * cos);
        b2 = A * (A + 1 + (A - 1) * cos - sq);
        a0 = A + 1 - (A - 1) * cos + sq;
        a1 = 2 * (A - 1 - (A + 1) * cos);
        a2 = A + 1 - (A - 1) * cos - sq;
      }
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

export interface EqConfig {
  lowCut?: number;
  highCut?: number;
  lowShelf?: { freq: number; gain: number };
  highShelf?: { freq: number; gain: number };
  peaks?: { freq: number; gain: number; q: number }[];
}

/** Stereo EQ; each channel owns its own filter state. */
export class StereoEq {
  private readonly chainL: Biquad[] = [];
  private readonly chainR: Biquad[] = [];

  constructor(sampleRate: number, cfg: EqConfig) {
    const add = (make: () => Biquad) => {
      this.chainL.push(make());
      this.chainR.push(make());
    };
    if (cfg.lowCut) add(() => new Biquad('highpass', sampleRate, cfg.lowCut!));
    if (cfg.lowShelf) add(() => new Biquad('lowshelf', sampleRate, cfg.lowShelf!.freq, 0.707, cfg.lowShelf!.gain));
    for (const p of cfg.peaks ?? []) add(() => new Biquad('peak', sampleRate, p.freq, p.q, p.gain));
    if (cfg.highShelf) add(() => new Biquad('highshelf', sampleRate, cfg.highShelf!.freq, 0.707, cfg.highShelf!.gain));
    if (cfg.highCut) add(() => new Biquad('lowpass', sampleRate, cfg.highCut!));
  }

  get isEmpty(): boolean {
    return this.chainL.length === 0;
  }

  process(l: number, r: number): [number, number] {
    for (let i = 0; i < this.chainL.length; i++) {
      l = this.chainL[i].process(l);
      r = this.chainR[i].process(r);
    }
    return [l, r];
  }
}

export interface CompConfig {
  threshold: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  knee: number;
  makeup: number;
}

/** Feed-forward, stereo-linked peak compressor with soft knee. */
export class Compressor {
  private grDb = 0;
  private readonly attack: number;
  private readonly release: number;
  private readonly makeupGain: number;
  maxReductionDb = 0;

  constructor(
    sampleRate: number,
    private readonly cfg: CompConfig,
  ) {
    this.attack = Math.exp(-1 / (sampleRate * Math.max(0.05, cfg.attackMs) * 0.001));
    this.release = Math.exp(-1 / (sampleRate * Math.max(1, cfg.releaseMs) * 0.001));
    this.makeupGain = Math.pow(10, cfg.makeup / 20);
  }

  private staticReduction(levelDb: number): number {
    const { threshold: t, ratio, knee } = this.cfg;
    const slope = 1 / Math.max(1, ratio) - 1;
    const over = levelDb - t;
    if (knee > 0 && Math.abs(over) <= knee / 2) {
      return (slope * (over + knee / 2) ** 2) / (2 * knee);
    }
    return over > 0 ? slope * over : 0;
  }

  process(l: number, r: number): [number, number] {
    const peak = Math.max(Math.abs(l), Math.abs(r));
    const target = this.staticReduction(20 * Math.log10(peak + 1e-9));
    const coeff = target < this.grDb ? this.attack : this.release;
    this.grDb = target + (this.grDb - target) * coeff;
    if (-this.grDb > this.maxReductionDb) this.maxReductionDb = -this.grDb;
    const g = Math.pow(10, this.grDb / 20) * this.makeupGain;
    return [l * g, r * g];
  }
}

export type LfoShape = 'sine' | 'triangle' | 'saw' | 'square';

/** Bipolar LFO value in [-1, 1] at phase (cycles). */
export function lfoValue(shape: LfoShape, phase: number): number {
  const p = phase - Math.floor(phase);
  switch (shape) {
    case 'triangle':
      return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
    case 'saw':
      return 2 * p - 1;
    case 'square':
      return p < 0.5 ? 1 : -1;
    default:
      return Math.sin(2 * Math.PI * p);
  }
}

/** Linear keyframe lookup; holds first/last value outside the range. */
export function keyframeAt(frames: { t: number; v: number }[], time: number): number {
  if (frames.length === 0) return 0;
  if (time <= frames[0].t) return frames[0].v;
  const last = frames[frames.length - 1];
  if (time >= last.t) return last.v;
  let i = 0;
  while (i < frames.length - 2 && frames[i + 1].t < time) i++;
  const a = frames[i];
  const b = frames[i + 1];
  const span = b.t - a.t;
  return span <= 0 ? b.v : a.v + ((b.v - a.v) * (time - a.t)) / span;
}
