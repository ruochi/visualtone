import { midiToFrequency, mulberry32 } from '../synth.js';

export interface Engine {
  setRelease(ms: number): void;
  processSample(midi: number, size: number, lightness: number): [number, number];
}

interface PluckString {
  buf: Float32Array;
  w: number;
  prev: number;
  apx: number;
  apy: number;
  bz1: number;
  bz2: number;
}

/** Karplus–Strong string. Fractional delay keeps the pitch; size moves the pluck toward the bridge. */
export function createPluck(sampleRate: number, hue: number, seed: number): Engine {
  const rng = mulberry32(seed || 1);
  const hueW = ((hue % 360) + 360) % 360;
  const bright = 1 - hueW / 360;
  let left: PluckString | null = null;
  let right: PluckString | null = null;
  let rightZ = 0;
  let env = 0;
  let wasOn = false;
  let releaseLeft = 0;
  let releaseSamples = Math.floor(0.12 * sampleRate);
  let periodSamp = 32;
  let delaySamp = 30;
  let frac = 0;
  let disp = -0.28;
  let avg = 0.5;

  const bodyW = (2 * Math.PI * 118) / sampleRate;
  const bodyAlpha = Math.sin(bodyW) / 8;
  const bodyA0 = 1 + bodyAlpha;
  const bodyB0 = bodyAlpha / bodyA0;
  const bodyB2 = -bodyAlpha / bodyA0;
  const bodyA1 = (-2 * Math.cos(bodyW)) / bodyA0;
  const bodyA2 = (1 - bodyAlpha) / bodyA0;

  const excite = (beta: number, pole: number): Float32Array => {
    const L = Math.max(4, Math.floor(delaySamp) + 1);
    const burst = new Float32Array(L);
    let prev = 0;
    for (let i = 0; i < L; i++) {
      const n = rng() * 2 - 1;
      prev = n * (1 - pole) + prev * pole;
      burst[i] = prev;
    }
    prev = 0;
    for (let i = 0; i < L; i++) {
      prev = burst[i] * (1 - pole) + prev * pole;
      burst[i] = prev;
    }
    const comb = Math.max(1, Math.min(L - 2, Math.round(beta * L)));
    for (let i = L - 1; i >= comb; i--) burst[i] -= burst[i - comb];
    let e = 0;
    for (let i = 0; i < L; i++) e += burst[i] * burst[i];
    const scale = (0.45 + 0.4 * bright) / (Math.sqrt(e / L) + 1e-8);
    for (let i = 0; i < L; i++) burst[i] *= scale;
    return burst;
  };

  const make = (beta: number, pole: number): PluckString => ({
    buf: excite(beta, pole),
    w: 0,
    prev: 0,
    apx: 0,
    apy: 0,
    bz1: 0,
    bz2: 0,
  });

  const step = (s: PluckString, loss: number): number => {
    const L = s.buf.length;
    const age0 = Math.max(1, Math.floor(delaySamp));
    const i0 = (s.w - age0 + L * 8) % L;
    const i1 = (s.w - age0 - 1 + L * 8) % L;
    const delayed = s.buf[i0] * (1 - frac) + s.buf[i1] * frac;
    const y = disp * delayed + s.apx - disp * s.apy;
    s.apx = delayed;
    s.apy = y;
    const filtered = ((1 - avg) * y + avg * s.prev) * loss;
    s.prev = y;
    s.buf[s.w] = filtered;
    s.w = (s.w + 1) % L;
    const body = bodyB0 * delayed + s.bz1;
    s.bz1 = -bodyA1 * body + s.bz2;
    s.bz2 = bodyB2 * delayed - bodyA2 * body;
    return delayed + body * 0.18;
  };

  return {
    setRelease(ms: number) {
      releaseSamples = Math.max(1, Math.floor((ms / 1000) * sampleRate));
    },
    processSample(midi, size, lightness) {
      const on = size > 1e-5;
      if (on && !wasOn) {
        const freq = Math.min(sampleRate * 0.2, Math.max(30, midiToFrequency(midi)));
        periodSamp = sampleRate / freq;
        disp = -0.18 - (1 - bright) * 0.22;
        // Less averaging keeps the upper partials alive, so a harder pluck stays bright.
        // Short loops need more averaging or harmonics alias and the note reads darker.
        const guard = Math.min(0.55, 20 / periodSamp);
        avg = Math.min(0.62, Math.max(guard, 0.78 - size * 0.78 - (lightness - 0.5) * 0.08));
        const w0 = (2 * Math.PI) / periodSamp;
        const cos0 = Math.cos(w0);
        const b0 = 1 - avg;
        const b1 = avg;
        const avgDelay = (b1 * (b1 + b0 * cos0)) / (b0 * b0 + b1 * b1 + 2 * b0 * b1 * cos0);
        const dispDelay = (1 - disp * disp) / (1 + 2 * disp * cos0 + disp * disp);
        delaySamp = Math.max(2, periodSamp - avgDelay - dispDelay);
        frac = delaySamp - Math.floor(delaySamp);
        const beta = Math.min(0.48, Math.max(0.07, 0.47 - size * 0.36 - (lightness - 0.5) * 0.1));
        const pole = Math.min(0.92, Math.max(0.05, 0.72 - size * 0.7 + (1 - bright) * 0.2));
        left = make(beta, pole);
        right = make(Math.min(0.48, beta + 0.02), pole);
        rightZ = 0;
        env = size;
        releaseLeft = releaseSamples;
      }
      wasOn = on;
      if (!left || !right) return [0, 0];
      if (!on) {
        if (releaseLeft <= 0) return [0, 0];
        releaseLeft--;
      } else {
        releaseLeft = releaseSamples;
      }
      const loss = 0.982 + Math.min(1, Math.max(0, lightness)) * 0.014;
      const outL = step(left, loss);
      const rawR = step(right, loss);
      const outR = rightZ;
      rightZ = rawR;
      const g = env * (on ? 1 : releaseLeft / releaseSamples);
      return [outL * g, outR * g];
    },
  };
}

