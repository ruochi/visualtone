import { Biquad } from '../mix.js';
import { fft } from './fft.js';
import { makeLogBins } from './stft.js';

export interface MaskingReport {
  trackIds: string[];
  /** Share of total stem power, sums to 1. */
  shares: number[];
  /** Pairwise overlap in [0, 1], 1 = identical time-frequency energy. */
  overlap: number[][];
  pairs: { a: string; b: string; overlap: number; cover: number; bandLo: number; bandHi: number }[];
  /** 10*log10(E_left / E_right) below 120 Hz, per stem (pre channel-routing). */
  lowBalanceDb: number[];
  /** Low-band energy per stem, used to find who owns the bass. */
  lowEnergy: number[];
  /** Per-stem log spectrogram, same grid for every stem. */
  spec: {
    times: number[];
    freqs: number[];
    frames: number;
    bins: number;
    db: Float32Array[];
  };
}

interface ErbBand {
  lo: number;
  hi: number;
  k0: number;
  k1: number;
}

function erbBands(sampleRate: number, frame: number): ErbBand[] {
  const bands: ErbBand[] = [];
  let f = 50;
  const nyquist = sampleRate * 0.45;
  while (f < Math.min(16000, nyquist) && bands.length < 24) {
    const width = 1.35 * 24.7 * (4.37 * (f / 1000) + 1);
    const f2 = Math.min(nyquist, f + width);
    const k0 = Math.max(1, Math.floor((f * frame) / sampleRate));
    const k1 = Math.min(frame / 2, Math.max(k0 + 1, Math.ceil((f2 * frame) / sampleRate)));
    bands.push({ lo: f, hi: f2, k0, k1 });
    f = f2;
  }
  return bands;
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

/**
 * Time-frequency overlap between stems. Overlap is
 * 2 * sum(min(Ea, Eb)) / sum(Ea + Eb) across ERB bands and frames.
 */
export function analyzeMasking(
  stems: { id: string; l: Float32Array; r: Float32Array }[],
  sampleRate: number,
): MaskingReport {
  const frame = 2048;
  const hop = 2048;
  const n = stems[0]?.l.length ?? 0;
  const frames = Math.max(1, Math.floor((n - frame) / hop) + 1);
  const bands = erbBands(sampleRate, frame);
  const log = makeLogBins(sampleRate, frame, 48);
  const window = hann(frame);
  const re = new Float64Array(frame);
  const im = new Float64Array(frame);

  const powers: Float32Array[] = [];
  const specDb: Float32Array[] = [];
  const totals: number[] = [];
  const lowBalanceDb: number[] = [];
  const lowEnergy: number[] = [];
  let peak = 1e-12;

  for (const stem of stems) {
    const erb = new Float32Array(frames * bands.length);
    const db = new Float32Array(frames * log.freqs.length);
    let total = 0;
    for (let f = 0; f < frames; f++) {
      const start = f * hop;
      for (let i = 0; i < frame; i++) {
        const idx = start + i;
        const sample = idx < n ? (stem.l[idx] + stem.r[idx]) * 0.5 : 0;
        re[i] = sample * window[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let b = 0; b < bands.length; b++) {
        let p = 0;
        for (let k = bands[b].k0; k < bands[b].k1; k++) p += re[k] * re[k] + im[k] * im[k];
        erb[f * bands.length + b] = p;
        total += p;
      }
      for (let b = 0; b < log.groups.length; b++) {
        const g = log.groups[b];
        let mag = 0;
        for (let k = g.k0; k < g.k1; k++) mag += Math.hypot(re[k], im[k]);
        const avg = mag / Math.max(1, g.k1 - g.k0);
        if (avg > peak) peak = avg;
        db[f * log.freqs.length + b] = avg;
      }
    }
    powers.push(erb);
    specDb.push(db);
    totals.push(total);

    const lpL = new Biquad('lowpass', sampleRate, 120);
    const lpR = new Biquad('lowpass', sampleRate, 120);
    let el = 0;
    let er = 0;
    for (let i = 0; i < n; i++) {
      const a = lpL.process(stem.l[i]);
      const b = lpR.process(stem.r[i]);
      el += a * a;
      er += b * b;
    }
    lowBalanceDb.push(10 * Math.log10((el + 1e-12) / (er + 1e-12)));
    lowEnergy.push(el + er);
  }

  const floor = peak * 1e-4;
  for (const db of specDb) {
    for (let i = 0; i < db.length; i++) db[i] = 20 * Math.log10(Math.max(db[i], floor) / peak);
  }

  const sumTotal = totals.reduce((s, v) => s + v, 0) || 1;
  const shares = totals.map((t) => t / sumTotal);
  const overlap: number[][] = stems.map(() => stems.map(() => 0));
  const pairs: MaskingReport['pairs'] = [];

  for (let a = 0; a < stems.length; a++) {
    for (let b = a + 1; b < stems.length; b++) {
      let num = 0;
      let den = 0;
      let rawMin = 0;
      let sumA = 0;
      let sumB = 0;
      const perBand = new Float64Array(bands.length);
      const pa = powers[a];
      const pb = powers[b];
      // Normalize each stem so a quiet track can still show it occupies the same slots.
      const scaleA = totals[a] || 1;
      const scaleB = totals[b] || 1;
      for (let i = 0; i < pa.length; i++) {
        const ea = pa[i];
        const eb = pb[i];
        const raw = ea < eb ? ea : eb;
        rawMin += raw;
        sumA += ea;
        sumB += eb;
        const va = ea / scaleA;
        const vb = eb / scaleB;
        const m = va < vb ? va : vb;
        num += m;
        den += va + vb;
        perBand[i % bands.length] += raw;
      }
      const value = den > 0 ? (2 * num) / den : 0;
      const cover = sumA <= sumB ? (sumA > 0 ? rawMin / sumA : 0) : sumB > 0 ? rawMin / sumB : 0;
      overlap[a][b] = overlap[b][a] = value;
      let worst = 0;
      for (let i = 1; i < perBand.length; i++) if (perBand[i] > perBand[worst]) worst = i;
      if (value > 0.15 || cover > 0.45) {
        pairs.push({
          a: stems[a].id,
          b: stems[b].id,
          overlap: value,
          cover,
          bandLo: bands[worst].lo,
          bandHi: bands[worst].hi,
        });
      }
    }
  }
  pairs.sort((x, y) => Math.max(y.overlap, y.cover) - Math.max(x.overlap, x.cover));

  const times: number[] = [];
  for (let f = 0; f < frames; f++) times.push((f * hop + frame / 2) / sampleRate);

  return {
    trackIds: stems.map((s) => s.id),
    shares,
    overlap,
    pairs: pairs.slice(0, 16),
    lowBalanceDb,
    lowEnergy,
    spec: { times, freqs: log.freqs, frames, bins: log.freqs.length, db: specDb },
  };
}
