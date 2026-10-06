/** Reverb, delay, ducking, master bus. */

export class Ducker {
  private env = 0;
  private readonly attackCoeff: number;
  private readonly releaseCoeff: number;

  constructor(sampleRate: number) {
    this.attackCoeff = Math.exp(-1 / (sampleRate * 0.001));
    this.releaseCoeff = Math.exp(-1 / (sampleRate * 0.12));
  }

  /** Follow source envelope 0-1, return gain multiplier. */
  process(sourceLevel: number, amount: number): number {
    const target = sourceLevel;
    const coeff = target > this.env ? this.attackCoeff : this.releaseCoeff;
    this.env = target + (this.env - target) * coeff;
    return 1 - this.env * amount;
  }
}

export interface FdnParams {
  /** 0–1, scales feedback. */
  size?: number;
  /** 0–1, how long the tail rings. */
  decay?: number;
  preDelayMs?: number;
  /** 0–1, how fast the highs die in the tail. */
  damping?: number;
  /** 0–1, side energy of the return. */
  width?: number;
}

const HADAMARD_8: number[][] = (() => {
  let h: number[][] = [[1]];
  while (h.length < 8) {
    const n = h.length;
    const next: number[][] = [];
    for (let i = 0; i < n * 2; i++) next.push(new Array(n * 2).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        next[i][j] = h[i][j];
        next[i][j + n] = h[i][j];
        next[i + n][j] = h[i][j];
        next[i + n][j + n] = -h[i][j];
      }
    }
    h = next;
  }
  const s = 1 / Math.sqrt(8);
  return h.map((row) => row.map((v) => v * s));
})();

function readFrac(buf: Float32Array, pos: number): number {
  const n = buf.length;
  let p = pos % n;
  if (p < 0) p += n;
  const i = Math.floor(p);
  const f = p - i;
  return buf[i] * (1 - f) + buf[(i + 1) % n] * f;
}

/**
 * 8-line feedback delay network. Each line is low-passed in the loop so the
 * tail darkens, and its length drifts slowly so the tail is not metallic.
 * Early reflections and the tail both sit behind the pre-delay.
 */
export class FdnReverb {
  private readonly lines: Float32Array[];
  private readonly baseLen: number[];
  private readonly write: number[];
  private readonly lp: number[];
  private readonly phase: number[];
  private readonly modInc: number[];
  private readonly sampleRate: number;
  private readonly preL: Float32Array;
  private readonly preR: Float32Array;
  private readonly early: Float32Array;
  private readonly taps: { delay: number; gain: number; right: boolean }[];
  private prePos = 0;
  private earlyPos = 0;
  private preSamples: number;
  private feedback: number;
  private dampMix: number;
  private width: number;
  private readonly modDepth: number;
  private readonly outGain: number;

  constructor(
    sampleRate: number,
    kind: 'hall' | 'room' = 'hall',
  ) {
    const scale = sampleRate / 44100;
    const ms = kind === 'hall' ? [37, 47, 59, 71, 83, 97, 109, 127] : [11, 13, 17, 19, 23, 29, 31, 37];
    this.modDepth = (kind === 'hall' ? 12 : 6) * scale;
    this.outGain = kind === 'hall' ? 0.45 : 0.55;
    this.lines = [];
    this.baseLen = [];
    this.write = [];
    this.lp = [];
    this.phase = [];
    this.modInc = [];
    for (let i = 0; i < 8; i++) {
      const base = Math.max(8, Math.round(ms[i] * 0.001 * sampleRate));
      this.baseLen.push(base);
      this.lines.push(new Float32Array(base + Math.ceil(this.modDepth) + 4));
      this.write.push(0);
      this.lp.push(0);
      this.phase.push(i * 0.37);
      this.modInc.push(((0.15 + i * 0.04) * 2 * Math.PI) / sampleRate);
    }
    this.sampleRate = sampleRate;
    const preMax = Math.round(0.1 * sampleRate) + 2;
    this.preL = new Float32Array(preMax);
    this.preR = new Float32Array(preMax);
    this.early = new Float32Array(Math.round(0.08 * sampleRate) + 2);
    const tapMs = kind === 'hall' ? [7, 11, 16, 23, 31, 41] : [3, 5, 8, 12, 17, 22];
    const tapGain = [0.42, 0.33, 0.26, 0.2, 0.15, 0.11];
    this.taps = tapMs.map((t, i) => ({
      delay: Math.round(t * 0.001 * sampleRate),
      gain: tapGain[i],
      right: i % 2 === 1,
    }));
    this.preSamples = Math.round((kind === 'hall' ? 0.025 : 0.008) * sampleRate);
    this.feedback = kind === 'hall' ? 0.82 : 0.62;
    this.dampMix = 0.35;
    this.width = 0.85;
  }

