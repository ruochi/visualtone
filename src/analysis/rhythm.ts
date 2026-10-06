import { Biquad } from '../mix.js';
import type { Spectrogram } from './stft.js';

export interface RhythmReport {
  /** Tempo from onset autocorrelation, or null when there is no pulse. */
  tempo: number | null;
  /** 0 = straight 16ths, 1 = triplet. Null when no off-beat cluster. */
  swing: number | null;
  onsetCount: number;
  onsetTimes: number[];
  /** Peak / RMS over the first 10ms of each low-end onset. Null without a thump. */
  kickPunch: number | null;
  /** RMS of the low band in 50ms steps over the first 0.5s. */
  kickEnvelope: number[];
  /** Bass level during kick attacks minus level between kicks, dB. Null without stems. */
  sidechainDb: number | null;
}

function parabolicPeaks(flux: Float32Array, hop: number, frame: number, sampleRate: number): number[] {
  let mean = 0;
  for (let i = 0; i < flux.length; i++) mean += flux[i];
  mean /= Math.max(1, flux.length);
  let v = 0;
  for (let i = 0; i < flux.length; i++) v += (flux[i] - mean) ** 2;
  const std = Math.sqrt(v / Math.max(1, flux.length));
  const thresh = mean + std * 0.5;
  const minGap = 0.05;
  const times: number[] = [];
  let last = -1;
  for (let i = 1; i < flux.length - 1; i++) {
    if (flux[i] < thresh || flux[i] < flux[i - 1] || flux[i] < flux[i + 1]) continue;
    const denom = flux[i - 1] - 2 * flux[i] + flux[i + 1];
    const delta = Math.abs(denom) < 1e-12 ? 0 : (0.5 * (flux[i - 1] - flux[i + 1])) / denom;
    // The window is centered on the frame, so the event sits frame/2 after the frame start.
    const t = ((i + delta) * hop + frame / 2) / sampleRate;
    if (t - last >= minGap) {
      times.push(t);
      last = t;
    }
  }
  return times;
}

function estimateTempo(flux: Float32Array, hop: number, sampleRate: number): number | null {
  const hopSec = hop / sampleRate;
  const minBpm = 70;
  const maxBpm = 160;
  const lagMin = Math.round(60 / maxBpm / hopSec);
  const lagMax = Math.min(flux.length - 2, Math.round(60 / minBpm / hopSec));
  if (lagMax <= lagMin + 2) return null;
  let best = 0;
  let bestLag = 0;
  const norm = flux.reduce((s, x) => s + x * x, 0);
  if (norm <= 0) return null;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let c = 0;
    for (let i = 0; i + lag < flux.length; i++) c += flux[i] * flux[i + lag];
    if (c > best) {
      best = c;
      bestLag = lag;
    }
  }
  if (bestLag === 0 || best / norm < 0.15) return null;
  const c = (lag: number) => {
    if (lag < 1 || lag + 1 >= flux.length) return 0;
    let s = 0;
    for (let i = 0; i + lag < flux.length; i++) s += flux[i] * flux[i + lag];
    return s;
  };
  const ym = c(bestLag - 1);
  const y0 = c(bestLag);
  const yp = c(bestLag + 1);
  const denom = ym - 2 * y0 + yp;
  const delta = Math.abs(denom) < 1e-9 ? 0 : (0.5 * (ym - yp)) / denom;
  const lag = bestLag + Math.max(-0.5, Math.min(0.5, delta));
  return 60 / (lag * hopSec);
}

function estimateSwing(onsets: number[], bpm: number): number | null {
  const pair = 60 / bpm / 2;
  const ons: number[] = [];
  const offs: number[] = [];
  for (const t of onsets) {
    const frac = (((t % pair) + pair) % pair) / pair;
    if (frac < 0.28 || frac > 0.88) ons.push(frac > 0.88 ? frac - 1 : frac);
    else if (frac >= 0.35 && frac <= 0.85) offs.push(frac);
  }
  if (offs.length < 3 || ons.length < 2) return null;
  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
  // Subtract the downbeat offset so a constant detection delay does not look like swing.
  const corrected = mean(offs) - mean(ons);
  return Math.max(0, Math.min(1, (corrected - 0.5) * 6));
}

function lowpass(buf: Float32Array, sampleRate: number, freq: number): Float32Array {
  const f = new Biquad('lowpass', sampleRate, freq);
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = f.process(buf[i]);
  return out;
}

