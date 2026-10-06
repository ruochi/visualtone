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

export class Freeverb {
  private combL: number[][] = [];
  private combR: number[][] = [];
  private apL: number[][] = [];
  private apR: number[][] = [];
  private idx: number[] = [];
  private readonly sampleRate: number;
  private roomSize = 0.7;
  private damp = 0.4;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    const scales = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
    for (let i = 0; i < 8; i++) {
      const lenL = Math.floor(scales[i] * (sampleRate / 44100));
      const lenR = Math.floor((scales[i] + 23) * (sampleRate / 44100));
      this.combL.push(new Array(lenL).fill(0));
      this.combR.push(new Array(lenR).fill(0));
      this.idx.push(0);
    }
    const apLens = [556, 441, 341, 225];
    for (const len of apLens) {
      const l = Math.floor(len * (sampleRate / 44100));
      this.apL.push(new Array(l).fill(0));
      this.apR.push(new Array(l + 13).fill(0));
    }
    this.apIdxL = new Array(4).fill(0);
    this.apIdxR = new Array(4).fill(0);
  }

  private apIdxL: number[];
  private apIdxR: number[];

  setParams(size: number, decay: number) {
    this.roomSize = 0.3 + size * 0.7;
    this.damp = 0.2 + decay * 0.5;
  }

  processStereo(inL: number, inR: number): [number, number] {
    let outL = 0;
    let outR = 0;
    const feedback = this.roomSize;
    const damp1 = this.damp;

    for (let i = 0; i < 8; i++) {
      const bufL = this.combL[i];
      const bufR = this.combR[i];
      let il = this.idx[i] % bufL.length;
      let ir = this.idx[i] % bufR.length;
      const cl = bufL[il];
      const cr = bufR[ir];
      bufL[il] = inL + cl * feedback;
      bufR[ir] = inR + cr * feedback;
      outL += cl * (1 - damp1) + bufL[il] * damp1;
      outR += cr * (1 - damp1) + bufR[ir] * damp1;
      this.idx[i]++;
    }

    const apGain = 0.5;
    for (let i = 0; i < 4; i++) {
      const bufL = this.apL[i];
      const bufR = this.apR[i];
      let il = this.apIdxL[i] % bufL.length;
      let ir = this.apIdxR[i] % bufR.length;
      const vl = bufL[il];
      const vr = bufR[ir];
      outL = vl + apGain * (outL - vl);
      outR = vr + apGain * (outR - vr);
      bufL[il] = outL;
      bufR[ir] = outR;
      this.apIdxL[i]++;
      this.apIdxR[i]++;
    }

    return [outL * 0.06, outR * 0.06];
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