  setParams(params: FdnParams) {
    const size = params.size ?? 0.6;
    const decay = params.decay ?? 0.5;
    this.feedback = Math.min(0.96, 0.45 + size * 0.25 + decay * 0.3);
    this.dampMix = Math.max(0.02, Math.min(0.95, params.damping ?? 0.4));
    this.width = Math.max(0, Math.min(1, params.width ?? this.width));
    if (params.preDelayMs !== undefined) {
      this.preSamples = Math.max(0, Math.min(this.preL.length - 2, Math.round((params.preDelayMs / 1000) * this.sampleRate)));
    }
  }

  processStereo(inL: number, inR: number): [number, number] {
    const preRead = (this.prePos - this.preSamples + this.preL.length) % this.preL.length;
    const dL = this.preSamples <= 0 ? inL : this.preL[preRead];
    const dR = this.preSamples <= 0 ? inR : this.preR[preRead];
    this.preL[this.prePos] = inL;
    this.preR[this.prePos] = inR;
    this.prePos = (this.prePos + 1) % this.preL.length;

    this.early[this.earlyPos] = (dL + dR) * 0.5;
    let erL = 0;
    let erR = 0;
    for (const tap of this.taps) {
      const idx = (this.earlyPos - tap.delay + this.early.length) % this.early.length;
      const v = this.early[idx] * tap.gain;
      if (tap.right) erR += v;
      else erL += v;
    }
    this.earlyPos = (this.earlyPos + 1) % this.early.length;

    const damped = new Array<number>(8);
    for (let i = 0; i < 8; i++) {
      const buf = this.lines[i];
      const mod = Math.sin(this.phase[i]) * this.modDepth;
      this.phase[i] += this.modInc[i];
      const x = readFrac(buf, this.write[i] - this.baseLen[i] + mod);
      this.lp[i] += (x - this.lp[i]) * (1 - this.dampMix);
      damped[i] = this.lp[i];
    }

    for (let i = 0; i < 8; i++) {
      let mixed = 0;
      const row = HADAMARD_8[i];
      for (let j = 0; j < 8; j++) mixed += row[j] * damped[j];
      const inj = (i % 2 === 0 ? dL : dR) * 0.5;
      const buf = this.lines[i];
      buf[this.write[i]] = mixed * this.feedback + inj;
      this.write[i] = (this.write[i] + 1) % buf.length;
    }

    let outL = erL;
    let outR = erR;
    for (let i = 0; i < 8; i++) {
      if (i % 2 === 0) outL += damped[i];
      else outR += damped[i];
    }
    outL *= this.outGain;
    outR *= this.outGain;
    const mid = (outL + outR) * 0.5;
    const side = (outL - outR) * 0.5 * this.width;
    return [mid + side, mid - side];
  }
}

export class StereoDelay {
  private bufferL: Float32Array;
  private bufferR: Float32Array;
  private writePos = 0;
  private readonly delaySamples: number;
  private feedback = 0.35;
  private lpL = 0;
  private lpR = 0;

  constructor(sampleRate: number, bpm: number | undefined, beats = 0.1875) {
    const sec = bpm ? (60 / bpm) * beats * 4 : 0.375;
    this.delaySamples = Math.max(1, Math.floor(sec * sampleRate));
    this.bufferL = new Float32Array(this.delaySamples);
    this.bufferR = new Float32Array(this.delaySamples);
  }

  setFeedback(fb: number) {
    this.feedback = Math.max(0, Math.min(0.9, fb));
  }

  process(inL: number, inR: number): [number, number] {
    const readPos = (this.writePos + 1) % this.delaySamples;
    const dl = this.bufferL[readPos];
    const dr = this.bufferR[readPos];
    const wetL = dl;
    const wetR = dr;
    const fbL = dl * this.feedback;
    const fbR = dr * this.feedback;
    this.lpL = this.lpL * 0.7 + fbL * 0.3;
    this.lpR = this.lpR * 0.7 + fbR * 0.3;
    this.bufferL[this.writePos] = inL + this.lpR;
    this.bufferR[this.writePos] = inR + this.lpL;
    this.writePos = (this.writePos + 1) % this.delaySamples;
    return [wetL, wetR];
  }
}