function kickStats(mono: Float32Array, sampleRate: number): { punch: number | null; envelope: number[] } {
  const low = lowpass(mono, sampleRate, 120);
  const win = Math.floor(0.05 * sampleRate);
  const envelope: number[] = [];
  for (let k = 0; k < 10; k++) {
    let s = 0;
    const a = k * win;
    const b = Math.min(low.length, a + win);
    if (b <= a) {
      envelope.push(0);
      continue;
    }
    for (let i = a; i < b; i++) s += low[i] * low[i];
    envelope.push(Math.sqrt(s / (b - a)));
  }
  const envHop = Math.floor(0.005 * sampleRate);
  let maxEnv = 0;
  const env: number[] = [];
  for (let i = 0; i + envHop < low.length; i += envHop) {
    let s = 0;
    for (let k = 0; k < envHop; k++) s += low[i + k] * low[i + k];
    const e = Math.sqrt(s / envHop);
    env.push(e);
    if (e > maxEnv) maxEnv = e;
  }
  const punches: number[] = [];
  const attack = Math.floor(0.01 * sampleRate);
  const minDist = Math.floor(0.25 * sampleRate);
  let last = -minDist;
  for (let i = 1; i < env.length - 1; i++) {
    if (env[i] < maxEnv * 0.35 || env[i] < env[i - 1] || env[i] < env[i + 1]) continue;
    const at = i * envHop;
    if (at - last < minDist) continue;
    last = at;
    let peak = 0;
    let s = 0;
    const end = Math.min(low.length, at + attack);
    const n = Math.max(1, end - at);
    for (let k = at; k < end; k++) {
      peak = Math.max(peak, Math.abs(low[k]));
      s += low[k] * low[k];
    }
    const rms = Math.sqrt(s / n);
    if (rms > 1e-5) punches.push(peak / rms);
  }
  const punch = punches.length ? punches.reduce((a, b) => a + b, 0) / punches.length : null;
  return { punch, envelope };
}

export function sidechainDepth(
  kick: Float32Array,
  bass: Float32Array,
  sampleRate: number,
): number | null {
  const hop = Math.floor(0.005 * sampleRate);
  let maxE = 0;
  const env: number[] = [];
  for (let i = 0; i + hop < kick.length; i += hop) {
    let s = 0;
    for (let k = 0; k < hop; k++) s += kick[i + k] * kick[i + k];
    const e = Math.sqrt(s / hop);
    env.push(e);
    if (e > maxE) maxE = e;
  }
  if (maxE < 1e-4) return null;
  const depths: number[] = [];
  const minDist = Math.floor(0.25 * sampleRate);
  let last = -minDist;
  const early = Math.floor(0.05 * sampleRate);
  const lateA = Math.floor(0.18 * sampleRate);
  const lateB = Math.floor(0.35 * sampleRate);
  for (let i = 1; i < env.length - 1; i++) {
    if (env[i] < maxE * 0.4 || env[i] < env[i - 1] || env[i] <= env[i + 1]) continue;
    const at = i * hop;
    if (at - last < minDist || at + lateB >= bass.length) continue;
    last = at;
    let a = 0;
    let b = 0;
    for (let k = 0; k < early; k++) a += bass[at + k] * bass[at + k];
    for (let k = lateA; k < lateB; k++) b += bass[at + k] * bass[at + k];
    const ra = Math.sqrt(a / early);
    const rb = Math.sqrt(b / (lateB - lateA));
    if (rb > 1e-5) depths.push(20 * Math.log10((ra + 1e-9) / rb));
  }
  if (depths.length < 2) return null;
  depths.sort((x, y) => x - y);
  return depths[Math.floor(depths.length / 2)];
}

export function analyzeRhythm(
  mono: Float32Array,
  sampleRate: number,
  spec: Spectrogram,
  bpmHint?: number,
  stems?: { id: string; l: Float32Array; r: Float32Array }[],
): RhythmReport {
  const onsetTimes = parabolicPeaks(spec.flux, spec.hop, spec.frame, sampleRate);
  const tempo = bpmHint && bpmHint > 0 ? null : estimateTempo(spec.flux, spec.hop, sampleRate);
  const gridBpm = bpmHint && bpmHint > 0 ? bpmHint : tempo;
  const swing = gridBpm ? estimateSwing(onsetTimes, gridBpm) : null;
  const { punch, envelope } = kickStats(mono, sampleRate);

  let sidechainDb: number | null = null;
  if (stems && stems.length > 1) {
    const kick = stems.find((s) => /kick/i.test(s.id));
    const bass = stems.find((s) => /bass/i.test(s.id));
    if (kick && bass) {
      const km = new Float32Array(kick.l.length);
      const bm = new Float32Array(bass.l.length);
      for (let i = 0; i < km.length; i++) {
        km[i] = (kick.l[i] + kick.r[i]) * 0.5;
        bm[i] = (bass.l[i] + bass.r[i]) * 0.5;
      }
      sidechainDb = sidechainDepth(km, bm, sampleRate);
    }
  }

  return {
    tempo: bpmHint && bpmHint > 0 ? estimateTempo(spec.flux, spec.hop, sampleRate) : tempo,
    swing,
    onsetCount: onsetTimes.length,
    onsetTimes,
    kickPunch: punch,
    kickEnvelope: envelope,
    sidechainDb,
  };
}
