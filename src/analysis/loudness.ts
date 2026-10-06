import { interSamplePeak } from '../fx.js';

/**
 * BS.1770-4 K-weighting and gated loudness.
 * A mono 997 Hz sine at 0 dBFS reads about -3.01 LUFS and -20 dBFS reads -23;
 * the same sine on both stereo channels reads 3 dB louder.
 */

interface BiquadCoeff {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function shelf(sampleRate: number): BiquadCoeff {
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  return {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
}

function highpass(sampleRate: number): BiquadCoeff {
  const f0 = 38.13547087602444;
  const Q = 0.5003270373238773;
  const K = Math.tan((Math.PI * f0) / sampleRate);
  const a0 = 1 + K / Q + K * K;
  return {
    b0: 1 / a0,
    b1: -2 / a0,
    b2: 1 / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
}

function applyBiquad(x: Float32Array, c: BiquadCoeff, out: Float32Array): void {
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = c.b0 * x[i] + z1;
    z1 = c.b1 * x[i] - c.a1 * y + z2;
    z2 = c.b2 * x[i] - c.a2 * y;
    out[i] = y;
  }
}

/** K-weighted copy of each channel. */
export function kWeight(buffers: Float32Array[], sampleRate: number): Float32Array[] {
  const s = shelf(sampleRate);
  const h = highpass(sampleRate);
  return buffers.map((b) => {
    const mid = new Float32Array(b.length);
    const out = new Float32Array(b.length);
    applyBiquad(b, s, mid);
    applyBiquad(mid, h, out);
    return out;
  });
}

const ABS_GATE = -70;
const REL_GATE = -10;

function blockLoudness(channels: Float32Array[], start: number, len: number): number {
  let ms = 0;
  for (const ch of channels) {
    let s = 0;
    const end = Math.min(ch.length, start + len);
    for (let i = start; i < end; i++) s += ch[i] * ch[i];
    ms += s / len;
  }
  return ms;
}

function lufsFromPower(ms: number): number {
  return -0.691 + 10 * Math.log10(Math.max(ms, 1e-12));
}

export interface Loudness {
  integratedLufs: number;
  /** EBU Tech 3342 loudness range. 0 when the clip is shorter than 3s. */
  rangeLufs: number;
  truePeakDbtp: number;
  samplePeak: number;
  /** true peak (dBTP) minus integrated LUFS. Higher means more dynamic. */
  plr: number;
  shortTermTimes: number[];
  shortTermLufs: number[];
}

export function measureLoudness(buffers: Float32Array[], sampleRate: number): Loudness {
  const weighted = kWeight(buffers, sampleRate);
  const block = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  const powers: number[] = [];
  for (let start = 0; start + block <= buffers[0].length; start += hop) {
    powers.push(blockLoudness(weighted, start, block));
  }
  const integratedLufs = gatedLufs(powers, REL_GATE);

  const stBlock = Math.round(3 * sampleRate);
  const shortTermTimes: number[] = [];
  const shortTermLufs: number[] = [];
  const stPowers: number[] = [];
  if (buffers[0].length >= stBlock) {
    for (let start = 0; start + stBlock <= buffers[0].length; start += hop) {
      const p = blockLoudness(weighted, start, stBlock);
      stPowers.push(p);
      shortTermTimes.push((start + stBlock / 2) / sampleRate);
      shortTermLufs.push(lufsFromPower(p));
    }
  }
  const rangeLufs = stPowers.length > 0 ? loudnessRange(stPowers) : 0;

  let samplePeak = 0;
  for (const b of buffers) {
    for (let i = 0; i < b.length; i++) samplePeak = Math.max(samplePeak, Math.abs(b[i]));
  }
  const truePeak = truePeakLinear(buffers);
  const truePeakDbtp = 20 * Math.log10(Math.max(truePeak, 1e-9));
  const plr = Number.isFinite(integratedLufs) ? truePeakDbtp - integratedLufs : 0;

  return { integratedLufs, rangeLufs, truePeakDbtp, samplePeak, plr, shortTermTimes, shortTermLufs };
}

function gatedLufs(powers: number[], relative: number): number {
  if (powers.length === 0) return -Infinity;
  const abs = powers.filter((p) => lufsFromPower(p) > ABS_GATE);
  if (abs.length === 0) return -Infinity;
  const absMean = abs.reduce((s, p) => s + p, 0) / abs.length;
  const relThresh = lufsFromPower(absMean) + relative;
  const rel = abs.filter((p) => lufsFromPower(p) > relThresh);
  if (rel.length === 0) return lufsFromPower(absMean);
  const mean = rel.reduce((s, p) => s + p, 0) / rel.length;
  return lufsFromPower(mean);
}

/** 10th–95th percentile of short-term loudness after the -20 LU relative gate. */
function loudnessRange(powers: number[]): number {
  const abs = powers.filter((p) => lufsFromPower(p) > ABS_GATE);
  if (abs.length < 2) return 0;
  const absMean = abs.reduce((s, p) => s + p, 0) / abs.length;
  const relThresh = lufsFromPower(absMean) - 20;
  const values = abs.map(lufsFromPower).filter((v) => v > relThresh).sort((a, b) => a - b);
  if (values.length < 2) return 0;
  const pct = (p: number) => {
    const x = (p / 100) * (values.length - 1);
    const i = Math.floor(x);
    const t = x - i;
    return values[i] * (1 - t) + values[Math.min(values.length - 1, i + 1)] * t;
  };
  return pct(95) - pct(10);
}

/**
 * 4x oversampled peak via a polyphase Hann-windowed sinc interpolator
 * (32 taps per phase). Catches inter-sample peaks that sample peaks miss,
 * without the block-edge ringing a zero-padded FFT adds.
 */
export function truePeakLinear(buffers: Float32Array[]): number {
  let peak = 0;
  for (const b of buffers) peak = Math.max(peak, oversamplePeak(b));
  return peak;
}

function oversamplePeak(x: Float32Array): number {
  const n = x.length;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]));
  for (let i = 0; i < n - 1; i++) {
    // Only neighbourhoods near the running peak can beat it; skip quiet stretches.
    if (Math.abs(x[i]) < peak * 0.5 && Math.abs(x[i + 1]) < peak * 0.5) continue;
    const v = interSamplePeak(x, i);
    if (v > peak) peak = v;
  }
  return peak;
}
