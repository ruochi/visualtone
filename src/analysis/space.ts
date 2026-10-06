import { Biquad } from '../mix.js';

export interface SpaceReport {
  /** Return-bus energy / (dry stems + returns). Null when the mix has no bus stems. */
  wetShare: number | null;
  busShares: { id: string; share: number }[];
  /** Median of tail RMS vs attack RMS, dB. More negative means the notes die faster. */
  tailRatioDb: number | null;
  tailTimes: number[];
  tailRatiosDb: number[];
}

function energy(l: ArrayLike<number>, r?: ArrayLike<number>): number {
  let e = 0;
  for (let i = 0; i < l.length; i++) e += l[i] * l[i] + (r ? r[i] * r[i] : 0);
  return e;
}

function rms(x: Float32Array, a: number, b: number): number {
  let s = 0;
  const n = Math.max(0, b - a);
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return n > 0 ? Math.sqrt(s / n) : 0;
}

/** Wet/dry from render bus stems, plus how much energy survives between hits. */
export function analyzeSpace(
  mono: Float32Array,
  sampleRate: number,
  onsets: number[],
  stems?: { id: string; l: Float32Array; r: Float32Array }[],
): SpaceReport {
  const buses = (stems ?? []).filter((s) => s.id.startsWith('bus:'));
  const dry = (stems ?? []).filter((s) => !s.id.startsWith('bus:'));
  let wetShare: number | null = null;
  const busShares: { id: string; share: number }[] = [];
  if (buses.length > 0 && dry.length > 0) {
    const dryE = dry.reduce((s, t) => s + energy(t.l, t.r), 0);
    const parts = buses.map((b) => ({ id: b.id, e: energy(b.l, b.r) }));
    const wetE = parts.reduce((s, p) => s + p.e, 0);
    const total = dryE + wetE || 1;
    wetShare = wetE / total;
    for (const p of parts) busShares.push({ id: p.id, share: p.e / total });
  }

  const head = Math.round(0.05 * sampleRate);
  const gap = Math.round(0.15 * sampleRate);
  const ratios: number[] = [];
  const times: number[] = [];
  for (let i = 0; i < onsets.length; i++) {
    const a = Math.round(onsets[i] * sampleRate);
    const next = i + 1 < onsets.length ? Math.round(onsets[i + 1] * sampleRate) : mono.length;
    if (a < 0 || next - a < gap + head) continue;
    const attack = rms(mono, a, Math.min(mono.length, a + head));
    const tail = rms(mono, Math.min(mono.length, a + gap), next);
    if (attack < 1e-5) continue;
    ratios.push(20 * Math.log10((tail + 1e-9) / attack));
    times.push(onsets[i]);
  }
  const sorted = [...ratios].sort((a, b) => a - b);
  const tailRatioDb = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : null;
  return { wetShare, busShares, tailRatioDb, tailTimes: times, tailRatiosDb: ratios };
}

/** Share of energy between lo and hi Hz. */
export function bandShare(buffer: Float32Array, sampleRate: number, lo: number, hi: number): number {
  const hp = new Biquad('highpass', sampleRate, lo);
  const lp = new Biquad('lowpass', sampleRate, hi);
  let band = 0;
  let all = 0;
  for (let i = 0; i < buffer.length; i++) {
    const y = lp.process(hp.process(buffer[i]));
    band += y * y;
    all += buffer[i] * buffer[i];
  }
  return all > 0 ? band / all : 0;
}
