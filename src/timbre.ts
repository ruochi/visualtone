/** Internal timbre vector (~18 params) + hue macro mapping. */

export interface TimbreVector {
  tilt: number;
  oddEven: number;
  inharmonic: number;
  formantFreq: number;
  formantGain: number;
  unison: number;
  detuneCents: number;
  spread: number;
  noise: number;
  noiseColor: number;
  transient: number;
  attackMs: number;
  resonance: number;
  filterEnv: number;
  filterDecayMs: number;
  pitchEnvSemis: number;
  pitchEnvMs: number;
  drive: number;
}

export type TimbreOverride = Partial<TimbreVector>;

interface Anchor extends TimbreVector {
  hue: number;
}

const ANCHORS: Anchor[] = [
  {
    hue: 0,
    tilt: 2.5,
    oddEven: 0.8,
    inharmonic: 0.05,
    formantFreq: 120,
    formantGain: 0.1,
    unison: 1,
    detuneCents: 0,
    spread: 0,
    noise: 0.35,
    noiseColor: 0.15,
    transient: 0.9,
    attackMs: 0.5,
    resonance: 0.2,
    filterEnv: 0.15,
    filterDecayMs: 60,
    pitchEnvSemis: 30,
    pitchEnvMs: 60,
    drive: 0.45,
  },
  {
    hue: 30,
    tilt: 0.8,
    oddEven: -0.3,
    inharmonic: 0.02,
    formantFreq: 200,
    formantGain: 0.15,
    unison: 1,
    detuneCents: 5,
    spread: 0.1,
    noise: 0.06,
    noiseColor: 0.25,
    transient: 0.15,
    attackMs: 3,
    resonance: 0.55,
    filterEnv: 0.7,
    filterDecayMs: 140,
    pitchEnvSemis: 0,
    pitchEnvMs: 0,
    drive: 0.25,
  },
  {
    hue: 70,
    tilt: 0.5,
    oddEven: -0.5,
    inharmonic: 0.08,
    formantFreq: 800,
    formantGain: 0.2,
    unison: 2,
    detuneCents: 8,
    spread: 0.35,
    noise: 0.04,
    noiseColor: 0.4,
    transient: 0.35,
    attackMs: 2,
    resonance: 0.75,
    filterEnv: 0.95,
    filterDecayMs: 90,
    pitchEnvSemis: 0,
    pitchEnvMs: 0,
    drive: 0.2,
  },
  {
    hue: 110,
    tilt: 1.2,
    oddEven: 0.2,
    inharmonic: 0.55,
    formantFreq: 1200,
    formantGain: 0.55,
    unison: 2,
    detuneCents: 4,
    spread: 0.25,
    noise: 0.05,
    noiseColor: 0.5,
    transient: 0.4,
    attackMs: 2,
    resonance: 0.4,
    filterEnv: 0.5,
    filterDecayMs: 180,
    pitchEnvSemis: 0,
    pitchEnvMs: 0,
    drive: 0.15,
  },
  {
    hue: 160,
    tilt: 0.35,
    oddEven: -0.6,
    inharmonic: 0.03,
    formantFreq: 600,
    formantGain: 0.1,
    unison: 7,
    detuneCents: 18,
    spread: 0.85,
    noise: 0.02,
    noiseColor: 0.55,
    transient: 0.1,
    attackMs: 8,
    resonance: 0.35,
    filterEnv: 0.25,
    filterDecayMs: 120,
    pitchEnvSemis: 0,
    pitchEnvMs: 0,
    drive: 0.18,
  },
  {
    hue: 210,
    tilt: 1.1,
    oddEven: -0.4,
    inharmonic: 0.02,
    formantFreq: 400,
    formantGain: 0.08,
    unison: 5,
    detuneCents: 14,
    spread: 0.95,
    noise: 0.03,
    noiseColor: 0.35,
    transient: 0.05,
    attackMs: 200,
    resonance: 0.25,
    filterEnv: 0.12,
    filterDecayMs: 400,
    pitchEnvSemis: 0,
    pitchEnvMs: 0,
    drive: 0.1,
  },
  {
    hue: 260,
    tilt: 1.4,
    oddEven: 0.1,
    inharmonic: 0.2,
    formantFreq: 900,
    formantGain: 0.75,
    unison: 3,
    detuneCents: 10,
    spread: 0.5,
    noise: 0.22,
    noiseColor: 0.45,
    transient: 0.12,
    attackMs: 25,
    resonance: 0.45,
    filterEnv: 0.3,
    filterDecayMs: 200,
    pitchEnvSemis: 0,
    pitchEnvMs: 0,
    drive: 0.12,
  },
  {
    hue: 300,
    tilt: 0.9,
    oddEven: 0,
    inharmonic: 0.12,
    formantFreq: 1800,
    formantGain: 0.35,
    unison: 2,
    detuneCents: 6,
    spread: 0.4,
    noise: 0.55,
    noiseColor: 0.55,
    transient: 0.85,
    attackMs: 1,
    resonance: 0.5,
    filterEnv: 0.6,
    filterDecayMs: 70,
    pitchEnvSemis: 2,
    pitchEnvMs: 25,
    drive: 0.3,
  },
  {
    hue: 335,
    tilt: 2,
    oddEven: 0.3,
    inharmonic: 0.35,
    formantFreq: 6000,
    formantGain: 0.2,
    unison: 1,
    detuneCents: 0,
    spread: 0.6,
    noise: 0.92,
    noiseColor: 0.92,
    transient: 0.5,
    attackMs: 0.5,
    resonance: 0.15,
    filterEnv: 0.2,
    filterDecayMs: 35,
    pitchEnvSemis: 0,
    pitchEnvMs: 0,
    drive: 0.15,
  },
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function blendVector(a: TimbreVector, b: TimbreVector, t: number): TimbreVector {
  const u = Math.round(lerp(a.unison, b.unison, t));
  return {
    tilt: lerp(a.tilt, b.tilt, t),
    oddEven: lerp(a.oddEven, b.oddEven, t),
    inharmonic: lerp(a.inharmonic, b.inharmonic, t),
    formantFreq: lerp(a.formantFreq, b.formantFreq, t),
    formantGain: lerp(a.formantGain, b.formantGain, t),
    unison: Math.max(1, Math.min(7, u)),
    detuneCents: lerp(a.detuneCents, b.detuneCents, t),
    spread: lerp(a.spread, b.spread, t),
    noise: lerp(a.noise, b.noise, t),
    noiseColor: lerp(a.noiseColor, b.noiseColor, t),
    transient: lerp(a.transient, b.transient, t),
    attackMs: lerp(a.attackMs, b.attackMs, t),
    resonance: lerp(a.resonance, b.resonance, t),
    filterEnv: lerp(a.filterEnv, b.filterEnv, t),
    filterDecayMs: lerp(a.filterDecayMs, b.filterDecayMs, t),
    pitchEnvSemis: lerp(a.pitchEnvSemis, b.pitchEnvSemis, t),
    pitchEnvMs: lerp(a.pitchEnvMs, b.pitchEnvMs, t),
    drive: lerp(a.drive, b.drive, t),
  };
}

export function hueToTimbreVector(hue: number): TimbreVector {
  const h = ((hue % 360) + 360) % 360;
  const sorted = [...ANCHORS].sort((a, b) => a.hue - b.hue);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[(i + 1) % sorted.length];
    let h1 = a.hue;
    let h2 = b.hue;
    if (h2 < h1) h2 += 360;
    let hh = h;
    if (hh < h1) hh += 360;
    if (hh >= h1 && hh <= h2) {
      const t = h2 === h1 ? 0 : (hh - h1) / (h2 - h1);
      return blendVector(a, b, t);
    }
  }
  return { ...sorted[0] };
}

