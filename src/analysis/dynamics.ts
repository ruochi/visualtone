import { fft } from './fft.js';

export interface HitTrack {
  id: string;
  /** Standard deviation of per-hit peak level, dB. */
  variationDb: number;
  /** Standard deviation of the centroid of each hit's first 50 ms, Hz. */
  centroidHz: number;
  times: number[];
  peaksDb: number[];
}

export interface DynamicsReport {
  /** 25th percentile of per-track local hit variation. Null when none qualify. */
  hitVariationDb: number | null;
  tracks: HitTrack[];
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, v) => s + v, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length);
}

function centroid(x: Float32Array, sampleRate: number): number {
  const n = 1024;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n && i < x.length; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[i] = x[i] * w;
  }
  fft(re, im, false);
  let num = 0;
  let den = 0;
  for (let k = 1; k < n / 2; k++) {
    const m = Math.hypot(re[k], im[k]);
    num += m * ((k * sampleRate) / n);
    den += m;
  }
  return den > 0 ? num / den : 0;
}

/** How much consecutive hits on one stem differ in level and brightness. */
export function analyzeDynamics(
  stems: { id: string; l: Float32Array; r: Float32Array }[] | undefined,
  sampleRate: number,
): DynamicsReport {
  const tracks: HitTrack[] = [];
  const win = Math.round(0.05 * sampleRate);
  const hop = Math.round(0.01 * sampleRate);
  for (const stem of stems ?? []) {
    if (stem.id.startsWith('bus:')) continue;
    const n = stem.l.length;
    const env: number[] = [];
    for (let i = 0; i + win < n; i += hop) {
      let s = 0;
      for (let k = 0; k < win; k += 4) {
        const v = stem.l[i + k] + stem.r[i + k];
        s += v * v;
      }
      env.push(Math.sqrt(s / Math.ceil(win / 4)));
    }
    let mean = 0;
    for (const v of env) mean += v;
    mean /= Math.max(1, env.length);
    const times: number[] = [];
    const peaks: number[] = [];
    const centroids: number[] = [];
    let last = -1;
    for (let i = 1; i < env.length - 1; i++) {
      if (env[i] < mean * 1.5 || env[i] < env[i - 1] || env[i] <= env[i + 1]) continue;
      const t = (i * hop) / sampleRate;
      if (t - last < 0.08) continue;
      last = t;
      const a = Math.min(n - 1, Math.round(t * sampleRate));
      let peak = 0;
      const slice = new Float32Array(win);
      for (let k = 0; k < win && a + k < n; k++) {
        const v = (stem.l[a + k] + stem.r[a + k]) * 0.5;
        slice[k] = v;
        peak = Math.max(peak, Math.abs(v));
      }
      if (peak < 1e-5) continue;
      times.push(t);
      peaks.push(20 * Math.log10(peak));
      centroids.push(centroid(slice, sampleRate));
    }
    if (times.length < 16) continue;
    // Deviation from the level of nearby hits, so a section fade is not counted as groove.
    const local: number[] = [];
    for (let i = 0; i < peaks.length; i++) {
      const near: number[] = [];
      for (let j = 0; j < peaks.length; j++) if (Math.abs(times[j] - times[i]) <= 2) near.push(peaks[j]);
      near.sort((a, b) => a - b);
      local.push(peaks[i] - near[Math.floor(near.length / 2)]);
    }
    tracks.push({
      id: stem.id,
      variationDb: std(local),
      centroidHz: std(centroids),
      times,
      peaksDb: peaks,
    });
  }
  const vals = tracks.map((t) => t.variationDb).sort((a, b) => a - b);
  // 25th percentile: a few lively tracks must not hide the ones that never change.
  const hitVariationDb = vals.length > 0 ? vals[Math.floor(vals.length * 0.25)] : null;
  return { hitVariationDb, tracks };
}

/** Fraction of bar pairs 4 or 8 bars apart that are nearly identical. */
export function repetitionScore(ssm: number[][]): number {
  let n = 0;
  let same = 0;
  for (const lag of [4, 8]) {
    for (let i = 0; i + lag < ssm.length; i++) {
      n++;
      if (ssm[i][i + lag] > 0.98) same++;
    }
  }
  return n > 0 ? same / n : 0;
}