export function softClip(x: number, drive: number): number {
  const d = 1 + drive * 3;
  return Math.tanh(x * d) / Math.tanh(d);
}

/** Asymmetric soft clip. amount 0 is identity. Adds even harmonics, then the caller blocks DC. */
export function saturate(x: number, amount: number): number {
  if (amount <= 0) return x;
  const bias = amount * 0.15;
  const d = 1 + amount * 4;
  const norm = Math.tanh(d);
  return Math.tanh((x + bias) * d) / norm - Math.tanh(bias * d) / norm;
}

export function peakLimit(buffer: Float32Array, ceiling = 0.891): void {
  let peak = 0;
  for (let i = 0; i < buffer.length; i++) peak = Math.max(peak, Math.abs(buffer[i]));
  if (peak > ceiling) {
    const s = ceiling / peak;
    for (let i = 0; i < buffer.length; i++) buffer[i] *= s;
  }
}

const TP_FACTOR = 4;
const TP_HALF = 16;
/** Polyphase Hann-windowed sinc taps for the 3 fractional positions between samples. */
const TP_TAPS: Float64Array[] = (() => {
  const phases: Float64Array[] = [];
  for (let p = 1; p < TP_FACTOR; p++) {
    const frac = p / TP_FACTOR;
    const taps = new Float64Array(2 * TP_HALF);
    let sum = 0;
    for (let j = -TP_HALF + 1; j <= TP_HALF; j++) {
      const u = j - frac;
      const v = (Math.sin(Math.PI * u) / (Math.PI * u)) * 0.5 * (1 + Math.cos((Math.PI * u) / TP_HALF));
      taps[j + TP_HALF - 1] = v;
      sum += v;
    }
    for (let k = 0; k < taps.length; k++) taps[k] /= sum;
    phases.push(taps);
  }
  return phases;
})();

/** Largest |value| of the 4x band-limited reconstruction between samples i and i+1 (excluding i itself). */
export function interSamplePeak(x: Float32Array, i: number): number {
  const n = x.length;
  let peak = 0;
  for (const taps of TP_TAPS) {
    let acc = 0;
    const j0 = Math.max(-TP_HALF + 1, -i);
    const j1 = Math.min(TP_HALF, n - 1 - i);
    for (let j = j0; j <= j1; j++) acc += x[i + j] * taps[j + TP_HALF - 1];
    const v = Math.abs(acc);
    if (v > peak) peak = v;
  }
  return peak;
}

export interface LimiterConfig {
  /** Sample-peak ceiling in dBFS. */
  ceiling?: number;
  lookaheadMs?: number;
  releaseMs?: number;
}

/**
 * Stereo-linked lookahead true-peak limiter, in place. The required gain at each
 * sample covers the 4x reconstruction up to the next sample, so inter-sample
 * overs from bright noise are caught too. Gain is the box-smoothed running
 * minimum of that requirement over the lookahead window: already down when a
 * peak arrives, and samples never pass the ceiling.
 * Returns the deepest gain reduction in dB (positive).
 */
