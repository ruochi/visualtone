import { fft } from './fft.js';

export const BANDS = [
  { name: 'sub', lo: 20, hi: 60 },
  { name: 'bass', lo: 60, hi: 250 },
  { name: 'mid', lo: 250, hi: 2000 },
  { name: 'presence', lo: 2000, hi: 6000 },
  { name: 'air', lo: 6000, hi: 20000 },
] as const;

export interface LogBin {
  freqs: number[];
  groups: { k0: number; k1: number }[];
}

export function makeLogBins(sampleRate: number, frame: number, count = 64, fMin = 40, fMax = 16000): LogBin {
  const hi = Math.min(fMax, sampleRate * 0.45);
  const logMin = Math.log(fMin);
  const logMax = Math.log(hi);
  const freqs: number[] = [];
  const groups: { k0: number; k1: number }[] = [];
  for (let i = 0; i < count; i++) {
    const f0 = Math.exp(logMin + ((logMax - logMin) * i) / count);
    const f1 = Math.exp(logMin + ((logMax - logMin) * (i + 1)) / count);
    const k0 = Math.max(1, Math.floor((f0 * frame) / sampleRate));
    const k1 = Math.min(frame / 2, Math.max(k0 + 1, Math.ceil((f1 * frame) / sampleRate)));
    groups.push({ k0, k1 });
    freqs.push(Math.sqrt(f0 * f1));
  }
  return { freqs, groups };
}

export interface Spectrogram {
  times: number[];
  freqs: number[];
  /** dB relative to the peak, row-major [frame * bin]. */
  db: Float32Array;
  frames: number;
  bins: number;
  hop: number;
  frame: number;
  /** Half-wave-rectified spectral flux per frame. */
  flux: Float32Array;
  /** Pitch-class energy, row-major [frame * 12]. */
  chroma: Float32Array;
  /** Pitch-class energy below 180 Hz. */
  bassChroma: Float64Array;
  /** Bass pitch-class energy in the first 20% of the clip (loop home chord). */
  earlyBassChroma: Float64Array;
  /** Total power per named band. */
  bandPower: number[];
  /** Power per named band per frame, row-major. */
  bandFrame: Float32Array;
}

const hannCache = new Map<number, Float64Array>();

function hann(n: number): Float64Array {
  let w = hannCache.get(n);
  if (w) return w;
  w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  hannCache.set(n, w);
  return w;
}

export function spectrogram(
  buffer: Float32Array,
  sampleRate: number,
  frame = 4096,
  hop = 1024,
  logBins = 64,
): Spectrogram {
  const window = hann(frame);
  const { freqs, groups } = makeLogBins(sampleRate, frame, logBins);
  const frames = Math.max(1, Math.floor((buffer.length - frame) / hop) + 1);
  const db = new Float32Array(frames * logBins);
  const flux = new Float32Array(frames);
  const chroma = new Float32Array(frames * 12);
  const bassChroma = new Float64Array(12);
  const earlyBassChroma = new Float64Array(12);
  const earlyLimit = buffer.length * 0.1;
  const bandPower = BANDS.map(() => 0);
  const bandFrame = new Float32Array(frames * BANDS.length);
  const times: number[] = [];
  const re = new Float64Array(frame);
  const im = new Float64Array(frame);
  const prev = new Float64Array(logBins);
  let peak = 1e-12;

  const binHz = sampleRate / frame;
  const pcOf = new Int16Array(frame / 2);
  const bassBin = new Uint8Array(frame / 2);
  for (let k = 1; k < frame / 2; k++) {
    const f = k * binHz;
    if (f < 40 || f > 5000) {
      pcOf[k] = -1;
      continue;
    }
    const midi = 69 + 12 * Math.log2(f / 440);
    pcOf[k] = ((Math.round(midi) % 12) + 12) % 12;
    bassBin[k] = f < 180 ? 1 : 0;
  }
  const bandK: { k0: number; k1: number }[] = BANDS.map((b) => ({
    k0: Math.max(1, Math.floor((b.lo * frame) / sampleRate)),
    k1: Math.min(frame / 2, Math.ceil((b.hi * frame) / sampleRate)),
  }));

  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    for (let i = 0; i < frame; i++) {
      const idx = start + i;
      re[i] = idx < buffer.length ? buffer[idx] * window[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    let fluxSum = 0;
    for (let b = 0; b < logBins; b++) {
      const g = groups[b];
      let mag = 0;
      for (let k = g.k0; k < g.k1; k++) mag += Math.hypot(re[k], im[k]);
      const avg = mag / Math.max(1, g.k1 - g.k0);
      if (avg > peak) peak = avg;
      db[f * logBins + b] = avg;
      const d = avg - prev[b];
      if (d > 0) fluxSum += d;
      prev[b] = avg;
    }
    flux[f] = fluxSum;
    const row = f * 12;
    for (let k = 1; k < frame / 2; k++) {
      const pc = pcOf[k];
      if (pc < 0) continue;
      const mag = Math.hypot(re[k], im[k]);
      chroma[row + pc] += mag;
      if (bassBin[k]) {
        bassChroma[pc] += mag;
        if (start < earlyLimit) earlyBassChroma[pc] += mag;
      }
    }
    for (let b = 0; b < BANDS.length; b++) {
      const g = bandK[b];
      let p = 0;
      for (let k = g.k0; k < g.k1; k++) p += re[k] * re[k] + im[k] * im[k];
      bandPower[b] += p;
      bandFrame[f * BANDS.length + b] = p;
    }
    times.push((start + frame / 2) / sampleRate);
  }

  const floor = peak * 1e-4;
  for (let i = 0; i < db.length; i++) {
    db[i] = 20 * Math.log10(Math.max(db[i], floor) / peak);
  }
  return {
    times,
    freqs,
    db,
    frames,
    bins: logBins,
    hop,
    frame,
    flux,
    chroma,
    bassChroma,
    earlyBassChroma,
    bandPower,
    bandFrame,
  };
}

/** Mono sum. Stereo is averaged so a centered source keeps its level. */
export function mixdown(buffers: Float32Array[]): Float32Array {
  if (buffers.length === 1) return buffers[0];
  const n = buffers[0].length;
  const out = new Float32Array(n);
  const g = 1 / buffers.length;
  for (const b of buffers) {
    for (let i = 0; i < n; i++) out[i] += b[i] * g;
  }
  return out;
}
