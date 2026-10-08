import { midiToFrequency, mulberry32 } from '../synth.js';
import { createPitchLife, type Engine, type PitchLifeSpec } from './core.js';

/**
 * Sustained additive synthesis. A held tone is a stack of harmonics whose slope
 * opens with loudness, plus filtered breath or bow noise and one resonance.
 * Bowed strings, brass, saxophone, double reeds, and both basses share this method;
 * a preset is only numbers.
 */
export interface HarmonicPreset {
  partials: number;
  /** Partial n starts at phase n²·phaseSpread, so a bright slope does not line up into a sawtooth corner. */
  phaseSpread: number;
  minHz: number;
  /** Highest fundamental, as a fraction of the sample rate. */
  maxHzRatio: number;
  /**
   * Harmonic n has level exp(−slope·(n−1)). About 8.7 dB per octave per unit.
   * slope = (base + soft·shade + high·(high + highSoft·shade)) · (1 − lowFlatten·low) − light·(lightness − 0.5),
   * where shade = (1 − size)^softPow, high ramps from highFrom over highSpan semitones,
   * and low ramps from lowFrom downward over 24 semitones.
   */
  slope: {
    base: number;
    soft: number;
    softPow: number;
    high: number;
    highSoft: number;
    highFrom: number;
    highSpan: number;
    lowFlatten: number;
    lowFrom: number;
    light: number;
    min: number;
  };
  /** Four-pole lowpass on harmonics and noise together. Cutoff = hz + size·strike + (lightness − 0.5)·light, at least min. */
  lowpass?: { hz: number; strike: number; light: number; min: number };
  /** Bandpass body, bell, or formant. Mix = mix + size·mixStrike. */
  resonance: { hz: number; q: number; mix: number; mixStrike: number };
  /**
   * Breath or bow noise. One-pole lowpass at hz + size·hzStrike.
   * Level = (level + size·strike + size²·strike2) · (low + highRamp·high).
   */
  noise: { hz: number; hzStrike: number; level: number; strike: number; strike2: number; low: number; high: number };
  /**
   * A brighter copy of the harmonics that dies after the attack, plus a short noise burst.
   * Finger attack on an electric bass.
   */
  transient?: { level: number; brighten: number; minSlope: number; sec: number; noise: number; noiseStrike: number; noiseSec: number };
  /**
   * Decay while the key is held. Partial n has time constant
   * sec·(refHz/f0)^pitchPow / n^partialPow. A player keeps a bow or a breath alive, so those presets omit it.
   */
  ring?: { sec: number; refHz: number; pitchPow: number; partialPow: number };
  attackSec: number;
  releaseSec: number;
  life: PitchLifeSpec;
  gain: number;
  stereo: [number, number];
}

const BOW = {
  partials: 28,
  phaseSpread: 0.47,
  minHz: 40,
  maxHzRatio: 0.22,
  noise: { hz: 350, hzStrike: 2800, level: 0.04, strike: 0.09, strike2: 0, low: 1, high: 0 },
  releaseSec: 0.18,
  gain: 0.55,
  stereo: [1.03, 0.97] as [number, number],
};
const bowSlope = (base: number) => ({
  base,
  soft: 0.09,
  softPow: 1,
  high: 0,
  highSoft: 0,
  highFrom: 48,
  highSpan: 24,
  lowFlatten: 0,
  lowFrom: 0,
  light: 0.05,
  min: 0.06,
});
const bowLife = (vibratoCents: number, vibratoHz: number, shimmerRms: number): PitchLifeSpec => ({
  vibratoCents,
  vibratoHz,
  vibratoDelaySec: 0.22,
  wanderCents: 2,
  vibratoGain: 0.05,
  shimmerRms,
});

const BRASS = {
  partials: 28,
  phaseSpread: 0.41,
  minHz: 40,
  maxHzRatio: 0.22,
  releaseSec: 0.18,
  gain: 0.48,
  stereo: [1.02, 0.98] as [number, number],
};
const brassSlope = (loud: number, soft: number, high: number, softPow: number) => ({
  base: loud,
  soft,
  softPow,
  high,
  highSoft: 0.25,
  highFrom: 48,
  highSpan: 24,
  lowFlatten: 0,
  lowFrom: 0,
  light: 0.06,
  min: 0.045,
});
const brassNoise = (strike2: number) => ({ hz: 500, hzStrike: 3500, level: 0.02, strike: 0, strike2, low: 0.7, high: 0.3 });
const brassResonance = (hz: number) => ({ hz, q: 7, mix: 0.08, mixStrike: 0.18 });
const brassLife = (wanderCents: number, shimmerRms: number): PitchLifeSpec => ({
  vibratoCents: 0,
  vibratoHz: 0,
  vibratoDelaySec: 0,
  wanderCents,
  vibratoGain: 0,
  shimmerRms,
});