/** Modal mallet. Hue picks the bar: marimba, xylophone, vibraphone, glockenspiel. */
interface MalletSpec {
  ratios: number[];
  /** Seconds at 220 Hz. Higher notes are shorter. */
  decays: number[];
  /** Upper-mode levels relative to the fundamental, before the strike opens them. */
  gains: number[];
  tremHz: number;
}

function malletSpec(hue: number): MalletSpec {
  const h = ((hue % 360) + 360) % 360;
  if (h < 120) {
    return { ratios: [1, 3.92, 9.15, 15.8], decays: [0.9, 0.36, 0.14, 0.06], gains: [0.7, 0.38, 0.16], tremHz: 0 };
  }
  if (h < 200) {
    return { ratios: [1, 3, 6.05, 9.4], decays: [0.38, 0.16, 0.07, 0.035], gains: [0.85, 0.5, 0.22], tremHz: 0 };
  }
  if (h < 280) {
    return { ratios: [1, 3.97, 9.2, 14.6], decays: [1.8, 0.75, 0.28, 0.11], gains: [0.5, 0.22, 0.1], tremHz: 5.5 };
  }
  return { ratios: [1, 2.76, 5.4, 8.93], decays: [1.5, 0.85, 0.36, 0.15], gains: [0.95, 0.58, 0.32], tremHz: 0 };
}