/** @deprecated alias */
export const hueToTimbre = hueToTimbreVector;
export type TimbreParams = TimbreVector;

export function applyMacros(
  base: TimbreVector,
  lightness: number,
  saturation = 1,
  override?: TimbreOverride,
): TimbreVector {
  const L = 0.2 + 0.6 * Math.max(0, Math.min(1, lightness));
  const sat = Math.max(0, Math.min(1, saturation));
  const v: TimbreVector = {
    ...base,
    tilt: base.tilt * (0.6 + 0.8 * L),
    noise: base.noise * (1.4 - sat * 0.9),
    resonance: base.resonance * (0.7 + 0.5 * L),
  };
  if (override) {
    Object.assign(v, override);
  }
  v.unison = Math.max(1, Math.min(7, Math.round(v.unison)));
  return v;
}

/**
 * Lowpass cutoff as a multiple of the fundamental: 1.5x at lightness 0, ~8.5x at 0.5,
 * 48x at 1, capped at 18 kHz. Exponential so each step of lightness opens the same
 * number of harmonics, and bright settings actually reach the presence band.
 */
export function lightnessToCutoff(lightness: number, baseFreq: number): number {
  const L = Math.max(0, Math.min(1, lightness));
  return Math.min(18000, baseFreq * 1.5 * Math.pow(32, L));
}

export function hashSeed(scoreSeed: number | undefined, trackIndex: number): number {
  let h = (scoreSeed ?? 0) ^ (trackIndex * 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function vectorHash(v: TimbreVector): string {
  const keys = Object.keys(v) as (keyof TimbreVector)[];
  return keys.map((k) => `${k}:${(v[k] as number).toFixed(4)}`).join('|');
}