const REED = {
  partials: 32,
  phaseSpread: 0.33,
  minHz: 32,
  maxHzRatio: 0.22,
  releaseSec: 0.16,
  gain: 0.46,
  stereo: [1.03, 0.97] as [number, number],
};
const reedSlope = (loud: number, soft: number, lowFrom: number) => ({
  base: loud,
  soft: soft - loud,
  softPow: 1.25,
  high: 0,
  highSoft: 0,
  highFrom: 48,
  highSpan: 24,
  lowFlatten: 0.55,
  lowFrom,
  light: 0.08,
  min: 0.1,
});
const reedNoise = (n: number) => ({ hz: 700, hzStrike: 2200, level: n * 0.5, strike: n * 0.8, strike2: 0, low: 1, high: 0 });

const BASS = {
  partials: 40,
  phaseSpread: 0.37,
  minHz: 28,
  maxHzRatio: 0.2,
  releaseSec: 0.22,
  gain: 0.5,
  stereo: [1.02, 0.98] as [number, number],
};
const bassSlope = (dark: number) => ({
  base: dark,
  soft: 0.15,
  softPow: 1,
  high: 0,
  highSoft: 0,
  highFrom: 48,
  highSpan: 24,
  lowFlatten: 0,
  lowFrom: 0,
  light: 0.08,
  min: 0.08,
});
const bassNoise = (n: number) => ({ hz: 180, hzStrike: 900, level: n * 0.4, strike: n, strike2: 0, low: 1, high: 0 });

export const HARMONIC_PRESETS = {
  violin: {
    ...BOW,
    slope: bowSlope(0.11),
    lowpass: { hz: 5600, strike: 3200, light: 400, min: 800 },
    resonance: { hz: 290, q: 8, mix: 0.16, mixStrike: 0 },
    attackSec: 0.028,
    life: bowLife(12, 5.6, 0.05),
  },
  viola: {
    ...BOW,
    slope: bowSlope(0.1212),
    lowpass: { hz: 5540, strike: 3200, light: 400, min: 800 },
    resonance: { hz: 210, q: 8, mix: 0.16, mixStrike: 0 },
    attackSec: 0.04,
    life: bowLife(11, 5.4, 0.048),
  },
  cello: {
    ...BOW,
    slope: bowSlope(0.138),
    lowpass: { hz: 5450, strike: 3200, light: 400, min: 800 },
    resonance: { hz: 125, q: 8, mix: 0.16, mixStrike: 0 },
    attackSec: 0.055,
    life: bowLife(9, 5.2, 0.053),
  },
  contrabass: {
    ...BASS,
    slope: bassSlope(0.12),
    resonance: { hz: 70, q: 6, mix: 0.08, mixStrike: 0 },
    noise: bassNoise(0.035),
    attackSec: 0.05,
    life: { vibratoCents: 6, vibratoHz: 4.9, vibratoDelaySec: 0.3, wanderCents: 2.5, vibratoGain: 0.04, shimmerRms: 0.043 },
  },
  // Fitted to NSynth electronic basses (CC BY 4.0). Held strings decay; a finger transient dies in a few dozen milliseconds.
  'electric-bass': {
    ...BASS,
    slope: {
      base: 0.56,
      soft: 0.2375,
      softPow: 1,
      high: 0,
      highSoft: 0,
      highFrom: 48,
      highSpan: 24,
      lowFlatten: 0,
      lowFrom: 0,
      light: 0.08,
      min: 0.08,
    },
    resonance: { hz: 179.5, q: 5.25, mix: 0.26, mixStrike: 0 },
    noise: { hz: 273.75, hzStrike: 900, level: 0, strike: 0.015, strike2: 0, low: 1, high: 0 },
    transient: { level: 0.675, brighten: 0.305, minSlope: 0.06, sec: 0.015, noise: 0.3, noiseStrike: 0.55, noiseSec: 0.018 },
    attackSec: 0.01625,
    ring: { sec: 1.425, refHz: 55, pitchPow: 0.86875, partialPow: 0.7 },
    life: { vibratoCents: 0, vibratoHz: 0, vibratoDelaySec: 0, wanderCents: 1.2, vibratoGain: 0, shimmerRms: 0.0125 },
  },
  // Horn and tuba stay darker on high notes even when loud; trumpet does not. A saxophone opens up by mezzo-forte.
  trumpet: {
    ...BRASS,
    slope: brassSlope(0.05, 2.55, 0.023, 1.35),
    resonance: brassResonance(1800),
    noise: brassNoise(0.16),
    attackSec: 0.05,
    life: brassLife(1.5, 0.03),
  },
  horn: {
    ...BRASS,
    slope: brassSlope(0.55, 2.5, 1.3225, 1.35),
    resonance: brassResonance(480),
    noise: brassNoise(0.05),
    attackSec: 0.06,
    life: brassLife(1.5, 0.025),
  },
  trombone: {
    ...BRASS,
    slope: brassSlope(0.15, 2.05, 0.4025, 1.35),
    resonance: brassResonance(620),
    noise: brassNoise(0.07),
    attackSec: 0.042,
    life: brassLife(1.5, 0.032),
  },
  tuba: {
    ...BRASS,
    slope: brassSlope(0.02, 1.6, 1.4375, 1.35),
    resonance: brassResonance(220),
    noise: brassNoise(0.03),
    attackSec: 0.07,
    life: brassLife(3, 0.048),
  },
  saxophone: {
    ...BRASS,
    slope: brassSlope(0.25, 4.2, 0.2875, 2.2),
    resonance: brassResonance(1700),
    noise: brassNoise(0.1),
    attackSec: 0.038,
    life: brassLife(1.5, 0.018),
  },
  // A conical bore has every harmonic; the formant is what makes a double reed nasal.
  oboe: {
    ...REED,
    slope: reedSlope(0.22, 1.15, 72),
    resonance: { hz: 1500, q: 11, mix: 0.28, mixStrike: 0.22 },
    noise: reedNoise(0.04),
    attackSec: 0.032,
    life: brassLife(1.5, 0.025),
  },
  bassoon: {
    ...REED,
    slope: reedSlope(0.18, 1.55, 62),
    resonance: { hz: 540, q: 11, mix: 0.28, mixStrike: 0.22 },
    noise: reedNoise(0.028),
    attackSec: 0.048,
    life: brassLife(1.5, 0.028),
  },
} satisfies Record<string, HarmonicPreset>;

