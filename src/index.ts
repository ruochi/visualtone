export * from './schema.js';
export * from './dsp.js';
export { INSTRUMENTS, type Preset, type SynthPreset } from './instruments.js';
export { SFX_DURATION } from './sfx.js';
export { reverb, delay, limit } from './effects.js';
export { encodeWav, decodeWav, type DecodedWav } from './wav.js';
export {
  render,
  liteInstrument,
  baseDirOf,
  type Instrument,
  type InstrumentResolver,
  type NoteContext,
  type RenderOptions,
  type RenderResult,
  type Stereo,
} from './render.js';

import { render, type RenderOptions } from './render.js';
import { parseScore } from './schema.js';
import { encodeWav } from './wav.js';

/** Validate a score object and render it to a WAV file buffer. */
export function renderToWav(input: unknown, opts?: RenderOptions): Buffer {
  const { left, right, sampleRate } = render(parseScore(input), opts);
  return encodeWav(left, right, sampleRate);
}
