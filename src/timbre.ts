/** Hue anchor timbre parameters (blended on a ring). */

export interface TimbreParams {
  sine: number;
  saw: number;
  square: number;
  detuneCents: number;
  noise: number;
  inharmonic: number;
  attackMs: number;
  filterEnvAmount: number;
  decayMs: number;
  pitchDropSemitones: number;
  pitchDropMs: number;
}

interface Anchor extends TimbreParams {
  hue: number;
}

const ANCHORS: Anchor[] = [
  {
    hue: 0,
    sine: 0.7,
    saw: 0.1,
    square: 0,
    detuneCents: 0,
    noise: 0.55,
    inharmonic: 0.1,
    attackMs: 1,
    filterEnvAmount: 0.2,
    decayMs: 80,
    pitchDropSemitones: 4,
    pitchDropMs: 45,
  },
  {
    hue: 40,
    sine: 0.2,
    saw: 0.65,
    square: 0.1,
    detuneCents: 4,
    noise: 0.08,
    inharmonic: 0.05,
    attackMs: 3,
    filterEnvAmount: 0.85,
    decayMs: 120,
    pitchDropSemitones: 0,
    pitchDropMs: 0,
  },
  {
    hue: 90,
    sine: 0.5,
    saw: 0.15,
    square: 0.1,
    detuneCents: 0,
    noise: 0.05,
    inharmonic: 0.45,
    attackMs: 2,
    filterEnvAmount: 0.5,
    decayMs: 200,
    pitchDropSemitones: 0,
    pitchDropMs: 0,
  },
  {
    hue: 150,
    sine: 0.15,
    saw: 0.25,
    square: 0.55,
    detuneCents: 6,
    noise: 0.04,
    inharmonic: 0.05,
    attackMs: 8,
    filterEnvAmount: 0.35,
    decayMs: 150,
    pitchDropSemitones: 0,
    pitchDropMs: 0,
  },
  {
    hue: 210,
    sine: 0.1,
    saw: 0.7,
    square: 0.05,
    detuneCents: 12,
    noise: 0.02,
    inharmonic: 0.02,
    attackMs: 25,
    filterEnvAmount: 0.15,
    decayMs: 300,
    pitchDropSemitones: 0,
    pitchDropMs: 0,
  },
  {
    hue: 270,
    sine: 0.35,
    saw: 0.2,
    square: 0.05,
    detuneCents: 8,
    noise: 0.18,
    inharmonic: 0.15,
    attackMs: 15,
    filterEnvAmount: 0.4,
    decayMs: 180,
    pitchDropSemitones: 0,
    pitchDropMs: 0,
  },
  {
    hue: 320,
    sine: 0.05,
    saw: 0.1,
    square: 0.05,
    detuneCents: 0,
    noise: 0.85,
    inharmonic: 0.2,
    attackMs: 1,
    filterEnvAmount: 0.6,
    decayMs: 40,
    pitchDropSemitones: 0,
    pitchDropMs: 0,
  },
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function blendAnchor(a: Anchor, b: Anchor, t: number): TimbreParams {
  return {
    sine: lerp(a.sine, b.sine, t),
    saw: lerp(a.saw, b.saw, t),
    square: lerp(a.square, b.square, t),
    detuneCents: lerp(a.detuneCents, b.detuneCents, t),
    noise: lerp(a.noise, b.noise, t),
    inharmonic: lerp(a.inharmonic, b.inharmonic, t),
    attackMs: lerp(a.attackMs, b.attackMs, t),
    filterEnvAmount: lerp(a.filterEnvAmount, b.filterEnvAmount, t),
    decayMs: lerp(a.decayMs, b.decayMs, t),
    pitchDropSemitones: lerp(a.pitchDropSemitones, b.pitchDropSemitones, t),
    pitchDropMs: lerp(a.pitchDropMs, b.pitchDropMs, t),
  };
}

export function hueToTimbre(hue: number): TimbreParams {
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
      return blendAnchor(a, b, t);
    }
  }
  return { ...sorted[0] };
}

/** Map lightness 0-1 to effective range and cutoff multiplier. */
export function lightnessToCutoff(lightness: number, baseFreq: number): number {
  const L = 0.2 + 0.6 * Math.max(0, Math.min(1, lightness));
  const minCut = baseFreq * 0.5;
  const maxCut = Math.min(12000, baseFreq * 8);
  return minCut + (maxCut - minCut) * L;
}

export function hashSeed(scoreSeed: number | undefined, trackIndex: number): number {
  let h = (scoreSeed ?? 0) ^ (trackIndex * 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