export type HarmonicInstrument = keyof typeof HARMONIC_PRESETS;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function createHarmonic(sampleRate: number, preset: HarmonicPreset, seed: number): Engine {
  const p = preset;
  const rng = mulberry32(seed || 1);
  const N = p.partials;
  const phases = new Float64Array(N);
  const gains = new Float64Array(N);
  const brightGains = new Float64Array(N);
  const tr = p.transient;
  let freq = 440;
  let env = 0;
  let wasOn = false;
  let releaseSec = p.releaseSec;
  const attackCoeff = Math.exp(-1 / (p.attackSec * sampleRate));
  let nz = 0;
  let noisePole = 0.8;
  let noiseAmp = 0.02;
  let trEnv = 0;
  let finger = 0;
  const ringDec = new Float64Array(N);
  let useRing = false;
  const trDec = tr ? Math.exp(-1 / (tr.sec * sampleRate)) : 0;
  const fingerDec = tr ? Math.exp(-1 / (tr.noiseSec * sampleRate)) : 0;
  const bodyW = (2 * Math.PI * p.resonance.hz) / sampleRate;
  const bodyAlpha = Math.sin(bodyW) / p.resonance.q;
  const bodyA0 = 1 + bodyAlpha;
  const bodyB0 = bodyAlpha / bodyA0;
  const bodyB2 = -bodyAlpha / bodyA0;
  const bodyA1 = (-2 * Math.cos(bodyW)) / bodyA0;
  const bodyA2 = (1 - bodyAlpha) / bodyA0;
  let bz1 = 0;
  let bz2 = 0;
  let bodyMix = p.resonance.mix;
  let smoothPole = 0.5;
  const smooth = [0, 0, 0, 0];
  const life = createPitchLife(sampleRate, p.life, seed);

  return {
    setRelease(ms: number) {
      releaseSec = Math.max(0.02, ms / 1000);
    },
    processSample(midi, size, lightness) {
      const on = size > 1e-5;
      if (on && !wasOn) {
        freq = Math.min(sampleRate * p.maxHzRatio, Math.max(p.minHz, midiToFrequency(midi)));
        const strike = clamp01(size);
        const light = clamp01(lightness);
        const s = p.slope;
        const high = clamp01((midi - s.highFrom) / s.highSpan);
        const low = s.lowFlatten > 0 ? clamp01((s.lowFrom - midi) / 24) : 0;
        const shade = Math.pow(1 - strike, s.softPow);
        const tilt = Math.max(
          s.min,
          (s.base + s.soft * shade + high * (s.high + s.highSoft * shade)) * (1 - s.lowFlatten * low) - (light - 0.5) * s.light,
        );
        const brightTilt = tr ? Math.max(tr.minSlope, tilt - tr.brighten) : 0;
        let energy = 0;
        for (let n = 1; n <= N; n++) {
          const audible = freq * n < sampleRate * 0.45;
          const g = audible ? Math.exp(-tilt * (n - 1)) : 0;
          gains[n - 1] = g;
          brightGains[n - 1] = audible && tr ? Math.exp(-brightTilt * (n - 1)) : 0;
          energy += g * g;
          phases[n - 1] = n * n * p.phaseSpread;
        }
        const norm = energy > 1e-12 ? 1 / Math.sqrt(energy) : 0;
        for (let n = 0; n < N; n++) {
          gains[n] *= norm;
          brightGains[n] *= norm;
        }
        if (p.lowpass) {
          const cut = Math.max(p.lowpass.min, p.lowpass.hz + strike * p.lowpass.strike + (light - 0.5) * p.lowpass.light);
          smoothPole = Math.exp((-2 * Math.PI * cut) / sampleRate);
          smooth[0] = smooth[1] = smooth[2] = smooth[3] = 0;
        }
        const ns = p.noise;
        nz = 0;
        noisePole = Math.exp((-2 * Math.PI * (ns.hz + strike * ns.hzStrike)) / sampleRate);
        noiseAmp = (ns.level + strike * ns.strike + strike * strike * ns.strike2) * (ns.low + high * ns.high);
        bodyMix = p.resonance.mix + strike * p.resonance.mixStrike;
        trEnv = tr ? tr.level : 0;
        finger = tr ? tr.level * (tr.noise + strike * tr.noiseStrike) : 0;
        useRing = p.ring !== undefined;
        if (p.ring) {
          for (let n = 1; n <= N; n++) {
            const tau = Math.max(
              0.03,
              (p.ring.sec * Math.pow(p.ring.refHz / freq, p.ring.pitchPow)) / Math.pow(n, p.ring.partialPow),
            );
            ringDec[n - 1] = Math.exp(-1 / (tau * sampleRate));
          }
        }
        bz1 = 0;
        bz2 = 0;
        env = 0;
        life.start();
      }
      wasOn = on;
      if (!on && env < 1e-5 && finger < 1e-4) return [0, 0];
      const releaseCoeff = Math.exp(-6.9 / (releaseSec * sampleRate));
      const dest = on ? size : 0;
      env = dest + (env - dest) * (dest > env ? attackCoeff : releaseCoeff);
      if (tr) {
        trEnv *= trDec;
        finger *= fingerDec;
      }
      life.step();
      const step = (2 * Math.PI * freq * life.ratio) / sampleRate;
      let sum = 0;
      let bright = 0;
      for (let n = 0; n < N; n++) {
        if (gains[n] === 0 && brightGains[n] === 0) continue;
        if (useRing) {
          gains[n] *= ringDec[n];
          if (tr) brightGains[n] *= ringDec[n];
        }
        phases[n] += step * (n + 1);
        if (phases[n] > Math.PI * 2) phases[n] -= Math.PI * 2;
        const sine = Math.sin(phases[n]);
        sum += sine * gains[n];
        if (tr) bright += sine * brightGains[n];
      }
      const white = rng() * 2 - 1;
      nz = white * (1 - noisePole) + nz * noisePole;
      let src = tr ? sum + bright * trEnv : sum;
      let noise = nz * (noiseAmp + finger);
      if (p.lowpass) {
        src += noise;
        noise = 0;
        const a = 1 - smoothPole;
        for (let i = 0; i < 4; i++) {
          smooth[i] = src * a + smooth[i] * smoothPole;
          src = smooth[i];
        }
      }
      const body = bodyB0 * src + bz1;
      bz1 = -bodyA1 * body + bz2;
      bz2 = bodyB2 * src - bodyA2 * body;
      const out = (src + body * bodyMix + noise) * env * life.gain * p.gain;
      return [out * p.stereo[0], out * p.stereo[1]];
    },
  };
}

const wrap = (hue: number) => ((hue % 360) + 360) % 360;

/** Hue ranges the older `bow`, `brass`, `reed`, and `bass` engine names select. */
export function harmonicInstrumentFor(engine: 'bow' | 'brass' | 'reed' | 'bass', hue: number): HarmonicInstrument {
  const h = wrap(hue);
  if (engine === 'bow') return h < 120 ? 'violin' : h < 240 ? 'viola' : 'cello';
  if (engine === 'reed') return h < 180 ? 'oboe' : 'bassoon';
  if (engine === 'bass') return h < 180 ? 'contrabass' : 'electric-bass';
  return h < 90 ? 'trumpet' : h < 180 ? 'horn' : h < 240 ? 'trombone' : h < 300 ? 'tuba' : 'saxophone';
}