export function createMarimba(sampleRate: number, hue: number, _seed: number): Engine {
  const spec = malletSpec(hue);
  const n = spec.ratios.length;
  const phases = new Array(n).fill(0);
  const amps = new Array(n).fill(0);
  const taus = new Array(n).fill(0.2);
  let freq = 440;
  let wasOn = false;
  let alive = 0;
  let releaseSec = 0.18;
  let trem = 0;

  return {
    setRelease(ms: number) {
      releaseSec = Math.max(0.04, ms / 1000);
    },
    processSample(midi, size, lightness) {
      const on = size > 1e-5;
      if (on && !wasOn) {
        freq = Math.max(40, midiToFrequency(midi));
        const pitchScale = Math.pow(freq / 220, 0.75);
        const strike = Math.min(1, Math.max(0, size));
        const open = 0.22 + strike * 1.45 + Math.min(1, Math.max(0, lightness)) * 0.3;
        // A harder strike keeps the upper modes ringing, so the note stays brighter.
        const hang = 0.35 + strike * 1.35;
        for (let m = 0; m < n; m++) {
          phases[m] = 0;
          taus[m] = Math.max(0.025, (spec.decays[m] * (m === 0 ? 1 : hang)) / pitchScale);
          amps[m] = size * (m === 0 ? 1 : spec.gains[m - 1] * open);
        }
        alive = Math.ceil(sampleRate * 4);
        trem = 0;
      }
      if (!on && wasOn) {
        const cap = releaseSec / 6;
        for (let m = 0; m < n; m++) taus[m] = Math.min(taus[m], cap);
      }
      wasOn = on;
      if (alive <= 0) return [0, 0];
      alive--;
      let l = 0;
      let r = 0;
      let peakAmp = 0;
      for (let m = 0; m < n; m++) {
        const f = freq * spec.ratios[m];
        if (f >= sampleRate * 0.45) {
          amps[m] = 0;
          continue;
        }
        phases[m] += (2 * Math.PI * f) / sampleRate;
        if (phases[m] > 2 * Math.PI) phases[m] -= 2 * Math.PI;
        amps[m] *= Math.exp(-1 / (taus[m] * sampleRate));
        peakAmp = Math.max(peakAmp, Math.abs(amps[m]));
        const s = Math.sin(phases[m]) * amps[m];
        const side = m % 2 === 0 ? 1.05 : 0.95;
        l += s * side;
        r += s * (2 - side);
      }
      if (peakAmp < 1e-5) {
        alive = 0;
        return [0, 0];
      }
      let g = 0.42;
      if (spec.tremHz > 0) {
        trem += (2 * Math.PI * spec.tremHz) / sampleRate;
        g *= 1 + 0.1 * Math.sin(trem);
      }
      return [l * g, r * g];
    },
  };
}

/** Two-operator FM electric piano. Hue picks the modulator ratio. */
export function createEpiano(sampleRate: number, hue: number, _seed: number): Engine {
  let car = 0;
  let mod = 0;
  let index = 0;
  let env = 0;
  let wasOn = false;
  let freq = 440;
  const ratio = 1 + Math.round((hue / 360) * 6);

  return {
    setRelease() {},
    processSample(midi, size, lightness) {
      const on = size > 1e-5;
      if (on && !wasOn) {
        freq = Math.max(30, midiToFrequency(midi));
        index = 1.2 + lightness * 3.5;
        env = size;
        car = 0;
        mod = 0;
      }
      wasOn = on;
      if (env < 1e-5 && index < 1e-4) return [0, 0];
      env *= Math.exp(-1 / (0.55 * sampleRate));
      index *= Math.exp(-1 / ((0.18 + lightness * 0.25) * sampleRate));
      mod += (2 * Math.PI * freq * ratio) / sampleRate;
      car += (2 * Math.PI * freq) / sampleRate;
      const s = Math.sin(car + Math.sin(mod) * index) * env;
      const s2 = Math.sin(car * 1.003 + Math.sin(mod + 0.2) * index) * env;
      return [s * 0.4, s2 * 0.4];
    },
  };
}

/** Hammond-style drawbar organ. Hue walks the registration; size and lightness open the upper stops. */
const ORGAN_RATIOS = [0.5, 1.5, 1, 2, 3, 4, 5, 6, 8];
// Dark 16'+8', flute 8'+4'+2', full mixture. Hue 0 and 360 are dark; 180 is full.
const ORGAN_REG = [
  [0.42, 0.08, 1, 0.18, 0.05, 0.06, 0, 0, 0],
  [0.16, 0.06, 1, 0.78, 0.12, 0.62, 0.04, 0.08, 0.2],
  [0.34, 0.28, 0.9, 0.74, 0.58, 0.68, 0.36, 0.3, 0.46],
];

function organRegistration(hue: number): number[] {
  const wrapped = ((hue % 360) + 360) % 360;
  const x = (1 - Math.cos((wrapped * Math.PI) / 180)) / 2;
  const pos = x * 2;
  const i = Math.min(1, Math.floor(pos));
  const f = pos - i;
  const out = new Array<number>(ORGAN_RATIOS.length);
  for (let k = 0; k < out.length; k++) out[k] = ORGAN_REG[i][k] * (1 - f) + ORGAN_REG[i + 1][k] * f;
  return out;
}

