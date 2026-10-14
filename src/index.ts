export * from './schema.js';
export * from './dsp.js';
export { compile, type CompiledNote, type CompiledScore, type CompiledSfx, type CompiledTrack, type Issue, type IssueCode } from './compile.js';
export {
  DRUM_NAMES,
  INSTRUMENT_NAMES,
  INSTRUMENTS,
  type DrumName,
  type InstrumentInfo,
  type SynthPreset,
} from './instruments.js';
export { SFX_ANCHOR, SFX_DURATION, SFX_NAMES, type SfxName } from './sfx.js';
export { delay, limit, reverb } from './effects.js';
export { encodeWav, decodeWav, type DecodedWav } from './wav.js';
export { toMidi, midiToName, parseKey, parseChord, voiceChord } from './theory.js';
export {
  render,
  liteInstrument,
  baseDirOf,
  type Instrument,
  type InstrumentResolver,
  type NoteContext,
  type RenderOptions,
  type RenderResult,
  type ClipBuffer,
  type Stereo,
} from './render.js';

import { render, type RenderOptions } from './render.js';
import { parseScore } from './schema.js';
import { encodeWav } from './wav.js';

/** Validate a score object and render it to a WAV buffer. */
export function renderToWav(input: unknown, opts?: RenderOptions): Buffer {
  const { left, right, sampleRate } = render(parseScore(input), opts);
  return encodeWav(left, right, sampleRate);
}
