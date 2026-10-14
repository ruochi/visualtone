/**
 * Built-in sound effects. `at` in the score is an anchor, not always the start:
 * a whoosh's anchor is its peak, a riser's anchor is the moment it arrives.
 */
import { Svf, midiToHz } from './dsp.js';

export const SFX_NAMES = [
  'whoosh', 'riser', 'downlifter', 'swell', 'impact', 'boom', 'hit',
  'pop', 'click', 'tick', 'type', 'glitch', 'shimmer', 'chime',
] as const;
export type SfxName = (typeof SFX_NAMES)[number];

export const SFX_DURATION: Record<SfxName, number> = {
  whoosh: 0.8,
  riser: 2,
  downlifter: 1.6,
  swell: 1.4,
  impact: 1.1,
  boom: 1.6,
  hit: 0.22,
  pop: 0.08,
  click: 0.025,
  tick: 0.03,
  type: 0.05,
  glitch: 0.35,
  shimmer: 1.3,
  chime: 1.1,
};

/**
 * Where the anchor sits inside the buffer, 0 = first sample, 1 = last.
 * Placement is `start = at - anchor * duration`.
 */
export const SFX_ANCHOR: Record<SfxName, number> = {
  whoosh: 0.5,
  riser: 1,
  downlifter: 0,
  swell: 0.92,
  impact: 0,
  boom: 0,
  hit: 0,
  pop: 0,
  click: 0,
  tick: 0,
  type: 0,
  glitch: 0,
  shimmer: 0,
  chime: 0,
};

export interface SfxRender {
  type: SfxName;
  duration: number;
  size: number;
  /** Semitone offset, already including the per-hit variation. */
  pitch: number;
  brightness: number;
  direction?: 'in' | 'out';
}

export function renderSfx(e: SfxRender, sampleRate: number, rand: () => number): Float32Array {
  const dur = e.duration;
  const len = Math.max(1, Math.ceil(dur * sampleRate));
  const out = new Float32Array(len);
  const f = new Svf(sampleRate);
  const rate = Math.pow(2, e.pitch / 12);
  const bright = Math.pow(2, (e.brightness - 0.5) * 4);
  let phase = 0;
  let phase2 = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    const x = t / dur;
    const noise = rand() * 2 - 1;
    let y = 0;
    switch (e.type) {
      case 'whoosh': {
        // Peak in the middle. `in` sweeps up into that peak; `out` sweeps away.
        const env = Math.pow(Math.sin(Math.PI * x), 2);
        const sweep = e.direction === 'out' ? 1 - x : x;
        const cutoff = (250 + 4500 * Math.pow(sweep, 1.3)) * rate * bright;
        y = f.process(noise, cutoff, 2.2)[1] * env * 1.6;
        break;
      }
      case 'riser': {
        const hz = 180 * rate * Math.pow(8, x);
        phase += hz / sampleRate;
        const tone = 2 * (phase % 1) - 1;
        y = (tone * 0.35 + f.process(noise, (400 + 7000 * x) * bright, 1.1)[1] * 0.65) * x * x;
        break;
      }
      case 'downlifter': {
        const hz = 1400 * rate * Math.pow(0.15, x);
        phase += hz / sampleRate;
        const tone = 2 * (phase % 1) - 1;
        y = (tone * 0.3 + f.process(noise, (5000 * (1 - x) + 300) * bright, 1)[1] * 0.7) * (1 - x) * (1 - x);
        break;
      }
      case 'swell': {
        // Reverse cymbal: a long rise and a short ring after the peak.
        const peak = SFX_ANCHOR.swell;
        const env = x < peak ? Math.pow(x / peak, 2) : Math.exp(-(x - peak) / 0.08);
        y = f.process(noise, (1000 + 6000 * x) * rate * bright, 1.3)[1] * env * 1.8;
        break;
      }
      case 'impact': {
        phase += (50 * rate + 90 * Math.exp(-t / 0.07)) / sampleRate;
        y = Math.tanh(Math.sin(2 * Math.PI * phase) * 1.6 + noise * Math.exp(-t / 0.02));
        y *= Math.exp(-t / 0.4);
        break;
      }
      case 'boom': {
        phase += (38 * rate + 30 * Math.exp(-t / 0.12)) / sampleRate;
        y = Math.tanh(Math.sin(2 * Math.PI * phase) * 1.8) * Math.exp(-t / 0.55);
        y += noise * Math.exp(-t / 0.015) * 0.3;
        break;
      }
      case 'hit': {
        phase += (220 * rate * Math.exp(-t / 0.04) + 90) / sampleRate;
        y = Math.sin(2 * Math.PI * phase) * Math.exp(-t / 0.05) + f.process(noise, 1800 * bright, 1.2)[1] * Math.exp(-t / 0.03);
        break;
      }
      case 'pop': {
        phase += (700 * rate * Math.exp(-t / 0.018) + 180) / sampleRate;
        y = Math.sin(2 * Math.PI * phase) * Math.exp(-t / 0.014);
        break;
      }
      case 'click':
        y = f.process(noise, 5000 * bright * rate, 2)[1] * Math.exp(-t / 0.003) * 1.6;
        break;
      case 'tick':
        y = f.process(noise, 3500 * bright * rate, 3)[1] * Math.exp(-t / 0.004) * 1.8;
        break;
      case 'type': {
        phase += (1800 * rate * Math.exp(-t / 0.004) + 400) / sampleRate;
        y = (Math.sin(2 * Math.PI * phase) * 0.4 + noise * 0.6) * Math.exp(-t / 0.008);
        break;
      }
      case 'glitch': {
        const slice = Math.floor(t / 0.03);
        const on = ((slice * 17 + Math.floor(e.pitch * 10)) & 3) !== 0;
        const stutter = Math.floor(t / 0.004) % 2 === 0;
        phase += (300 * rate * (1 + (slice % 5) * 0.35)) / sampleRate;
        y = on && stutter ? (noise * 0.7 + (2 * (phase % 1) - 1) * 0.3) * 0.8 : 0;
        break;
      }
      case 'shimmer': {
        const hz = midiToHz(84 + e.pitch);
        phase += hz / sampleRate;
        phase2 += (hz * 2.01) / sampleRate;
        const tone = Math.sin(2 * Math.PI * phase) * 0.4 + Math.sin(2 * Math.PI * phase2) * 0.15;
        y = (tone + f.process(noise, 9000 * bright, 0.7)[2] * 0.15) * Math.exp(-t / 0.45);
        break;
      }
      case 'chime': {
        const hz = midiToHz(76 + e.pitch);
        phase += hz / sampleRate;
        phase2 += (hz * 1.5) / sampleRate;
        y = (Math.sin(2 * Math.PI * phase) + 0.45 * Math.sin(2 * Math.PI * phase2)) * Math.exp(-t / 0.35) * 0.7;
        break;
      }
    }
    out[i] = y * e.size;
  }
  return out;
}
