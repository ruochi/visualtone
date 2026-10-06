import { BANDS, type Spectrogram } from './stft.js';

export interface StructureReport {
  /** Seconds per column (one bar when bpm is known, otherwise 2s). */
  windowSec: number;
  times: number[];
  energyDb: number[];
  /** Mean of the loudest quarter of windows minus the quietest quarter, dB. */
  contrastDb: number;
  /** Self-similarity of per-window chroma + band features. */
  ssm: number[][];
  novelty: number[];
}

function cosine(a: number[], b: number[]): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const n = Math.sqrt(na * nb);
  return n > 0 ? d / n : 0;
}

export function analyzeStructure(
  mono: Float32Array,
  spec: Spectrogram,
  sampleRate: number,
  duration: number,
  bpm?: number,
): StructureReport {
  const windowSec = bpm && bpm > 0 ? (4 * 60) / bpm : 2;
  const columns = Math.max(1, Math.round(duration / windowSec));
  const feats: number[][] = [];
  const energy: number[] = [];
  const times: number[] = [];

  for (let c = 0; c < columns; c++) {
    const t0 = c * windowSec;
    const t1 = t0 + windowSec;
    times.push(t0 + windowSec / 2);
    const chroma = new Array(12).fill(0);
    const bands = new Array(BANDS.length).fill(0);
    let n = 0;
    for (let f = 0; f < spec.frames; f++) {
      if (spec.times[f] < t0 || spec.times[f] >= t1) continue;
      n++;
      for (let pc = 0; pc < 12; pc++) chroma[pc] += spec.chroma[f * 12 + pc];
      for (let b = 0; b < BANDS.length; b++) bands[b] += spec.bandFrame[f * BANDS.length + b];
    }
    const cSum = chroma.reduce((s: number, v: number) => s + v, 0) || 1;
    const bSum = bands.reduce((s: number, v: number) => s + v, 0) || 1;
    feats.push([...chroma.map((v: number) => v / cSum), ...bands.map((v: number) => v / bSum)]);
    const a = Math.min(mono.length, Math.floor(t0 * sampleRate));
    const b = Math.min(mono.length, Math.floor(t1 * sampleRate));
    let sum = 0;
    for (let i = a; i < b; i++) sum += mono[i] * mono[i];
    const rms = b > a ? Math.sqrt(sum / (b - a)) : 0;
    energy.push(20 * Math.log10(rms + 1e-12));
    void n;
  }

  // Shift energy so the loudest window is 0 dB; absolute FFT scaling is arbitrary.
  const peak = Math.max(...energy);
  const energyDb = energy.map((e) => e - peak);

  // Loudest quarter minus quietest quarter, so a flat loop scores near 0
  // and an intro-to-drop arrangement scores the gap between them.
  const ranked = [...energyDb].sort((a, b) => a - b);
  const q = Math.max(1, Math.floor(ranked.length / 4));
  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
  const contrastDb = ranked.length >= 4 ? mean(ranked.slice(-q)) - mean(ranked.slice(0, q)) : 0;

  const ssm: number[][] = feats.map((a) => feats.map((b) => cosine(a, b)));
  const novelty: number[] = [];
  const K = 2;
  for (let i = 0; i < columns; i++) {
    let v = 0;
    let w = 0;
    for (let a = 1; a <= K; a++) {
      for (let b = 1; b <= K; b++) {
        const i1 = i - a;
        const i2 = i + b;
        if (i1 < 0 || i2 >= columns) continue;
        v += ssm[i1][i1] + ssm[i2][i2] - ssm[i1][i2] - ssm[i2][i1];
        w++;
      }
    }
    novelty.push(w > 0 ? v / w : 0);
  }

  return { windowSec, times, energyDb, contrastDb, ssm, novelty };
}
