import { fft } from './fft.js';
import type { Finding } from './types.js';

/** Milliseconds after the onset where the envelope and brightness curves are sampled. */
export const CURVE_MS = [5, 10, 25, 50, 100, 200, 400, 800, 1600, 3200];
const MAX_REGION_SEC = 8;
const MEL_BANDS = 40;
const MFCC_COUNT = 13;
const HARMONICS_REPORTED = 16;
const DECAY_PARTIALS = 8;
const MEL_FRAMES_SEC = 3;

export interface NoteOptions {
  /** Region start in seconds. Default 0. */
  start?: number;
  /** Region end in seconds. Default start + 8 s or the end of the buffer. */
  stop?: number;
  /** Note-off time in seconds. Enables the release measurement and bounds the decay fits. */
  noteOff?: number;
  /** Expected pitch. Enables `centsOff`. */
  midi?: number;
}

export interface NoteFeatures {
  /** Seconds, where the envelope first reaches 10% of its peak. */
  onsetSec: number;
  /** Measured first partial, or the YIN median when no partial was found. */
  f0Hz: number | null;
  /** f0 against the expected `midi`, cents. */
  centsOff: number | null;
  pitch: {
    stdCents: number | null;
    /** End of the note minus its start, from a linear fit. */
    driftCents: number | null;
    /** First 60 ms of the pitch track against the note median. Positive starts sharp. */
    glideCents: number | null;
    vibratoRateHz: number | null;
    vibratoDepthCents: number | null;
    /** Cents left after the slow drift and the vibrato sinusoid are removed. A frozen oscillator sits near 0. */
    jitterCents: number | null;
  };
  envelope: {
    peakDb: number;
    /** 10% to 90% of the peak. */
    attackMs: number;
    /** 10% to the peak. */
    peakMs: number;
    /** Positive dB per second. Near 0 for a sustained tone. */
    decayDbPerSec: number | null;
    /** Peak down to -12 dB. */
    earlyDecayDbPerSec: number | null;
    /** -12 dB down to the floor. A piano decays fast early and slowly late. */
    lateDecayDbPerSec: number | null;
    t60Sec: number | null;
    /** Note-off to 30 dB below the level at note-off. */
    releaseMs: number | null;
    temporalCentroidSec: number;
    /** dB against the peak at CURVE_MS after the onset. */
    curve: { tMs: number; db: number | null }[];
    /** Envelope modulation from 8 to 20 Hz, dB against the mean level. Above the vibrato, where a real note keeps moving. */
    shimmerDb: number | null;
  };
  spectrum: {
    centroidHz: number;
    centroidAttackHz: number | null;
    centroidSustainHz: number | null;
    /** Centroid in multiples of f0. */
    brightness: number | null;
    rolloffHz: number;
    /** 0 tonal .. 1 white noise, first 30 ms. */
    flatnessAttack: number | null;
    flatnessSustain: number | null;
    curve: { tMs: number; hz: number | null }[];
    /** Mean log-mel spectrum, dB against its loudest band. */
    melDb: number[];
    mfcc: number[];
    hopSec: number;
    /** Log-mel frames from the onset, dB against the loudest cell, floored at -80. */
    melFrames: number[][];
    /** High partials reach half their peak this many ms after the low ones. Brass is positive; a hammer is negative. */
    brightnessLagMs: number | null;
  };
  harmonics: {
    /** Partials 1..16, dB against the loudest. Null where no partial was found. */
    amplitudesDb: (number | null)[];
    /** Partial n frequency over partial 1. A stiff string runs above n. */
    freqRatios: (number | null)[];
    slopeDbPerOct: number | null;
    /** Odd partials 3, 5, … against even partials, dB. A clarinet is high, a saw is near -3. */
    oddEvenDb: number | null;
    /** B in f_n = n·f0·√(1 + B·n²). */
    inharmonicity: number | null;
    hnrDb: number | null;
    /** Peaks off the partial series against the harmonic energy, dB. Aliasing shows here. */
    spuriousDb: number | null;
    /** Partials 1..8, positive dB per second. */
    decayDbPerSec: (number | null)[];
    /** Sustain wobble of one partial against the others, dB. Shared vibrato loudness is removed first. */
    flutterDb: number | null;
  };
  /** Strongest spectral peaks right after the onset. */
  peaks: { hz: number; ratio: number | null; db: number }[];
  artifacts: {
    clicks: number;
    clickTimes: number[];
    dcOffset: number;
    nonFinite: number;
  };
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function linFit(xs: number[], ys: number[]): { slope: number; intercept: number } | null {
  const n = xs.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx <= 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

function pdb(p: number): number {
  return 10 * Math.log10(Math.max(p, 1e-30));
}

export function midiHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function noteName(midi: number): string {
  const m = Math.round(midi);
  return `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

const windows = new Map<string, Float64Array>();
function windowOf(kind: 'hann' | 'bh', n: number): Float64Array {
  const key = `${kind}${n}`;
  let w = windows.get(key);
  if (w) return w;
  w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = (2 * Math.PI * i) / (n - 1);
    w[i] =
      kind === 'hann'
        ? 0.5 - 0.5 * Math.cos(p)
        : 0.35875 - 0.48829 * Math.cos(p) + 0.14128 * Math.cos(2 * p) - 0.01168 * Math.cos(3 * p);
  }
  windows.set(key, w);
  return w;
}

/** Power spectrum of x[start, start+n) under a window; samples outside the buffer are 0. */
function powerSpectrum(x: Float32Array, start: number, n: number, w: Float64Array, re: Float64Array, im: Float64Array): Float32Array {
  for (let i = 0; i < n; i++) {
    const idx = start + i;
    re[i] = idx >= 0 && idx < x.length ? x[idx] * w[i] : 0;
    im[i] = 0;
  }
  fft(re, im);
  const out = new Float32Array(n / 2);
  for (let k = 0; k < n / 2; k++) out[k] = re[k] * re[k] + im[k] * im[k];
  return out;
}

/** YIN on 10 ms hops. Frames quieter than `gate` RMS are skipped. */
function yinTrack(x: Float32Array, sr: number, from: number, to: number, gate: number): { times: number[]; f0: number[] } {
  const maxLag = Math.floor(sr / 25);
  const minLag = Math.max(2, Math.floor(sr / 4500));
  const W = Math.max(maxLag, Math.round(0.03 * sr));
  const L = nextPow2(W + maxLag + 1);
  const hop = Math.max(1, Math.round(0.01 * sr));
  const aRe = new Float64Array(L);
  const aIm = new Float64Array(L);
  const bRe = new Float64Array(L);
  const bIm = new Float64Array(L);
  const pre = new Float64Array(W + maxLag + 1);
  const cm = new Float64Array(maxLag + 2);
  const times: number[] = [];
  const f0: number[] = [];
  for (let s = Math.max(0, from); s + W + maxLag <= to; s += hop) {
    let e = 0;
    for (let j = 0; j < W; j++) e += x[s + j] * x[s + j];
    if (Math.sqrt(e / W) < gate) continue;
    aRe.fill(0);
    aIm.fill(0);
    bRe.fill(0);
    bIm.fill(0);
    for (let j = 0; j < W; j++) aRe[j] = x[s + j];
    for (let j = 0; j < W + maxLag; j++) bRe[j] = x[s + j];
    fft(aRe, aIm);
    fft(bRe, bIm);
    for (let k = 0; k < L; k++) {
      const re = aRe[k] * bRe[k] + aIm[k] * bIm[k];
      const im = aRe[k] * bIm[k] - aIm[k] * bRe[k];
      aRe[k] = re;
      aIm[k] = im;
    }
    fft(aRe, aIm, true);
    pre[0] = 0;
    for (let j = 0; j < W + maxLag; j++) pre[j + 1] = pre[j] + x[s + j] * x[s + j];
    cm[0] = 1;
    let run = 0;
    for (let t = 1; t <= maxLag; t++) {
      const d = pre[W] + (pre[t + W] - pre[t]) - 2 * aRe[t];
      run += d;
      cm[t] = run > 0 ? (d * t) / run : 1;
    }
    let tau = -1;
    for (let t = minLag; t <= maxLag; t++) {
      if (cm[t] < 0.12) {
        while (t + 1 <= maxLag && cm[t + 1] < cm[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      let best = minLag;
      for (let t = minLag; t <= maxLag; t++) if (cm[t] < cm[best]) best = t;
      if (cm[best] < 0.35) tau = best;
    }
    if (tau < 0) continue;
    let shift = 0;
    if (tau > 1 && tau < maxLag) {
      const a = cm[tau - 1];
      const b = cm[tau];
      const c = cm[tau + 1];
      const den = a - 2 * b + c;
      if (Math.abs(den) > 1e-12) shift = (0.5 * (a - c)) / den;
    }
    times.push((s + W / 2) / sr);
    f0.push(sr / (tau + Math.max(-0.5, Math.min(0.5, shift))));
  }
  return { times, f0 };
}

interface MelBank {
  lo: Int32Array;
  weights: Float64Array[];
}
const melBanks = new Map<string, MelBank>();
function melBank(sr: number, n: number): MelBank {
  const key = `${sr}:${n}`;
  let bank = melBanks.get(key);
  if (bank) return bank;
  const mel = (f: number) => 2595 * Math.log10(1 + f / 700);
  const hz = (m: number) => 700 * (Math.pow(10, m / 2595) - 1);
  const fMax = Math.min(16000, sr * 0.45);
  const m0 = mel(40);
  const m1 = mel(fMax);
  const edges: number[] = [];
  for (let i = 0; i < MEL_BANDS + 2; i++) edges.push(hz(m0 + ((m1 - m0) * i) / (MEL_BANDS + 1)));
  const binHz = sr / n;
  const lo = new Int32Array(MEL_BANDS);
  const weights: Float64Array[] = [];
  for (let b = 0; b < MEL_BANDS; b++) {
    const [fa, fb, fc] = [edges[b], edges[b + 1], edges[b + 2]];
    const k0 = Math.max(1, Math.floor(fa / binHz));
    const k1 = Math.min(n / 2 - 1, Math.ceil(fc / binHz));
    const w = new Float64Array(Math.max(1, k1 - k0 + 1));
    let sum = 0;
    for (let k = k0; k <= k1; k++) {
      const f = k * binHz;
      const v = f <= fb ? (f - fa) / (fb - fa) : (fc - f) / (fc - fb);
      w[k - k0] = Math.max(0, v);
      sum += w[k - k0];
    }
    if (sum === 0) w[Math.min(w.length - 1, Math.max(0, Math.round(fb / binHz) - k0))] = 1;
    lo[b] = k0;
    weights.push(w);
  }
  bank = { lo, weights };
  melBanks.set(key, bank);
  return bank;
}

function dct(x: number[], count: number): number[] {
  const m = x.length;
  const out: number[] = [];
  for (let k = 0; k < count; k++) {
    let s = 0;
    for (let b = 0; b < m; b++) s += x[b] * Math.cos((Math.PI * k * (b + 0.5)) / m);
    out.push(s * (k === 0 ? Math.sqrt(1 / m) : Math.sqrt(2 / m)));
  }
  return out;
}

function emptyFeatures(onsetSec: number, nonFinite: number): NoteFeatures {
  return {
    onsetSec,
    f0Hz: null,
    centsOff: null,
    pitch: { stdCents: null, driftCents: null, glideCents: null, vibratoRateHz: null, vibratoDepthCents: null, jitterCents: null },
    envelope: {
      peakDb: -Infinity,
      attackMs: 0,
      peakMs: 0,
      decayDbPerSec: null,
      earlyDecayDbPerSec: null,
      lateDecayDbPerSec: null,
      t60Sec: null,
      releaseMs: null,
      temporalCentroidSec: 0,
      curve: CURVE_MS.map((tMs) => ({ tMs, db: null })),
      shimmerDb: null,
    },
    spectrum: {
      centroidHz: 0,
      centroidAttackHz: null,
      centroidSustainHz: null,
      brightness: null,
      rolloffHz: 0,
      flatnessAttack: null,
      flatnessSustain: null,
      curve: CURVE_MS.map((tMs) => ({ tMs, hz: null })),
      melDb: [],
      mfcc: [],
      hopSec: 0,
      melFrames: [],
      brightnessLagMs: null,
    },
    harmonics: {
      amplitudesDb: [],
      freqRatios: [],
      slopeDbPerOct: null,
      oddEvenDb: null,
      inharmonicity: null,
      hnrDb: null,
      spuriousDb: null,
      decayDbPerSec: [],
      flutterDb: null,
    },
    peaks: [],
    artifacts: { clicks: 0, clickTimes: [], dcOffset: 0, nonFinite },
  };
}

/**
 * Measure one note: pitch, envelope, partials, brightness, artifacts.
 * Give `start`/`stop` to pick the note out of a longer buffer.
 */
export function analyzeNote(buffer: Float32Array, sampleRate: number, opts: NoteOptions = {}): NoteFeatures {
  const sr = sampleRate;
  const startSec = Math.max(0, opts.start ?? 0);
  const a0 = Math.min(buffer.length, Math.floor(startSec * sr));
  const stopSec = opts.stop ?? startSec + MAX_REGION_SEC;
  const b0 = Math.max(a0, Math.min(buffer.length, Math.floor(stopSec * sr)));
  const x = new Float32Array(b0 - a0);
  let nonFinite = 0;
  let sum = 0;
  let peakAbs = 0;
  for (let i = 0; i < x.length; i++) {
    const v = buffer[a0 + i];
    if (!Number.isFinite(v)) {
      nonFinite++;
      continue;
    }
    x[i] = v;
    sum += v;
    peakAbs = Math.max(peakAbs, Math.abs(v));
  }
  if (peakAbs < 1e-9 || x.length < Math.round(0.02 * sr)) return emptyFeatures(startSec, nonFinite);

  // Coarse 5 ms RMS for the onset and the YIN gate.
  const cHop = Math.max(1, Math.round(0.001 * sr));
  const cWin = Math.max(1, Math.round(0.005 * sr));
  const coarse: number[] = [];
  let cPeak = 0;
  for (let s = 0; s + cWin <= x.length; s += cHop) {
    let e = 0;
    for (let j = 0; j < cWin; j++) e += x[s + j] * x[s + j];
    const r = Math.sqrt(e / cWin);
    coarse.push(r);
    cPeak = Math.max(cPeak, r);
  }
  // A steady tone can peak anywhere, so pitch tracking starts where the level first reaches half.
  let cRise = 0;
  while (cRise < coarse.length - 1 && coarse[cRise] < 0.5 * cPeak) cRise++;
  const riseAt = cRise * cHop;

  const yin = yinTrack(x, sr, riseAt + Math.round(0.02 * sr), Math.min(x.length, riseAt + Math.round(1.6 * sr)), cPeak * 0.01);
  let f0Yin = median(yin.f0);
  let cents: number[] = [];
  let ctimes: number[] = [];
  if (f0Yin) {
    for (let i = 0; i < yin.f0.length; i++) {
      const c = 1200 * Math.log2(yin.f0[i] / f0Yin);
      if (Math.abs(c) > 300) continue;
      cents.push(c);
      ctimes.push(yin.times[i]);
    }
    if (cents.length < 3) {
      f0Yin = null;
      cents = [];
      ctimes = [];
    }
  }

  // Fine envelope: max |x| over one period, 0.5 ms hop.
  const period = f0Yin ? sr / f0Yin : 0.01 * sr;
  const fw = Math.max(Math.round(0.001 * sr), Math.round(Math.min(period, 0.04 * sr)));
  const fh = Math.max(1, Math.round(0.0005 * sr));
  const envLen = Math.ceil(x.length / fh);
  const env = new Float32Array(envLen);
  let peak = 0;
  let peakIdx = 0;
  for (let i = 0; i < envLen; i++) {
    const c = i * fh;
    const lo = Math.max(0, c - (fw >> 1));
    const hi = Math.min(x.length, c + (fw >> 1) + 1);
    let m = 0;
    for (let k = lo; k < hi; k++) {
      const v = Math.abs(x[k]);
      if (v > m) m = v;
    }
    env[i] = m;
    if (m > peak) {
      peak = m;
      peakIdx = i;
    }
  }
  // The attack ends at the first settled crest, so beating in a held tone does not stretch it.
  const smooth = new Float32Array(envLen);
  {
    const half = Math.max(1, Math.round(0.005 / (fh / sr)));
    let acc = 0;
    for (let i = 0; i < envLen + half; i++) {
      if (i < envLen) acc += env[i];
      if (i - 2 * half - 1 >= 0) acc -= env[i - 2 * half - 1];
      const c = i - half;
      if (c >= 0 && c < envLen) smooth[c] = acc / (Math.min(envLen - 1, i) - Math.max(0, i - 2 * half) + 1);
    }
  }
  let sMax = 0;
  for (let i = 0; i < envLen; i++) sMax = Math.max(sMax, smooth[i]);
  const look = Math.max(1, Math.round(0.02 / (fh / sr)));
  let attackIdx = peakIdx;
  for (let i = 0; i < envLen; i++) {
    if (smooth[i] < 0.5 * sMax) continue;
    let ahead = 0;
    for (let j = i + 1; j <= Math.min(envLen - 1, i + look); j++) ahead = Math.max(ahead, smooth[j]);
    if (smooth[i] >= 0.98 * ahead) {
      attackIdx = i;
      break;
    }
  }
  let crest = 0;
  for (let i = Math.max(0, attackIdx - look); i <= Math.min(envLen - 1, attackIdx + look); i++) {
    if (env[i] > crest) {
      crest = env[i];
      attackIdx = i;
    }
  }
  let t10 = 0;
  while (t10 < attackIdx && env[t10] < 0.1 * crest) t10++;
  let t90 = t10;
  while (t90 < attackIdx && env[t90] < 0.9 * crest) t90++;
  const frameSec = fh / sr;
  const onsetSample = t10 * fh;
  const onsetSec = startSec + onsetSample / sr;
  const envDb = new Float32Array(envLen);
  for (let i = 0; i < envLen; i++) envDb[i] = 20 * Math.log10(Math.max(env[i] / peak, 1e-6));

  const offIdx =
    opts.noteOff !== undefined ? Math.max(attackIdx, Math.min(envLen - 1, Math.round((opts.noteOff - startSec) / frameSec))) : envLen - 1;
  // Decay fits stop 25 ms before note-off so the closing ramp of a held note is not read as decay.
  const holdEnd = opts.noteOff !== undefined ? Math.max(attackIdx, offIdx - Math.round(0.025 / frameSec)) : offIdx;
  const tailFrames = Math.max(1, Math.round(0.05 / frameSec));
  const tailFloor = median(Array.from(envDb.subarray(Math.max(0, envLen - tailFrames)))) ?? -120;
  const leadFloor = t10 > Math.round(0.02 / frameSec) ? (median(Array.from(envDb.subarray(0, Math.max(1, t10 - 4)))) ?? -120) : -120;
  const floorDb = Math.min(tailFloor, leadFloor);
  const lowLimit = Math.max(floorDb + 10, -60);

  const crossing = (level: number, from: number, to: number) => {
    for (let i = from; i <= to; i++) if (envDb[i] <= level) return i;
    return -1;
  };
  const fitRate = (i0: number, i1: number): number | null => {
    if (i1 - i0 < 3) return null;
    const xs: number[] = [];
    const ys: number[] = [];
    const stride = Math.max(1, Math.floor((i1 - i0) / 400));
    for (let i = i0; i <= i1; i += stride) {
      xs.push(i * frameSec);
      ys.push(envDb[i]);
    }
    const fit = linFit(xs, ys);
    return fit ? -fit.slope : null;
  };
  const endDecay = crossing(lowLimit, attackIdx, holdEnd);
  const decayEnd = endDecay === -1 ? holdEnd : endDecay;
  const decay = fitRate(attackIdx, decayEnd);
  const c12 = crossing(-12, attackIdx, holdEnd);
  const early = c12 > 0 ? fitRate(attackIdx, c12) : null;
  const late = c12 > 0 && lowLimit < -20 && decayEnd > c12 ? fitRate(c12, decayEnd) : null;
  const t60 = decay !== null && decay >= 1 ? 60 / decay : null;

  let releaseMs: number | null = null;
  if (opts.noteOff !== undefined && offIdx < envLen - 1) {
    const level = envDb[offIdx];
    if (level > floorDb + 12) {
      const j = crossing(Math.max(level - 30, floorDb + 6), offIdx, envLen - 1);
      if (j >= 0) releaseMs = (j - offIdx) * frameSec * 1000;
    }
  }
  let tcNum = 0;
  let tcDen = 0;
  for (let i = t10; i < envLen; i++) {
    tcNum += (i - t10) * frameSec * env[i];
    tcDen += env[i];
  }
  const envCurve = CURVE_MS.map((tMs) => {
    const i = t10 + Math.round(tMs / 1000 / frameSec);
    return { tMs, db: i < envLen ? Math.max(-90, envDb[i]) : null };
  });

  // Modulation faster than vibrato. Sum orthogonal bins so a longer note does not read as more of it.
  let shimmerDb: number | null = null;
  {
    const i0 = attackIdx + Math.round(0.3 / frameSec);
    const i1 = Math.min(holdEnd, envLen);
    const step = Math.max(1, Math.round(0.005 / frameSec));
    const samples: number[] = [];
    for (let i = i0; i < i1; i += step) samples.push(env[i]);
    if (samples.length > 80) {
      const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
      if (mean > 1e-8) {
        const dur = samples.length * step * frameSec;
        let power = 0;
        for (let f = 8; f < 20; f += 1 / dur) {
          const w = (2 * Math.PI * f * step * frameSec);
          let re = 0;
          let im = 0;
          for (let i = 0; i < samples.length; i++) {
            const v = (samples[i] - mean) / mean;
            const ph = w * i;
            re += v * Math.cos(ph);
            im -= v * Math.sin(ph);
          }
          power += (2 * (re * re + im * im)) / (samples.length * samples.length);
        }
        shimmerDb = Math.max(-80, 10 * Math.log10(power + 1e-12));
      }
    }
  }

  // Pitch stability and vibrato.
  let stdCents: number | null = null;
  let driftCents: number | null = null;
  let glideCents: number | null = null;
  let vibratoRateHz: number | null = null;
  let vibratoDepthCents: number | null = null;
  let jitterCents: number | null = null;
  if (cents.length >= 3) {
    const mean = cents.reduce((s, v) => s + v, 0) / cents.length;
    stdCents = Math.sqrt(cents.reduce((s, v) => s + (v - mean) ** 2, 0) / cents.length);
    const fit = linFit(ctimes, cents);
    if (fit) driftCents = fit.slope * (ctimes[ctimes.length - 1] - ctimes[0]);
    const t0 = ctimes[0];
    const early60 = cents.filter((_, i) => ctimes[i] - t0 <= 0.06);
    glideCents = early60.length ? (median(early60) ?? 0) - (median(cents) ?? 0) : null;
    if (cents.length >= 40 && fit) {
      const resid = cents.map((c, i) => c - (fit.intercept + fit.slope * ctimes[i]));
      const variance = resid.reduce((s, v) => s + v * v, 0) / resid.length;
      let bestA = 0;
      let bestRate = 0;
      for (let rate = 2; rate <= 10.001; rate += 0.05) {
        let re = 0;
        let im = 0;
        for (let i = 0; i < resid.length; i++) {
          const ph = 2 * Math.PI * rate * ctimes[i];
          re += resid[i] * Math.cos(ph);
          im -= resid[i] * Math.sin(ph);
        }
        const amp = (2 * Math.hypot(re, im)) / resid.length;
        if (amp > bestA) {
          bestA = amp;
          bestRate = rate;
        }
      }
      if (bestA >= 3 && (bestA * bestA) / 2 >= 0.5 * variance) {
        vibratoRateHz = bestRate;
        vibratoDepthCents = bestA;
      }
      // What is left once the drift line and the vibrato are gone. A player jitters; a loop does not.
      let cleaned = resid;
      if (vibratoRateHz !== null) {
        let re = 0;
        let im = 0;
        for (let i = 0; i < resid.length; i++) {
          const ph = 2 * Math.PI * vibratoRateHz * ctimes[i];
          re += resid[i] * Math.cos(ph);
          im -= resid[i] * Math.sin(ph);
        }
        const aCos = (2 * re) / resid.length;
        const aSin = (-2 * im) / resid.length;
        cleaned = resid.map((v, i) => {
          const ph = 2 * Math.PI * (vibratoRateHz as number) * ctimes[i];
          return v - (aCos * Math.cos(ph) + aSin * Math.sin(ph));
        });
      }
      const held = cleaned.filter((_, i) => ctimes[i] - t0 >= 0.3);
      if (held.length >= 20) {
        const m = held.reduce((s, v) => s + v, 0) / held.length;
        jitterCents = Math.sqrt(held.reduce((s, v) => s + (v - m) ** 2, 0) / held.length);
      }
    }
  }

  // Short STFT: brightness, flatness, mel.
  const sN = nextPow2(Math.round(0.04 * sr));
  // A fixed 10 ms hop keeps mel frames time-aligned across sample rates.
  const sHop = Math.max(1, Math.round(0.01 * sr));
  const sWin = windowOf('hann', sN);
  const sRe = new Float64Array(sN);
  const sIm = new Float64Array(sN);
  const bank = melBank(sr, sN);
  const fMax = Math.min(16000, sr * 0.45);
  const sBin = sr / sN;
  const kMax = Math.min(sN / 2 - 1, Math.floor(fMax / sBin));
  const frames: { t: number; e: number; centroid: number; flat: number; roll: number; mel: number[]; low: number; high: number }[] = [];
  const fSplit = f0Yin ?? 0;
  for (let c = onsetSample; c < x.length; c += sHop) {
    const P = powerSpectrum(x, c - sN / 2, sN, sWin, sRe, sIm);
    let e = 0;
    let num = 0;
    let den = 0;
    let logSum = 0;
    let linSum = 0;
    let flatN = 0;
    for (let k = 1; k <= kMax; k++) {
      const f = k * sBin;
      e += P[k];
      const m = Math.sqrt(P[k]);
      if (f >= 20) {
        num += f * m;
        den += m;
      }
      if (f >= 50) {
        logSum += Math.log(P[k] + 1e-24);
        linSum += P[k] + 1e-24;
        flatN++;
      }
    }
    let acc = 0;
    let k85 = kMax;
    for (let k = 1; k <= kMax; k++) {
      acc += P[k];
      if (acc >= 0.85 * e) {
        k85 = k;
        break;
      }
    }
    const mel: number[] = [];
    for (let b = 0; b < MEL_BANDS; b++) {
      const w = bank.weights[b];
      let s = 0;
      for (let j = 0; j < w.length; j++) s += P[bank.lo[b] + j] * w[j];
      mel.push(s);
    }
    let low = 0;
    let high = 0;
    if (fSplit > 0) {
      const kLo2 = Math.min(kMax, Math.ceil((3.5 * fSplit) / sBin));
      const kHi1 = Math.max(kLo2 + 1, Math.floor((5 * fSplit) / sBin));
      const kHi2 = Math.min(kMax, Math.ceil(Math.min(8000, 16 * fSplit) / sBin));
      for (let k = Math.max(1, Math.floor((0.5 * fSplit) / sBin)); k <= kLo2; k++) low += P[k];
      for (let k = kHi1; k <= kHi2; k++) high += P[k];
    }
    frames.push({
      t: (c - onsetSample) / sr,
      e,
      centroid: den > 0 ? num / den : 0,
      flat: flatN > 0 ? Math.exp(logSum / flatN) / (linSum / flatN) : 0,
      roll: k85 * sBin,
      mel,
      low,
      high,
    });
  }
  let brightnessLagMs: number | null = null;
  if (fSplit > 0) {
    const early = frames.filter((f) => f.t <= 0.25);
    const reach = (key: 'low' | 'high') => {
      let peakE = 0;
      for (const f of early) peakE = Math.max(peakE, f[key]);
      if (peakE <= 0) return null;
      for (const f of early) if (f[key] >= 0.5 * peakE) return { t: f.t, peakE };
      return null;
    };
    const lo = reach('low');
    const hi = reach('high');
    if (lo && hi && hi.peakE > lo.peakE * 1e-3) brightnessLagMs = (hi.t - lo.t) * 1000;
  }
  const maxE = frames.reduce((m, f) => Math.max(m, f.e), 0);
  const active = frames.filter((f) => f.e >= maxE * 1e-4);
  const weighted = (fs: typeof frames, key: 'centroid' | 'roll'): number | null => {
    let n = 0;
    let d = 0;
    for (const f of fs) {
      n += f[key] * f.e;
      d += f.e;
    }
    return d > 0 ? n / d : null;
  };
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
  const attackFrames = active.filter((f) => f.t <= 0.05);
  const sustainFrames = active.filter((f) => f.t >= 0.2);
  const melMean: number[] = [];
  for (let b = 0; b < MEL_BANDS; b++) melMean.push(pdb(active.reduce((s, f) => s + f.mel[b], 0) / Math.max(1, active.length)));
  const melTop = Math.max(...melMean);
  const melDb = melMean.map((v) => Math.max(-90, v - melTop));
  let melCell = -Infinity;
  for (const f of frames) for (const v of f.mel) melCell = Math.max(melCell, pdb(v));
  const melFrames = frames
    .filter((f) => f.t <= MEL_FRAMES_SEC)
    .map((f) => f.mel.map((v) => Math.round(Math.max(-80, pdb(v) - melCell) * 10) / 10));
  const sCurve = CURVE_MS.map((tMs) => {
    const f = frames[Math.round(tMs / 1000 / (sHop / sr))];
    return { tMs, hz: f && f.e >= maxE * 1e-4 ? f.centroid : null };
  });

  // Long STFT: partials. Blackman–Harris keeps sidelobes far below aliasing.
  const lN = f0Yin
    ? Math.min(32768, Math.max(2048, nextPow2(Math.ceil((16 * sr) / f0Yin))))
    : nextPow2(Math.round(0.2 * sr));
  const lHop = Math.max(Math.round(0.005 * sr), lN / 8);
  const lWin = windowOf('bh', lN);
  const lRe = new Float64Array(lN);
  const lIm = new Float64Array(lN);
  const lBin = sr / lN;
  const lMax = Math.min(lN / 2 - 2, Math.floor(fMax / lBin));
  const long: { t: number; P: Float32Array }[] = [];
  for (let s = onsetSample; s + lN / 2 <= x.length || long.length === 0; s += lHop) {
    long.push({ t: (s + lN / 2 - onsetSample) / sr, P: powerSpectrum(x, s, lN, lWin, lRe, lIm) });
    if (s + lN / 2 > x.length) break;
  }
  const avg = new Float32Array(lN / 2);
  let avgN = 0;
  for (const fr of long) {
    if (avgN > 0 && fr.t - lN / 2 / sr > 0.1) break;
    for (let k = 0; k < avg.length; k++) avg[k] += fr.P[k];
    avgN++;
  }
  for (let k = 0; k < avg.length; k++) avg[k] /= Math.max(1, avgN);

  const interp = (k: number): { hz: number; db: number } => {
    const a = pdb(avg[k - 1]);
    const b = pdb(avg[k]);
    const c = pdb(avg[k + 1]);
    const den = a - 2 * b + c;
    const p = Math.abs(den) > 1e-12 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
    return { hz: (k + p) * lBin, db: b - 0.25 * (a - c) * p };
  };
  const localMedian = (center: number, half: number): number => {
    const lo = Math.max(1, Math.round(center - half));
    const hi = Math.min(avg.length - 1, Math.round(center + half));
    const vals: number[] = [];
    for (let k = lo; k <= hi; k++) vals.push(avg[k]);
    return median(vals) ?? 0;
  };

  type Partial = { n: number; hz: number; db: number; k: number };
  const found: Partial[] = [];
  let B = 0;
  let base = f0Yin ?? 0;
  let searchedTopHz = 0;
  if (f0Yin) {
    const maxN = Math.min(256, Math.floor(fMax / f0Yin));
    let bestDb = -Infinity;
    for (let n = 1; n <= maxN; n++) {
      const pred = n * base * Math.sqrt(1 + B * n * n);
      if (pred >= fMax) break;
      searchedTopHz = pred + 0.5 * base;
      const half = Math.max(2, Math.round((0.25 * base) / lBin));
      const kc = Math.round(pred / lBin);
      let kBest = -1;
      for (let k = Math.max(2, kc - half); k <= Math.min(lMax, kc + half); k++) {
        if (kBest < 0 || avg[k] > avg[kBest]) kBest = k;
      }
      if (kBest < 2 || kBest >= avg.length - 1) continue;
      if (avg[kBest] < avg[kBest - 1] || avg[kBest] < avg[kBest + 1]) continue;
      const floor = localMedian(kc, (0.5 * base) / lBin);
      if (avg[kBest] < floor * 10) continue;
      const pk = interp(kBest);
      if (pk.db < bestDb - 80) continue;
      bestDb = Math.max(bestDb, pk.db);
      found.push({ n, hz: pk.hz, db: pk.db, k: kBest });
      if (n === 1 || (found.length === 1 && found[0].n === n)) base = pk.hz / n;
      if (found.length >= 3) {
        const fit = linFit(
          found.map((p) => p.n * p.n),
          found.map((p) => (p.hz / p.n) ** 2),
        );
        if (fit && fit.intercept > 0) {
          B = Math.min(0.01, Math.max(0, fit.slope / fit.intercept));
          base = Math.sqrt(fit.intercept);
        }
      }
    }
  }
  let rawB: number | null = null;
  if (found.length >= 4) {
    const fit = linFit(
      found.map((p) => p.n * p.n),
      found.map((p) => (p.hz / p.n) ** 2),
    );
    if (fit && fit.intercept > 0) rawB = Math.max(0, fit.slope / fit.intercept);
  }
  const p1 = found.find((p) => p.n === 1);
  const f0Hz = p1 ? p1.hz : f0Yin;
  const topDb = found.reduce((m, p) => Math.max(m, p.db), -Infinity);
  const byN = new Map(found.map((p) => [p.n, p]));
  const amplitudesDb: (number | null)[] = [];
  const freqRatios: (number | null)[] = [];
  for (let n = 1; n <= HARMONICS_REPORTED; n++) {
    const p = byN.get(n);
    amplitudesDb.push(p ? p.db - topDb : null);
    freqRatios.push(p && p1 ? p.hz / p1.hz : null);
  }
  const slopePts = found.filter((p) => p.n <= HARMONICS_REPORTED);
  const slopeFit =
    slopePts.length >= 3
      ? linFit(
          slopePts.map((p) => Math.log2(p.n)),
          slopePts.map((p) => p.db),
        )
      : null;
  let oddEvenDb: number | null = null;
  if (found.length >= 3) {
    let odd = 0;
    let even = 0;
    for (const p of slopePts) {
      const pw = Math.pow(10, p.db / 10);
      if (p.n % 2 === 0) even += pw;
      else if (p.n >= 3) odd += pw;
    }
    oddEvenDb = Math.max(-60, Math.min(60, pdb(odd) - pdb(even)));
  }

  let hnrDb: number | null = null;
  let spuriousDb: number | null = null;
  if (found.length > 0 && base > 0) {
    const mark = new Uint8Array(avg.length);
    const lobe = 5;
    for (const p of found) for (let k = p.k - lobe; k <= p.k + lobe; k++) if (k > 0 && k < avg.length) mark[k] = 1;
    let harm = 0;
    let total = 0;
    const kLo = Math.max(1, Math.floor((0.5 * base) / lBin));
    const kHi = Math.min(lMax, Math.ceil(searchedTopHz / lBin));
    for (let k = kLo; k <= kHi; k++) {
      total += avg[k];
      if (mark[k]) harm += avg[k];
    }
    hnrDb = Math.max(-30, Math.min(80, pdb(harm) - pdb(total - harm)));

    const exclude = new Uint8Array(avg.length);
    const ex = Math.max(6, Math.round((0.06 * base) / lBin));
    for (let n = 1; n * base <= fMax * 1.05; n++) {
      const f = byN.get(n)?.hz ?? n * base * Math.sqrt(1 + B * n * n);
      const kc = Math.round(f / lBin);
      for (let k = kc - ex; k <= kc + ex; k++) if (k > 0 && k < avg.length) exclude[k] = 1;
    }
    const maxPartial = Math.pow(10, topDb / 10);
    let spur = 0;
    const kMin = Math.max(2, Math.ceil(20 / lBin));
    const half = Math.max(16, lN >> 7);
    for (let k = kMin; k < lMax; k++) {
      if (exclude[k] || avg[k] < avg[k - 1] || avg[k] < avg[k + 1]) continue;
      if (avg[k] < maxPartial * 1e-9) continue;
      if (avg[k] < localMedian(k, half) * 10) continue;
      for (let j = k - 2; j <= k + 2; j++) spur += avg[j];
    }
    spuriousDb = spur > 0 ? Math.max(-120, pdb(spur) - pdb(harm)) : null;
  }

  const decayDbPerSec: (number | null)[] = [];
  const offSec = opts.noteOff !== undefined ? opts.noteOff - onsetSec : Infinity;
  for (let n = 1; n <= DECAY_PARTIALS; n++) {
    const p = byN.get(n);
    if (!p) {
      decayDbPerSec.push(null);
      continue;
    }
    const lv = long.map((fr) => {
      let m = 0;
      for (let k = p.k - 2; k <= p.k + 2; k++) if (k > 0 && k < fr.P.length) m = Math.max(m, fr.P[k]);
      return pdb(m);
    });
    let mi = 0;
    for (let i = 1; i < lv.length; i++) if (lv[i] > lv[mi]) mi = i;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = mi; i < lv.length; i++) {
      if (long[i].t > offSec) break;
      if (lv[i] < lv[mi] - 40) break;
      xs.push(long[i].t);
      ys.push(lv[i]);
    }
    const fit = xs.length >= 3 ? linFit(xs, ys) : null;
    decayDbPerSec.push(fit ? -fit.slope : null);
  }

  // Each partial of a real note wanders on its own. Subtract the shared loudness first, so vibrato does not count.
  let flutterDb: number | null = null;
  {
    const offSecF = opts.noteOff !== undefined ? opts.noteOff - onsetSec : Infinity;
    const frs = long.filter((fr) => fr.t >= 0.35 && fr.t <= Math.min(1.8, offSecF - 0.05));
    const parts = found.filter((p) => p.n <= 6);
    if (frs.length >= 8 && parts.length >= 3) {
      const rows = parts.map((p) =>
        frs.map((fr) => {
          let m = 0;
          for (let k = p.k - 1; k <= p.k + 1; k++) if (k > 0 && k < fr.P.length) m = Math.max(m, fr.P[k]);
          return pdb(m);
        }),
      );
      const common = frs.map((_, i) => rows.reduce((s, row) => s + row[i], 0) / rows.length);
      const stds = rows.map((row) => {
        const y = row.map((v, i) => v - common[i]);
        const trend = linFit(
          frs.map((fr) => fr.t),
          y,
        );
        const r = y.map((v, i) => v - (trend ? trend.intercept + trend.slope * frs[i].t : 0));
        const m = r.reduce((s, v) => s + v, 0) / r.length;
        return Math.sqrt(r.reduce((s, v) => s + (v - m) ** 2, 0) / r.length);
      });
      flutterDb = median(stds);
    }
  }

  const peaks: { hz: number; ratio: number | null; db: number }[] = [];
  {
    const cands: { k: number; p: number }[] = [];
    const kMin = Math.max(2, Math.ceil(20 / lBin));
    for (let k = kMin; k < lMax; k++) if (avg[k] > avg[k - 1] && avg[k] >= avg[k + 1]) cands.push({ k, p: avg[k] });
    cands.sort((u, v) => v.p - u.p);
    const top = cands.length ? cands[0].p : 0;
    const taken: number[] = [];
    for (const c of cands) {
      if (peaks.length >= 12 || c.p < top * 1e-6) break;
      if (taken.some((k) => Math.abs(k - c.k) <= 6)) continue;
      taken.push(c.k);
      const pk = interp(c.k);
      peaks.push({ hz: pk.hz, ratio: f0Hz ? pk.hz / f0Hz : null, db: pk.db - pdb(top) });
    }
    peaks.sort((u, v) => u.hz - v.hz);
  }

  // Clicks: a second difference far above its neighbourhood, after the attack.
  const clickTimes: number[] = [];
  {
    const n = x.length;
    const d2 = new Float32Array(n);
    for (let i = 2; i < n; i++) d2[i] = x[i] - 2 * x[i - 1] + x[i - 2];
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + d2[i] * d2[i];
    const half = Math.max(8, Math.round(0.0025 * sr));
    const guard = 3;
    const from = Math.min(n, t90 * fh + Math.round(0.02 * sr));
    let last = -Infinity;
    for (let i = Math.max(from, half); i < n - half; i++) {
      const v = Math.abs(d2[i]);
      if (v < 0.005 * peakAbs) continue;
      const e = pre[i + half] - pre[i + guard + 1] + (pre[i - guard] - pre[i - half]);
      const rms = Math.sqrt(e / (2 * (half - guard - 1)));
      if (v > 8 * rms) {
        const t = startSec + i / sr;
        if (t - last > 0.01) {
          clickTimes.push(t);
          last = t;
        }
      }
    }
  }

  return {
    onsetSec,
    f0Hz,
    centsOff: f0Hz && opts.midi !== undefined ? 1200 * Math.log2(f0Hz / midiHz(opts.midi)) : null,
    pitch: { stdCents, driftCents, glideCents, vibratoRateHz, vibratoDepthCents, jitterCents },
    envelope: {
      peakDb: 20 * Math.log10(peak),
      attackMs: (t90 - t10) * frameSec * 1000,
      peakMs: (attackIdx - t10) * frameSec * 1000,
      decayDbPerSec: decay,
      earlyDecayDbPerSec: early,
      lateDecayDbPerSec: late,
      t60Sec: t60,
      releaseMs,
      temporalCentroidSec: tcDen > 0 ? tcNum / tcDen : 0,
      curve: envCurve,
      shimmerDb,
    },
    spectrum: {
      centroidHz: weighted(active, 'centroid') ?? 0,
      centroidAttackHz: weighted(attackFrames, 'centroid'),
      centroidSustainHz: weighted(sustainFrames, 'centroid'),
      brightness: f0Hz ? (weighted(active, 'centroid') ?? 0) / f0Hz : null,
      rolloffHz: weighted(active, 'roll') ?? 0,
      flatnessAttack: mean(active.filter((f) => f.t <= 0.03).map((f) => f.flat)),
      flatnessSustain: mean(sustainFrames.map((f) => f.flat)),
      curve: sCurve,
      melDb,
      mfcc: dct(melMean, MFCC_COUNT),
      hopSec: sHop / sr,
      melFrames,
      brightnessLagMs,
    },
    harmonics: {
      amplitudesDb,
      freqRatios,
      slopeDbPerOct: slopeFit ? slopeFit.slope : null,
      oddEvenDb,
      inharmonicity: rawB,
      hnrDb,
      spuriousDb,
      decayDbPerSec,
      flutterDb,
    },
    peaks,
    artifacts: {
      clicks: clickTimes.length,
      clickTimes: clickTimes.slice(0, 20),
      dcOffset: sum / x.length / peakAbs,
      nonFinite,
    },
  };
}

export interface TimbreMetric {
  id: string;
  label: string;
  unit: string;
  value: number | null;
  ref: number | null;
  /** Error over its tolerance. At most 1 passes. */
  error: number;
  detail?: string;
}

export interface TimbreComparison {
  metrics: TimbreMetric[];
  passed: number;
  total: number;
  /** RMS of the errors, each capped at 3. 0 is identical. */
  distance: number;
  /**
   * Same RMS after each error is divided by max(1, its real-vs-real floor).
   * Null when no floor was given. 1 means about as far apart as two real takes of the same note.
   */
  excess: number | null;
  findings: Finding[];
}

function rmsOf(xs: number[]): number {
  return xs.length ? Math.sqrt(xs.reduce((s, v) => s + v * v, 0) / xs.length) : 0;
}

function spectroDistance(a: number[][], b: number[][]): number | null {
  const n = Math.min(a.length, b.length);
  if (n === 0) return null;
  const diffs: number[] = [];
  for (let f = 0; f < n; f++) {
    for (let k = 0; k < a[f].length && k < b[f].length; k++) {
      if (a[f][k] < -50 && b[f][k] < -50) continue;
      diffs.push(Math.max(-60, a[f][k]) - Math.max(-60, b[f][k]));
    }
  }
  return diffs.length ? rmsOf(diffs) : null;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Compare a rendered note with a reference recording of the same pitch.
 * `floor` is the median error two real recordings of one note already show, per metric.
 * A metric only counts past that, so natural variation is not reported as a defect.
 */
export function compareTimbre(
  ours: NoteFeatures,
  ref: NoteFeatures,
  floor?: Readonly<Record<string, number>>,
): TimbreComparison {
  const metrics: TimbreMetric[] = [];
  const add = (m: TimbreMetric) => {
    if (Number.isFinite(m.error)) metrics.push(m);
  };
  const logRatio = (a: number, b: number, floor: number) => Math.log2((a + floor) / (b + floor));

  if (ours.f0Hz && ref.f0Hz) {
    const c = 1200 * Math.log2(ours.f0Hz / ref.f0Hz);
    add({ id: 'pitch', label: '音高', unit: 'cents', value: c, ref: 0, error: Math.abs(c) / 5 });
  }
  const oe = ours.envelope;
  const re = ref.envelope;
  add({ id: 'attack', label: '起音 10–90%', unit: 'ms', value: oe.attackMs, ref: re.attackMs, error: Math.abs(logRatio(oe.attackMs, re.attackMs, 1)) / 0.5 });
  const rate = (id: string, label: string, a: number | null, b: number | null, tol: number) => {
    if (a === null || b === null) return;
    add({ id, label, unit: 'dB/s', value: a, ref: b, error: Math.abs(logRatio(Math.max(0, a), Math.max(0, b), 0.5)) / tol });
  };
  rate('decay', '整体衰减', oe.decayDbPerSec, re.decayDbPerSec, 0.5);
  rate('decay.early', '早段衰减', oe.earlyDecayDbPerSec, re.earlyDecayDbPerSec, 0.6);
  rate('decay.late', '晚段衰减', oe.lateDecayDbPerSec, re.lateDecayDbPerSec, 0.6);
  if (oe.releaseMs !== null && re.releaseMs !== null) {
    add({ id: 'release', label: '松开后的尾巴', unit: 'ms', value: oe.releaseMs, ref: re.releaseMs, error: Math.abs(logRatio(oe.releaseMs, re.releaseMs, 5)) / 0.5 });
  }
  {
    const diffs: { t: number; d: number }[] = [];
    oe.curve.forEach((p, i) => {
      const q = re.curve[i];
      if (p.db === null || q?.db === null || q === undefined) return;
      diffs.push({ t: p.tMs, d: Math.max(-60, p.db) - Math.max(-60, q.db) });
    });
    if (diffs.length >= 3) {
      const worst = diffs.reduce((w, v) => (Math.abs(v.d) > Math.abs(w.d) ? v : w));
      const v = rmsOf(diffs.map((d) => d.d));
      add({ id: 'envelope', label: '响度包络', unit: 'dB', value: v, ref: null, error: v / 4, detail: `${worst.t}ms:${r1(worst.d)}` });
    }
  }

  const oh = ours.harmonics;
  const rh = ref.harmonics;
  {
    const diffs: { n: number; d: number }[] = [];
    for (let n = 1; n <= 12; n++) {
      const a = oh.amplitudesDb[n - 1];
      const b = rh.amplitudesDb[n - 1];
      if ((a === null || a === undefined) && (b === null || b === undefined)) continue;
      diffs.push({ n, d: Math.max(-60, a ?? -60) - Math.max(-60, b ?? -60) });
    }
    if (diffs.length >= 2) {
      const worst = diffs.reduce((w, v) => (Math.abs(v.d) > Math.abs(w.d) ? v : w));
      const v = rmsOf(diffs.map((d) => d.d));
      add({ id: 'harmonics', label: '泛音比例', unit: 'dB', value: v, ref: null, error: v / 4, detail: `${worst.n}:${r1(worst.d)}` });
    }
  }
  if (oh.slopeDbPerOct !== null && rh.slopeDbPerOct !== null) {
    add({ id: 'slope', label: '泛音斜率', unit: 'dB/oct', value: oh.slopeDbPerOct, ref: rh.slopeDbPerOct, error: Math.abs(oh.slopeDbPerOct - rh.slopeDbPerOct) / 2 });
  }
  if (oh.oddEvenDb !== null && rh.oddEvenDb !== null) {
    const a = Math.max(-40, Math.min(40, oh.oddEvenDb));
    const b = Math.max(-40, Math.min(40, rh.oddEvenDb));
    add({ id: 'oddEven', label: '奇偶泛音比', unit: 'dB', value: oh.oddEvenDb, ref: rh.oddEvenDb, error: Math.abs(a - b) / 3 });
  }
  if (oh.inharmonicity !== null && rh.inharmonicity !== null && Math.max(oh.inharmonicity, rh.inharmonicity) >= 1e-6) {
    add({
      id: 'inharmonicity',
      label: '非谐性 B',
      unit: '',
      value: oh.inharmonicity,
      ref: rh.inharmonicity,
      error: Math.abs(Math.log10((oh.inharmonicity + 1e-6) / (rh.inharmonicity + 1e-6))) / 0.3,
    });
  }
  {
    const lows: number[] = [];
    const highs: number[] = [];
    for (let n = 1; n <= DECAY_PARTIALS; n++) {
      const a = oh.decayDbPerSec[n - 1];
      const b = rh.decayDbPerSec[n - 1];
      if (a === null || a === undefined || b === null || b === undefined) continue;
      (n >= 4 ? highs : lows).push(logRatio(Math.max(0, a), Math.max(0, b), 0.5));
    }
    const all = [...lows, ...highs];
    if (all.length >= 2) {
      const v = median(all.map(Math.abs)) ?? 0;
      const hi = median(highs);
      add({
        id: 'partialDecay',
        label: '各泛音衰减',
        unit: 'log2',
        value: v,
        ref: null,
        error: v / 0.5,
        detail: hi === null ? undefined : `high:${r1(hi)}`,
      });
    }
  }
  if (oh.hnrDb !== null && rh.hnrDb !== null) {
    const a = Math.max(-10, Math.min(60, oh.hnrDb));
    const b = Math.max(-10, Math.min(60, rh.hnrDb));
    add({ id: 'hnr', label: '谐噪比', unit: 'dB', value: oh.hnrDb, ref: rh.hnrDb, error: Math.abs(a - b) / 6 });
  }
  {
    const a = oh.spuriousDb ?? -90;
    const b = rh.spuriousDb ?? -90;
    add({ id: 'spurious', label: '杂散峰', unit: 'dB', value: oh.spuriousDb, ref: rh.spuriousDb, error: Math.max(0, a - Math.max(b, -60)) / 10 });
  }

  const os = ours.spectrum;
  const rs = ref.spectrum;
  if (os.centroidHz > 0 && rs.centroidHz > 0) {
    add({ id: 'centroid', label: '亮度（质心）', unit: 'Hz', value: os.centroidHz, ref: rs.centroidHz, error: Math.abs(Math.log2(os.centroidHz / rs.centroidHz)) / 0.25 });
  }
  {
    const diffs: number[] = [];
    os.curve.forEach((p, i) => {
      const q = rs.curve[i];
      if (p.hz && q?.hz) diffs.push(Math.log2(p.hz / q.hz));
    });
    if (diffs.length >= 3) {
      const mean = diffs.reduce((s, v) => s + v, 0) / diffs.length;
      const shape = rmsOf(diffs.map((d) => d - mean));
      add({ id: 'centroidCurve', label: '亮度随时间的走势', unit: 'oct', value: shape, ref: null, error: shape / 0.3 });
    }
  }
  if (os.flatnessAttack !== null && rs.flatnessAttack !== null) {
    add({
      id: 'attackNoise',
      label: '起音噪声感',
      unit: '',
      value: os.flatnessAttack,
      ref: rs.flatnessAttack,
      error: Math.abs(Math.log10(Math.max(1e-4, os.flatnessAttack) / Math.max(1e-4, rs.flatnessAttack))) / 0.3,
    });
  }
  {
    const da = ours.pitch.vibratoDepthCents ?? 0;
    const db = ref.pitch.vibratoDepthCents ?? 0;
    if (da > 0 || db > 0) add({ id: 'vibrato.depth', label: '颤音深度', unit: 'cents', value: da, ref: db, error: Math.abs(da - db) / 5 });
    if (ours.pitch.vibratoRateHz !== null && ref.pitch.vibratoRateHz !== null) {
      add({
        id: 'vibrato.rate',
        label: '颤音速度',
        unit: 'Hz',
        value: ours.pitch.vibratoRateHz,
        ref: ref.pitch.vibratoRateHz,
        error: Math.abs(ours.pitch.vibratoRateHz - ref.pitch.vibratoRateHz) / 0.5,
      });
    }
  }
  if (os.melDb.length && rs.melDb.length) {
    const diffs = os.melDb.map((v, i) => Math.max(-60, v) - Math.max(-60, rs.melDb[i] ?? -60));
    const v = rmsOf(diffs);
    add({ id: 'melEnvelope', label: '频谱包络', unit: 'dB', value: v, ref: null, error: v / 4 });
  }
  const sd = spectroDistance(os.melFrames, rs.melFrames);
  if (sd !== null) add({ id: 'spectrogram', label: '时频图', unit: 'dB', value: sd, ref: null, error: sd / 6 });
  if (ours.harmonics.flutterDb !== null && ref.harmonics.flutterDb !== null) {
    add({
      id: 'flutter',
      label: '分音起伏',
      unit: 'dB',
      value: ours.harmonics.flutterDb,
      ref: ref.harmonics.flutterDb,
      error: Math.abs(ours.harmonics.flutterDb - ref.harmonics.flutterDb) / 1,
    });
  }
  if (ours.pitch.jitterCents !== null && ref.pitch.jitterCents !== null) {
    add({
      id: 'pitch.jitter',
      label: '音高抖动',
      unit: 'cents',
      value: ours.pitch.jitterCents,
      ref: ref.pitch.jitterCents,
      error: Math.abs(ours.pitch.jitterCents - ref.pitch.jitterCents) / 2,
    });
  }
  if (ours.spectrum.brightnessLagMs !== null && ref.spectrum.brightnessLagMs !== null) {
    add({
      id: 'brightnessLag',
      label: '高频滞后',
      unit: 'ms',
      value: ours.spectrum.brightnessLagMs,
      ref: ref.spectrum.brightnessLagMs,
      error: Math.abs(ours.spectrum.brightnessLagMs - ref.spectrum.brightnessLagMs) / 20,
    });
  }
  if (ours.envelope.shimmerDb !== null && ref.envelope.shimmerDb !== null) {
    add({
      id: 'shimmer',
      label: '微起伏',
      unit: 'dB',
      value: ours.envelope.shimmerDb,
      ref: ref.envelope.shimmerDb,
      error: Math.abs(ours.envelope.shimmerDb - ref.envelope.shimmerDb) / 6,
    });
  }

  // A floor below 1 would make the ruler stricter than the hand tolerance. Never do that.
  const scale = (id: string) => Math.max(1, floor?.[id] ?? 1);
  const passed = metrics.filter((m) => m.error / scale(m.id) <= 1).length;
  const distance = rmsOf(metrics.map((m) => Math.min(3, m.error)));
  const excess = floor ? rmsOf(metrics.map((m) => Math.min(3, m.error / scale(m.id)))) : null;
  const findings = metrics
    .filter((m) => m.error / scale(m.id) > 1)
    .sort((a, b) => b.error / scale(b.id) - a.error / scale(a.id))
    .map((m) => timbreFinding(m));
  return { metrics, passed, total: metrics.length, distance, excess, findings };
}

function fmt(v: number | null, digits = 1): string {
  return v === null ? '-' : v.toFixed(digits);
}

function timbreFinding(m: TimbreMetric): Finding {
  const severity: Finding['severity'] = m.error > 2 ? 'high' : 'medium';
  const higher = m.value !== null && m.ref !== null && m.value > m.ref;
  const base = { id: `timbre.${m.id}`, severity, metric: m.id, value: m.value ?? m.error };
  const target = m.ref === null ? `< ${m.unit}` : `${fmt(m.ref, 2)} ${m.unit}`.trim();
  switch (m.id) {
    case 'pitch':
      return { ...base, target: '±5 cents', message: `音高差 ${fmt(m.value)} 音分`, suggestion: '先校准音高：延迟线长度要用分数延迟，环路滤波的相位延迟要补偿' };
    case 'attack':
      return {
        ...base,
        target,
        message: `起音 ${fmt(m.value)} ms，参照 ${fmt(m.ref)} ms，${higher ? '偏慢' : '偏快'}`,
        suggestion: higher ? '缩短激励或包络的 attack' : '加长包络 attack，或让激励噪声渐入',
      };
    case 'decay':
    case 'decay.early':
    case 'decay.late':
      return {
        ...base,
        target,
        message: `${m.label} ${fmt(m.value)} dB/s，参照 ${fmt(m.ref)} dB/s，${higher ? '死得太快' : '拖得太长'}`,
        suggestion: higher ? '减小环路损耗或阻尼，或拉长 decay' : '加大损耗或阻尼，或缩短 decay',
      };
    case 'release':
      return {
        ...base,
        target,
        message: `松开后 ${fmt(m.value, 0)} ms 衰减 30 dB，参照 ${fmt(m.ref, 0)} ms`,
        suggestion: higher ? '松开后的阻尼加大一点' : '松开后的阻尼减小一点，或加长 release',
      };
    case 'envelope':
      return { ...base, target: '< 4 dB', message: `响度包络差 ${fmt(m.value)} dB（最大差在 ${m.detail} dB）`, suggestion: '对照包络曲线，调 attack/decay 的形状' };
    case 'harmonics': {
      const [n, d] = (m.detail ?? '0:0').split(':');
      const up = Number(d) > 0;
      return {
        ...base,
        target: '< 4 dB',
        message: `泛音比例差 ${fmt(m.value)} dB，第 ${n} 泛音${up ? '高' : '低'}了 ${Math.abs(Number(d)).toFixed(1)} dB`,
        suggestion: up ? '压低这一段泛音：调激励频谱、拨弦位置或滤波' : '抬高这一段泛音：调激励频谱、拨弦位置或滤波',
      };
    }
    case 'slope':
      return {
        ...base,
        target,
        message: `泛音斜率 ${fmt(m.value)} dB/oct，参照 ${fmt(m.ref)}，${higher ? '偏亮' : '偏暗'}`,
        suggestion: higher ? '加大高频衰减或降低激励亮度' : '提高激励亮度或减少高频损耗',
      };
    case 'oddEven':
      return {
        ...base,
        target,
        message: `奇偶泛音比 ${fmt(m.value)} dB，参照 ${fmt(m.ref)} dB`,
        suggestion: higher ? '偶次泛音太少：激励或拾音位置离端点远一点' : '奇次泛音不够：像单簧管那样的空心音需要压低偶次',
      };
    case 'inharmonicity':
      return {
        ...base,
        target,
        message: `非谐性 B ${m.value?.toExponential(2)}，参照 ${m.ref?.toExponential(2)}`,
        suggestion: higher ? '减小刚度（色散全通的系数）或调整模态频率比' : '加大刚度（色散全通的系数）或调整模态频率比',
      };
    case 'partialDecay': {
      const hi = Number((m.detail ?? 'high:0').split(':')[1]);
      return {
        ...base,
        target: '< 0.5',
        message: `各泛音的衰减速度和参照不一致${m.detail ? `，高次泛音${hi > 0 ? '死得太快' : '拖得太长'}` : ''}`,
        suggestion: hi > 0 ? '减小环路滤波的高频损耗' : '加大环路滤波的高频损耗，让高次泛音先消失',
      };
    }
    case 'hnr':
      return {
        ...base,
        target,
        message: `谐噪比 ${fmt(m.value)} dB，参照 ${fmt(m.ref)} dB，${higher ? '太干净' : '噪声偏多'}`,
        suggestion: higher ? '给激励加噪声，或加一点气流、弓噪或琴体共鸣' : '减少激励噪声，或缩短噪声段',
      };
    case 'spurious':
      return {
        ...base,
        target: `≤ ${fmt(m.ref)} dB`,
        message: `有参照里没有的杂散峰（${fmt(m.value)} dB），多半是混叠`,
        suggestion: '用带限振荡器或过采样，非线性前后加滤波',
      };
    case 'centroid':
      return {
        ...base,
        target,
        message: `亮度 ${fmt(m.value, 0)} Hz，参照 ${fmt(m.ref, 0)} Hz，${higher ? '偏亮' : '偏暗'}`,
        suggestion: higher ? '降低激励亮度、截止频率，或加大高频损耗' : '提高激励亮度或截止频率',
      };
    case 'centroidCurve':
      return { ...base, target: '< 0.3 oct', message: '亮度随时间变化的走势和参照不同', suggestion: '让滤波截止或高频损耗跟着包络走：真实乐器越往后越暗' };
    case 'attackNoise':
      return {
        ...base,
        target,
        message: `起音的噪声感 ${fmt(m.value, 3)}，参照 ${fmt(m.ref, 3)}`,
        suggestion: higher ? '缩短或压暗起音噪声' : '起音加一段短噪声（拨片、击槌、气流）',
      };
    case 'vibrato.depth':
    case 'vibrato.rate':
      return { ...base, target, message: `${m.label} ${fmt(m.value)} ${m.unit}，参照 ${fmt(m.ref)}`, suggestion: '调整音高 LFO 的深度和速度' };
    case 'flutter':
      return {
        ...base,
        target,
        message: `分音各自的起伏 ${fmt(m.value)} dB，参照 ${fmt(m.ref)} dB，${higher ? '晃得更多' : '太平'}`,
        suggestion: higher ? '减小各分音上不相干的幅度调制' : '让每个分音有一点自己的起伏，而不是整条音一起抖',
      };
    case 'pitch.jitter':
      return {
        ...base,
        target,
        message: `去掉揉弦后还剩 ${fmt(m.value)} 音分抖动，参照 ${fmt(m.ref)}`,
        suggestion: higher ? '减小音高上的随机抖动' : '在揉弦之外留一点不规则的音高抖动，完全平滑的音高听起来是合成的',
      };
    case 'brightnessLag':
      return {
        ...base,
        target,
        message: `高频比低频晚 ${fmt(m.value, 0)} ms 到达，参照 ${fmt(m.ref, 0)} ms`,
        suggestion: higher ? '让高次泛音和基频一起起来' : '让高次泛音晚一点进来，铜管和起吹都是这样',
      };
    case 'shimmer':
      return {
        ...base,
        target,
        message: `8–20 Hz 的起伏 ${fmt(m.value)} dB，参照 ${fmt(m.ref)} dB，${higher ? '抖得更多' : '太稳'}`,
        suggestion: higher ? '压低比揉弦更快的幅度起伏' : '在揉弦之上加一点不规则的幅度起伏，完全平稳的持续音听起来是合成的',
      };
    default:
      return { ...base, target: '< 1', message: `${m.label}差 ${fmt(m.value)} ${m.unit}`, suggestion: '先修排在前面的具体指标' };
  }
}

/** JSON without the per-frame mel data. */
export function timbreToJson(value: unknown): string {
  return JSON.stringify(value, (k, v) => (k === 'melFrames' ? undefined : v), 2);
}
