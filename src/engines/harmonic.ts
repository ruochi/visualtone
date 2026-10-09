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
  noise: {
    hz: number;
    hzStrike: number;
    level: number;
    strike: number;
    strike2: number;
    low: number;
    high: number;
    /**
     * Bow noise added after the lowpass, so it fills the gaps between partials
     * instead of being filtered into a low cloud. 0 leaves the sample unchanged.
     */
    direct?: number;
    directHz?: number;
    /** Highpass the bow noise at this multiple of the fundamental, before it reaches the body. */
    lowCut?: number;
  };
  /**
   * Body modes painted onto the harmonic ladder at note-on.
   * Partial level gets Σ db·|bandpass(f)|, so a fixed body can lift one partial and sink the next.
   * Absent leaves every partial on the plain slope.
   */
  modes?: { hz: number; q: number; db: number }[];
  /**
   * A dense body, rebuilt from `seed` so a fit can search shapes without storing every peak.
   * Narrow peaks and dips sit on a log-frequency table. While the note sounds, each partial
   * looks up its own instantaneous frequency, so vibrato sweeps it up and down the slope.
   * Absent leaves the partials on the slope and on `modes`.
   */
  body?: { seed: number; count: number; qLo: number; qHi: number; db: number; loHz: number; hiHz: number };
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
  /**
   * -60 dB time follows the note. lowSec is at lowMidi, highSec at highMidi.
   * A quieter size holds longer by soft·(1−size). Unset keeps releaseSec.
   */
  releaseShape?: { lowSec: number; highSec: number; lowMidi: number; highMidi: number; soft: number };
  /**
   * A bow does not sit still. The note reaches swellFrom quickly, then opens to full
   * level over swellSec (capped at 0.4 s). After that the level falls by dbPerSec and
   * the slope steepens by tiltPerSec, so higher partials die first.
   */
  bowArc?: { swellFrom: number; swellSec: number; dbPerSec: number; tiltPerSec: number };
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
    partials: 28,
    phaseSpread: 0.47,
    minHz: 40,
    maxHzRatio: 0.22,
    noise: {
      hz: 546.875,
      hzStrike: 2800,
      level: 0.07,
      strike: 0.09,
      strike2: 0,
      low: 1,
      high: 0,
      direct: 0.075,
      directHz: 3275,
    },
    releaseSec: 0.18,
    gain: 0.55,
    stereo: [1.03, 0.97],
    slope: {
      base: 0.2,
      soft: 0.15,
      softPow: 1,
      high: 0,
      highSoft: 0,
      highFrom: 48,
      highSpan: 24,
      lowFlatten: 0,
      lowFrom: 0,
      light: 0.05,
      min: 0.06,
    },
    lowpass: {
      hz: 9000,
      strike: 3200,
      light: 400,
      min: 800,
    },
    resonance: {
      hz: 287.2,
      q: 5.6,
      mix: 0.425,
      mixStrike: 0,
    },
    modes: [
      { hz: 173.6, q: 1.6, db: 9.57 },
      { hz: 530, q: 6, db: 9.81 },
      { hz: 1209.6, q: 3, db: -12.42 },
      { hz: 4160, q: 6, db: 10.52 },
      { hz: 2800, q: 1.6, db: 8 },
    ],
    transient: { level: 0.35, brighten: 0.28, minSlope: 0.06, sec: 0.045, noise: 0.16, noiseStrike: 0, noiseSec: 0.04 },
    bowArc: { swellFrom: 0.55, swellSec: 0.28, dbPerSec: 0.6, tiltPerSec: 0.04 },
    body: { seed: 23, count: 368, qLo: 59, qHi: 173.5, db: 2.875, loHz: 160, hiHz: 12000 },
    attackSec: 0.0455,
    life: {
      vibratoCents: 17.4375,
      vibratoHz: 5.375,
      vibratoDelaySec: 0.22,
      wanderCents: 2.3,
      vibratoGain: 0,
      shimmerRms: 0.02775,
      vibratoHighCents: 5.75,
      vibratoLowMidi: 60,
      vibratoHighMidi: 68,
      vibratoDepthJitter: 0.06,
      vibratoRateJitter: 0.135,
    },
    releaseShape: { lowSec: 0.6, highSec: 0.68, lowMidi: 60, highMidi: 84, soft: 1 },
  },
  viola: {
    partials: 28,
    phaseSpread: 0.47,
    minHz: 40,
    maxHzRatio: 0.22,
    noise: {
      hz: 546.875,
      hzStrike: 2800,
      level: 0.1225,
      strike: 0.09,
      strike2: 0,
      low: 1,
      high: 0,
      direct: 0.03125,
      directHz: 5200,
      lowCut: 0.7,
    },
    releaseSec: 0.18,
    gain: 0.55,
    stereo: [1.03, 0.97],
    slope: {
      base: 0.15245,
      soft: 0.1725,
      softPow: 1,
      high: 0,
      highSoft: 0,
      highFrom: 48,
      highSpan: 24,
      lowFlatten: 0,
      lowFrom: 0,
      light: 0.05,
      min: 0.06,
    },
    lowpass: {
      hz: 6590,
      strike: 3200,
      light: 400,
      min: 800,
    },
    resonance: {
      hz: 180.6,
      q: 9.6,
      mix: 0.27625,
      mixStrike: 0,
    },
    modes: [{ hz: 2400, q: 1.6, db: 6 }],
    transient: { level: 0.35, brighten: 0.28, minSlope: 0.06, sec: 0.045, noise: 0.16, noiseStrike: 0, noiseSec: 0.04 },
    bowArc: { swellFrom: 0.55, swellSec: 0.28, dbPerSec: 0.6, tiltPerSec: 0.04 },
    body: { seed: 20, count: 368, qLo: 37, qHi: 167.5, db: 3.125, loHz: 120, hiHz: 10000 },
    attackSec: 0.0645,
    life: {
      vibratoCents: 3.4375,
      vibratoHz: 5.4,
      vibratoDelaySec: 0.22,
      wanderCents: 2.3,
      vibratoGain: 0,
      shimmerRms: 0.0525,
      vibratoHighCents: 11.5,
      vibratoLowMidi: 48,
      vibratoHighMidi: 72,
      vibratoDepthJitter: 0.1,
      vibratoRateJitter: 0.075,
    },
    releaseShape: { lowSec: 1.04, highSec: 0.92, lowMidi: 48, highMidi: 72, soft: 0.65 },
  },
  cello: {
    ...BOW,
    noise: { ...BOW.noise, level: 0.0625, direct: 0.04375, directHz: 3362.5 },
    slope: { ...bowSlope(0.19425), soft: 0.03 },
    lowpass: { hz: 6350, strike: 3200, light: 400, min: 800 },
    resonance: { hz: 116.25, q: 8, mix: 0.1725, mixStrike: 0 },
    modes: [
      { hz: 203.8, q: 6, db: 10.62 },
      { hz: 222.2, q: 6, db: 11.51 },
      { hz: 1014, q: 11, db: 8.66 },
      { hz: 4864, q: 1.6, db: 10.72 },
      { hz: 2200, q: 1.6, db: 6 },
    ],
    transient: { level: 0.35, brighten: 0.28, minSlope: 0.06, sec: 0.045, noise: 0.16, noiseStrike: 0, noiseSec: 0.04 },
    bowArc: { swellFrom: 0.55, swellSec: 0.28, dbPerSec: 0.6, tiltPerSec: 0.04 },
    attackSec: 0.055,
    body: { seed: 13, count: 332, qLo: 58, qHi: 155.5, db: 3.875, loHz: 70, hiHz: 8000 },
    life: {
      ...bowLife(4.25, 5.2, 0.06),
      vibratoGain: 0,
      vibratoHighCents: 18.75,
      vibratoLowMidi: 48,
      vibratoHighMidi: 72,
      vibratoDepthJitter: 0.1,
      vibratoRateJitter: 0.04875,
    },
    releaseShape: { lowSec: 1.72, highSec: 0.4, lowMidi: 36, highMidi: 72, soft: 0.4 },
  },
  contrabass: {
    partials: 40,
    phaseSpread: 0.37,
    minHz: 28,
    maxHzRatio: 0.2,
    releaseSec: 0.22,
    gain: 0.5,
    stereo: [1.02, 0.98],
    slope: {
      base: 0.16125,
      soft: 0.1275,
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
    resonance: {
      hz: 103.75,
      q: 3.6,
      mix: 0.35375,
      mixStrike: 0,
    },
    noise: {
      hz: 281.25,
      hzStrike: 900,
      level: 0.079,
      strike: 0.035,
      strike2: 0,
      low: 1,
      high: 0,
      direct: 0.025,
      directHz: 3362.5,
    },
    attackSec: 0.06575,
    modes: [{ hz: 1600, q: 1.6, db: 5 }],
    transient: { level: 0.35, brighten: 0.28, minSlope: 0.06, sec: 0.045, noise: 0.16, noiseStrike: 0, noiseSec: 0.04 },
    bowArc: { swellFrom: 0.55, swellSec: 0.28, dbPerSec: 0.6, tiltPerSec: 0.04 },
    body: { seed: 23, count: 308, qLo: 51, qHi: 161.5, db: 4.375, loHz: 40, hiHz: 6000 },
    life: {
      vibratoCents: 6.0625,
      vibratoHz: 4.45,
      vibratoDelaySec: 0.3,
      wanderCents: 1.6,
      vibratoGain: 0,
      shimmerRms: 0.02975,
      vibratoHighCents: 4.75,
      vibratoLowMidi: 36,
      vibratoHighMidi: 50,
      vibratoDepthJitter: 0.06,
      vibratoRateJitter: 0.01125,
    },
    releaseShape: { lowSec: 1.23, highSec: 0.64, lowMidi: 36, highMidi: 60, soft: 0.55 },
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
    partials: 28,
    phaseSpread: 0.41,
    minHz: 40,
    maxHzRatio: 0.22,
    releaseSec: 0.18,
    gain: 0.48,
    stereo: [1.02, 0.98],
    slope: {
      base: 0.03,
      soft: 1.91,
      softPow: 1.35,
      high: 0.4025,
      highSoft: 0.25,
      highFrom: 48,
      highSpan: 24,
      lowFlatten: 0,
      lowFrom: 0,
      light: 0.06,
      min: 0.045,
    },
    resonance: {
      hz: 641.7,
      q: 4,
      mix: 0.21125,
      mixStrike: 0.18,
    },
    noise: {
      hz: 518.75,
      hzStrike: 3500,
      level: 0.03,
      strike: 0,
      strike2: 0.07,
      low: 0.7,
      high: 0.3,
    },
    attackSec: 0.05775,
    life: {
      vibratoCents: 0,
      vibratoHz: 0,
      vibratoDelaySec: 0,
      wanderCents: 1.65,
      vibratoGain: 0,
      shimmerRms: 0.0125,
    },
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
    partials: 28,
    phaseSpread: 0.41,
    minHz: 40,
    maxHzRatio: 0.22,
    releaseSec: 0.18,
    gain: 0.48,
    stereo: [1.02, 0.98],
    slope: {
      base: 0.17,
      soft: 3.92,
      softPow: 2.2,
      high: 0.1275,
      highSoft: 0.25,
      highFrom: 48,
      highSpan: 24,
      lowFlatten: 0,
      lowFrom: 0,
      light: 0.06,
      min: 0.045,
    },
    resonance: {
      hz: 1700,
      q: 4.4,
      mix: 0.17625,
      mixStrike: 0.18,
    },
    noise: {
      hz: 575,
      hzStrike: 3500,
      level: 0.02,
      strike: 0,
      strike2: 0.1,
      low: 0.7,
      high: 0.3,
    },
    attackSec: 0.052,
    life: {
      vibratoCents: 0,
      vibratoHz: 0,
      vibratoDelaySec: 0,
      wanderCents: 1.05,
      vibratoGain: 0,
      shimmerRms: 0.0075,
    },
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

const BODY_PER_OCT = 400;
const BODY_BLOCK = 32;

function buildBodyTable(
  body: NonNullable<HarmonicPreset['body']>,
  modes: HarmonicPreset['modes'],
): { db: Float64Array; logLo: number } | null {
  const lo = body.loHz;
  const hi = body.hiHz;
  const count = Math.round(body.count);
  if (!(hi > lo) || count < 1 || !(body.db > 0)) return null;
  const logLo = Math.log2(lo);
  const octaves = Math.log2(hi) - logLo;
  const n = Math.max(8, Math.ceil(octaves * BODY_PER_OCT));
  const table = new Float64Array(n);
  const rng = mulberry32((Math.round(body.seed) >>> 0) || 1);
  const peaks: { hz: number; q: number; db: number }[] = [];
  for (let i = 0; i < count; i++) {
    const hz = Math.pow(2, logLo + rng() * octaves);
    const q = body.qLo + rng() * Math.max(0, body.qHi - body.qLo);
    const amp = body.db * (0.6 + 0.8 * rng());
    peaks.push({ hz, q: Math.max(1.5, q), db: (rng() < 0.5 ? -1 : 1) * amp });
  }
  if (modes) for (const m of modes) peaks.push(m);
  for (const m of peaks) {
    const half = Math.max(0.03, 8 / Math.max(1.5, m.q));
    const center = (Math.log2(m.hz) - logLo) * BODY_PER_OCT;
    const i0 = Math.max(0, Math.floor(center - half * BODY_PER_OCT));
    const i1 = Math.min(n - 1, Math.ceil(center + half * BODY_PER_OCT));
    for (let k = i0; k <= i1; k++) {
      const f = Math.pow(2, logLo + (k + 0.5) / BODY_PER_OCT);
      const r = f / m.hz;
      const rq = r / m.q;
      const d = (1 - r * r) * (1 - r * r) + rq * rq;
      table[k] += m.db * (rq / Math.sqrt(d));
    }
  }
  return { db: table, logLo };
}

function lookupBody(table: { db: Float64Array; logLo: number }, hz: number): number {
  const x = (Math.log2(Math.max(1, hz)) - table.logLo) * BODY_PER_OCT - 0.5;
  if (x <= 0) return table.db[0];
  const last = table.db.length - 1;
  if (x >= last) return table.db[last];
  const i = Math.floor(x);
  const f = x - i;
  return table.db[i] * (1 - f) + table.db[i + 1] * f;
}

function clampDb(db: number): number {
  if (db > 18) return 18;
  if (db < -24) return -24;
  return db;
}

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
  let releaseScale = 1;
  const attackCoeff = Math.exp(-1 / (p.attackSec * sampleRate));
  let nz = 0;
  let noisePole = 0.8;
  let noiseAmp = 0.02;
  let air = 0;
  let airPole = 0.8;
  let airAmp = 0;
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
  const bodyTable = p.body ? buildBodyTable(p.body, p.modes) : null;
  const nominalDb = new Float64Array(N);
  const bodyNow = new Float64Array(N);
  const bodyTarget = new Float64Array(N);
  const bodyInc = new Float64Array(N);
  let bodyTick = 0;
  let arcSamples = 0;
  let arcTick = 0;
  let noiseHp = 0;
  let noiseHpPole = 0;
  for (let n = 0; n < N; n++) bodyNow[n] = 1;

  return {
    setRelease(ms: number) {
      if (p.releaseShape) releaseScale = ms / 180;
      else releaseSec = Math.max(0.02, ms / 1000);
    },
    processSample(midi, size, lightness) {
      const on = size > 1e-5;
      if (on && !wasOn) {
        freq = Math.min(sampleRate * p.maxHzRatio, Math.max(p.minHz, midiToFrequency(midi)));
        if (p.releaseShape) {
          const shape = p.releaseShape;
          const span = shape.highMidi - shape.lowMidi;
          const u = span === 0 ? 1 : clamp01((midi - shape.lowMidi) / span);
          let sec = shape.lowSec + (shape.highSec - shape.lowSec) * u;
          if (shape.soft) sec *= 1 + shape.soft * (1 - clamp01(size));
          releaseSec = Math.max(0.02, sec * releaseScale);
        }
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
        const modes = bodyTable ? undefined : p.modes;
        let energy = 0;
        for (let n = 1; n <= N; n++) {
          const audible = freq * n < sampleRate * 0.45;
          let g = audible ? Math.exp(-tilt * (n - 1)) : 0;
          if (bodyTable && g > 0) {
            const db = clampDb(lookupBody(bodyTable, freq * n));
            nominalDb[n - 1] = db;
            g *= Math.pow(10, db / 20);
          } else if (modes && g > 0) {
            const f = freq * n;
            let db = 0;
            for (let i = 0; i < modes.length; i++) {
              const m = modes[i];
              const r = f / m.hz;
              const rq = r / m.q;
              const d = (1 - r * r) * (1 - r * r) + rq * rq;
              db += m.db * (rq / Math.sqrt(d));
            }
            if (db > 18) db = 18;
            else if (db < -24) db = -24;
            g *= Math.pow(10, db / 20);
          }
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
        air = 0;
        airAmp = ns.direct ?? 0;
        airPole = Math.exp((-2 * Math.PI * (ns.directHz ?? 4500)) / sampleRate);
        if (ns.lowCut) {
          noiseHp = 0;
          noiseHpPole = Math.exp((-2 * Math.PI * Math.max(20, ns.lowCut * freq)) / sampleRate);
        }
        arcSamples = 0;
        arcTick = 0;
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
        if (bodyTable) {
          bodyTick = 0;
          for (let n = 0; n < N; n++) bodyNow[n] = 1;
        }
        life.pitch(midi);
        life.start();
      }
      wasOn = on;
      if (!on && env < 1e-5 && finger < 1e-4) return [0, 0];
      const releaseCoeff = Math.exp(-6.9 / (releaseSec * sampleRate));
      let dest = on ? size : 0;
      if (on && p.bowArc) {
        const swellN = Math.min(0.4, Math.max(0.02, p.bowArc.swellSec)) * sampleRate;
        const u = Math.min(1, arcSamples / swellN);
        dest = size * (p.bowArc.swellFrom + (1 - p.bowArc.swellFrom) * u);
        if (arcSamples >= swellN && arcTick === 0) {
          const dt = BODY_BLOCK / sampleRate;
          const decay = Math.pow(10, (-p.bowArc.dbPerSec * dt) / 20);
          const tilt = p.bowArc.tiltPerSec * dt;
          for (let n = 0; n < N; n++) {
            if (gains[n] !== 0) gains[n] *= decay * Math.exp(-tilt * n);
          }
          // Bow noise follows the same fade, or a dying note turns into noise.
          noiseAmp *= decay;
          airAmp *= decay;
        }
        if (arcSamples >= swellN) arcTick = arcTick === BODY_BLOCK - 1 ? 0 : arcTick + 1;
        arcSamples++;
      }
      env = dest + (env - dest) * (dest > env ? attackCoeff : releaseCoeff);
      if (tr) {
        trEnv *= trDec;
        finger *= fingerDec;
      }
      life.step();
      if (bodyTable) {
        if (bodyTick === 0) {
          const ratio = life.ratio;
          for (let n = 0; n < N; n++) {
            let target = 1;
            if (gains[n] !== 0) {
              const db = clampDb(lookupBody(bodyTable, freq * (n + 1) * ratio));
              target = Math.pow(10, (db - nominalDb[n]) / 20);
            }
            bodyTarget[n] = target;
            bodyInc[n] = (target - bodyNow[n]) / BODY_BLOCK;
          }
        }
        const last = bodyTick === BODY_BLOCK - 1;
        for (let n = 0; n < N; n++) bodyNow[n] = last ? bodyTarget[n] : bodyNow[n] + bodyInc[n];
        bodyTick = last ? 0 : bodyTick + 1;
      }
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
        const shaped = bodyTable ? gains[n] * bodyNow[n] : gains[n];
        sum += sine * shaped;
        if (tr) bright += sine * (bodyTable ? brightGains[n] * bodyNow[n] : brightGains[n]);
      }
      const white = rng() * 2 - 1;
      nz = white * (1 - noisePole) + nz * noisePole;
      air = white * (1 - airPole) + air * airPole;
      let src = tr ? sum + bright * trEnv : sum;
      let noise = nz * (noiseAmp + finger);
      if (p.noise.lowCut) {
        noiseHp = noise * (1 - noiseHpPole) + noiseHp * noiseHpPole;
        noise -= noiseHp;
      }
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
      const out = (src + body * bodyMix + noise + air * airAmp) * env * life.gain * p.gain;
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