export function createOrgan(sampleRate: number, hue: number, _seed: number): Engine {
  const base = organRegistration(hue);
  const phases = new Array(ORGAN_RATIOS.length).fill(0);
  const amps = new Array(ORGAN_RATIOS.length).fill(0);
  let freq = 440;
  let env = 0;
  let perc = 0;
  let percPhase = 0;
  let wasOn = false;
  let heldSize = 0.5;
  let heldLight = 0.5;
  let releaseSec = 0.18;
  const attackCoeff = Math.exp(-1 / (0.004 * sampleRate));
  const ampCoeff = Math.exp(-1 / (0.015 * sampleRate));
  const percDecay = Math.exp(-1 / (0.16 * sampleRate));

  const shape = (size: number, lightness: number, f0: number): number[] => {
    const open = Math.min(1.65, 0.15 + lightness * 0.7 + size * 1.05);
    const tilt = open * 0.9 - 0.55;
    const raw = new Array<number>(ORGAN_RATIOS.length);
    for (let i = 0; i < ORGAN_RATIOS.length; i++) {
      const ratio = ORGAN_RATIOS[i];
      const partial = f0 * ratio;
      raw[i] = partial >= sampleRate * 0.45 ? 0 : base[i] * Math.pow(ratio, tilt);
    }
    // The key's pitch is the 8' stop. A louder 16' makes the note read an octave low.
    if (raw[2] > 0 && raw[0] > raw[2] * 0.12) raw[0] = raw[2] * 0.12;
    const sumSq = raw.reduce((s, v) => s + v * v, 0);
    const norm = sumSq > 1e-10 ? 1 / Math.sqrt(sumSq) : 0;
    for (let i = 0; i < raw.length; i++) raw[i] *= norm;
    return raw;
  };

  return {
    setRelease(ms: number) {
      releaseSec = Math.max(0.008, ms / 1000);
    },
    processSample(midi, size, lightness) {
      const on = size > 1e-5;
      if (on) {
        freq = Math.max(20, midiToFrequency(midi));
        if (size > 0.02) {
          heldSize = size;
          heldLight = lightness;
        }
      }
      if (on && !wasOn) {
        const target = shape(size, lightness, freq);
        for (let i = 0; i < amps.length; i++) amps[i] = target[i];
        // A fresh note starts at zero amplitude, so aligning phases does not click.
        if (env < 1e-4) {
          phases.fill(0);
          percPhase = 0;
        }
        perc = 0.55;
      }
      wasOn = on;
      if (!on && env < 1e-5 && perc < 1e-4) return [0, 0];

      const target = shape(heldSize, heldLight, freq);
      for (let i = 0; i < amps.length; i++) amps[i] = amps[i] * ampCoeff + target[i] * (1 - ampCoeff);

      // `release` is the time to about −60 dB, so the tail is finished inside the render window.
      const releaseCoeff = Math.exp(-6.9 / (releaseSec * sampleRate));
      const dest = on ? size : 0;
      env = dest + (env - dest) * (dest > env ? attackCoeff : releaseCoeff);
      perc *= percDecay;

      let l = 0;
      let r = 0;
      for (let i = 0; i < ORGAN_RATIOS.length; i++) {
        const partial = freq * ORGAN_RATIOS[i];
        if (partial >= sampleRate * 0.45) continue;
        phases[i] += (2 * Math.PI * partial) / sampleRate;
        if (phases[i] > 2 * Math.PI) phases[i] -= 2 * Math.PI;
        const s = Math.sin(phases[i]) * amps[i];
        const side = i % 2 === 0 ? 1.06 : 0.94;
        l += s * side;
        r += s * (2 - side);
      }
      // Percussion is the 4' harmonic, gone before the sustain measurement settles.
      const percFreq = freq * 4;
      if (percFreq < sampleRate * 0.45) {
        percPhase += (2 * Math.PI * percFreq) / sampleRate;
        const s = Math.sin(percPhase) * perc * 0.22;
        l += s;
        r += s;
      }
      const g = env * 0.28;
      return [l * g, r * g];
    },
  };
}

export type AcousticEngine = 'pluck' | 'marimba' | 'epiano' | 'organ';

export function isAcousticEngine(name: string | undefined): name is AcousticEngine {
  return name === 'pluck' || name === 'marimba' || name === 'epiano' || name === 'organ';
}

export function createEngine(name: AcousticEngine, sampleRate: number, hue: number, seed: number): Engine {
  if (name === 'pluck') return createPluck(sampleRate, hue, seed);
  if (name === 'marimba') return createMarimba(sampleRate, hue, seed);
  if (name === 'organ') return createOrgan(sampleRate, hue, seed);
  return createEpiano(sampleRate, hue, seed);
}
