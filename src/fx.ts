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

export function spectralCentroid(buf: Float32Array, sampleRate: number): number {
  const n = Math.min(buf.length, 8192);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const w = buf[i] * buf[i];
    num += (i * sampleRate) / n * w;
    den += w;
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
