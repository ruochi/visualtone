import type { TimbreVector } from './timbre.js';
import { vectorHash } from './timbre.js';

const TABLE_SIZE = 2048;
const MIP_LEVELS = 8;

export interface Wavetable {
  mips: Float32Array[];
  size: number;
}

const cache = new Map<string, Wavetable>();

function harmonicAmp(n: number, v: TimbreVector): number {
  const tilt = Math.pow(n, -Math.max(0.1, v.tilt));
  const odd = n % 2 === 1 ? 1 : -1;
  const oddEven = 1 + v.oddEven * odd * 0.5;
  const stretch = 1 + v.inharmonic * (n - 1) * 0.08;
  const freqRatio = n / stretch;
  let amp = tilt * oddEven / n;
  if (v.formantGain > 0 && v.formantFreq > 0) {
    const fNorm = (freqRatio * 110) / v.formantFreq;
    const formant = Math.exp(-((fNorm - 1) ** 2) / 0.15);
    amp += formant * v.formantGain * 0.3;
  }
  return amp;
}

function buildMip(maxHarmonic: number, v: TimbreVector): Float32Array {
  const table = new Float32Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) {
    const phase = (i / TABLE_SIZE) * 2 * Math.PI;
    let sum = 0;
    for (let n = 1; n <= maxHarmonic; n++) {
      sum += harmonicAmp(n, v) * Math.sin(phase * n);
    }
    table[i] = sum;
  }
  let peak = 0;
  for (let i = 0; i < TABLE_SIZE; i++) peak = Math.max(peak, Math.abs(table[i]));
  if (peak > 0) {
    for (let i = 0; i < TABLE_SIZE; i++) table[i] /= peak;
  }
  return table;
}

export function buildWavetable(v: TimbreVector): Wavetable {
  const key = vectorHash(v);
  const hit = cache.get(key);
  if (hit) return hit;

  const mips: Float32Array[] = [];
  for (let mip = 0; mip < MIP_LEVELS; mip++) {
    const maxHarmonic = Math.max(1, Math.floor(64 / Math.pow(2, mip)));
    mips.push(buildMip(maxHarmonic, v));
  }
  const wt: Wavetable = { mips, size: TABLE_SIZE };
  cache.set(key, wt);
  return wt;
}

export function clearWavetableCache(): void {
  cache.clear();
}

export function readWavetable(
  wt: Wavetable,
  phase: number,
  freq: number,
  sampleRate: number,
): number {
  const nyquist = sampleRate * 0.45;
  let mip = 0;
  while (freq * Math.pow(2, mip + 1) < nyquist && mip < wt.mips.length - 1) {
    mip++;
  }
  const table = wt.mips[mip];
  const p = ((phase % (2 * Math.PI)) / (2 * Math.PI)) * table.length;
  const i0 = Math.floor(p) % table.length;
  const i1 = (i0 + 1) % table.length;
  const frac = p - Math.floor(p);
  return table[i0] * (1 - frac) + table[i1] * frac;
}