export function lookaheadLimit(buffers: Float32Array[], sampleRate: number, cfg: LimiterConfig = {}): number {
  const ceiling = Math.pow(10, (cfg.ceiling ?? -1) / 20);
  const L = Math.max(1, Math.round(((cfg.lookaheadMs ?? 5) / 1000) * sampleRate));
  const releaseCoeff = Math.exp(-1 / (((cfg.releaseMs ?? 60) / 1000) * sampleRate));
  const n = buffers[0]?.length ?? 0;
  if (n === 0) return 0;

  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const b of buffers) {
      const s = Math.abs(b[i]);
      p = Math.max(p, s);
      // Adjacent samples well under the ceiling cannot reconstruct above it in practice.
      if (i + 1 < n && Math.max(s, Math.abs(b[i + 1])) > ceiling * 0.5) p = Math.max(p, interSamplePeak(b, i));
    }
    need[i] = p > ceiling ? ceiling / p : 1;
  }
  // An inter-sample peak between i and i+1 is shaped by both samples.
  for (let i = n - 1; i > 0; i--) if (need[i - 1] < need[i]) need[i] = need[i - 1];

  // Running min over [i, i+L] via a monotonic deque.
  const ahead = new Float32Array(n);
  const dq = new Int32Array(n + L + 1);
  let head = 0;
  let tail = 0;
  let next = 0;
  for (let i = 0; i < n; i++) {
    const end = Math.min(n - 1, i + L);
    while (next <= end) {
      while (tail > head && need[dq[tail - 1]] >= need[next]) tail--;
      dq[tail++] = next++;
    }
    while (dq[head] < i) head++;
    ahead[i] = need[dq[head]];
  }

  // Box average over [i-L, i]: every term is a min over a window containing i, so gain <= need[i].
  let sum = 0;
  let prev = 1;
  let deepest = 1;
  for (let i = 0; i < n; i++) {
    sum += ahead[i];
    if (i > L) sum -= ahead[i - L - 1];
    const box = sum / Math.min(i + 1, L + 1);
    const g = box < prev ? box : Math.min(box, prev * releaseCoeff + box * (1 - releaseCoeff));
    prev = g;
    if (g < deepest) deepest = g;
    for (const b of buffers) {
      const v = b[i] * g;
      b[i] = v > ceiling ? ceiling : v < -ceiling ? -ceiling : v;
    }
  }
  return -20 * Math.log10(deepest);
}

export function measureRmsDb(buffer: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] ** 2;
  const rms = Math.sqrt(sum / Math.max(1, buffer.length));
  return 20 * Math.log10(Math.max(1e-9, rms));
}

export function applyLoudnessMatch(buffers: Float32Array[], targetDb = -14): void {
  let sum = 0;
  let n = 0;
  for (const b of buffers) {
    for (let i = 0; i < b.length; i++) {
      sum += b[i] ** 2;
      n++;
    }
  }
  const rms = Math.sqrt(sum / Math.max(1, n));
  const currentDb = 20 * Math.log10(Math.max(1e-9, rms));
  const gain = Math.pow(10, (targetDb - currentDb) / 20);
  const capped = Math.min(gain, 4);
  for (const b of buffers) {
    for (let i = 0; i < b.length; i++) b[i] *= capped;
  }
}

/** In-place iterative radix-2 FFT; length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Magnitude-weighted mean frequency (Hz), from Hann-windowed 4096-point FFT frames,
 * averaged across frames weighted by frame energy. Frames >60 dB below the loudest are skipped.
 */
export function spectralCentroid(buf: Float32Array, sampleRate: number, frameSize = 4096): number {
  const n = frameSize;
  if (buf.length === 0) return 0;
  const window = new Float64Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));

  const starts: number[] = [];
  const energies: number[] = [];
  for (let s = 0; s < buf.length; s += n) {
    let e = 0;
    const end = Math.min(buf.length, s + n);
    for (let i = s; i < end; i++) e += buf[i] * buf[i];
    starts.push(s);
    energies.push(e);
  }
  const maxE = Math.max(...energies);
  if (maxE <= 0) return 0;

  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let num = 0;
  let den = 0;
  for (let f = 0; f < starts.length; f++) {
    if (energies[f] < maxE * 1e-6) continue;
    const s = starts[f];
    for (let i = 0; i < n; i++) {
      const idx = s + i;
      re[i] = idx < buf.length ? buf[idx] * window[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    let fNum = 0;
    let fDen = 0;
    for (let k = 1; k < n / 2; k++) {
      const mag = Math.hypot(re[k], im[k]);
      fNum += ((k * sampleRate) / n) * mag;
      fDen += mag;
    }
    if (fDen > 0) {
      num += (fNum / fDen) * energies[f];
      den += energies[f];
    }
  }
  return den > 0 ? num / den : 0;
}

export function stereoCorrelation(l: Float32Array, r: Float32Array): number {
  const n = Math.min(l.length, r.length, 44100);
  let sumL = 0;
  let sumR = 0;
  let sumLR = 0;
  let sumL2 = 0;
  let sumR2 = 0;
  for (let i = 0; i < n; i++) {
    sumL += l[i];
    sumR += r[i];
    sumLR += l[i] * r[i];
    sumL2 += l[i] * l[i];
    sumR2 += r[i] * r[i];
  }
  const denom = Math.sqrt(sumL2 * sumR2);
  return denom > 0 ? sumLR / denom : 1;
}
