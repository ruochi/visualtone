import type { Spectrogram } from './stft.js';

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export interface HarmonyReport {
  key: string | null;
  mode: 'major' | 'minor' | null;
  /** Pearson correlation of the winning template. */
  correlation: number;
  /** Mean pitch class, length 12, starting at C. */
  chroma: number[];
}

function rotate(profile: number[], tonic: number): number[] {
  const out = new Array(12);
  for (let i = 0; i < 12; i++) out[i] = profile[(i - tonic + 12) % 12];
  return out;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const d = Math.sqrt(da * db);
  return d > 0 ? num / d : 0;
}

export function analyzeHarmony(spec: Spectrogram): HarmonyReport {
  const chroma = new Array(12).fill(0);
  for (let f = 0; f < spec.frames; f++) {
    for (let pc = 0; pc < 12; pc++) chroma[pc] += spec.chroma[f * 12 + pc];
  }
  const total = chroma.reduce((s: number, v: number) => s + v, 0);
  if (total <= 0) {
    return { key: null, mode: null, correlation: 0, chroma };
  }

  const bassSum = spec.bassChroma.reduce((s, v) => s + v, 0) || 1;
  const bass = spec.bassChroma.map((v) => v / bassSum);
  const earlySum = spec.earlyBassChroma.reduce((s, v) => s + v, 0) || 1;
  const early = spec.earlyBassChroma.map((v) => v / earlySum);

  let best = -Infinity;
  let bestName: string | null = null;
  let bestMode: 'major' | 'minor' | null = null;
  for (const [mode, profile] of [
    ['major', MAJOR],
    ['minor', MINOR],
  ] as const) {
    for (let tonic = 0; tonic < 12; tonic++) {
      // Bass-note salience breaks the relative major/minor tie.
      // Whole-bass salience plus the opening bass note, which is the home chord of a loop.
      const score = pearson(chroma, rotate(profile, tonic)) + 0.35 * bass[tonic] + 1.0 * early[tonic];
      if (score > best) {
        best = score;
        bestName = `${NAMES[tonic]} ${mode}`;
        bestMode = mode;
      }
    }
  }
  const corr = bestName
    ? pearson(
        chroma,
        rotate(bestMode === 'major' ? MAJOR : MINOR, NAMES.indexOf(bestName.split(' ')[0])),
      )
    : 0;
  const norm = chroma.map((v: number) => v / total);
  return { key: bestName, mode: bestMode, correlation: corr, chroma: norm };
}
