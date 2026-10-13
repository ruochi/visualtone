/** Built-in sound effects, rendered as mono buffers starting at the trigger time. */
import { Svf } from './dsp.js';
import type { SfxEvent } from './schema.js';

export const SFX_DURATION: Record<SfxEvent['sfx'], number> = {
  whoosh: 0.8,
  riser: 2,
  impact: 1.2,
  pop: 0.08,
  tick: 0.03,
};

export function renderSfx(e: SfxEvent, sampleRate: number, rand: () => number): Float32Array {
  const dur = e.duration ?? SFX_DURATION[e.sfx];
  const len = Math.ceil(dur * sampleRate);
  const out = new Float32Array(len);
  const f = new Svf(sampleRate);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    const x = t / dur;
    const noise = rand() * 2 - 1;
    let y = 0;
    switch (e.sfx) {
      case 'whoosh': {
        // Band-passed noise sweeping up then down, swelling to the middle.
        const cutoff = 300 + 3000 * Math.sin(Math.PI * x);
        y = f.process(noise, cutoff, 2)[1] * Math.pow(Math.sin(Math.PI * x), 2) * 1.5;
        break;
      }
      case 'riser': {
        const hz = 200 * Math.pow(8, x);
        phase += hz / sampleRate;
        const tone = 2 * (phase % 1) - 1;
        y = (tone * 0.4 + f.process(noise, 500 + 8000 * x, 1)[1] * 0.6) * x * x;
        break;
      }
      case 'impact': {
        phase += (40 + 80 * Math.exp(-t / 0.08)) / sampleRate;
        const boom = Math.sin(2 * Math.PI * phase) * Math.exp(-t / 0.35);
        y = Math.tanh(boom * 1.5 + noise * Math.exp(-t / 0.02));
        break;
      }
      case 'pop': {
        phase += (900 * Math.exp(-t / 0.02) + 200) / sampleRate;
        y = Math.sin(2 * Math.PI * phase) * Math.exp(-t / 0.015);
        break;
      }
      case 'tick':
        y = f.process(noise, 4000, 3)[1] * Math.exp(-t / 0.004) * 2;
        break;
    }
    out[i] = y * e.size;
  }
  return out;
}
