export {
  ScoreSchema,
  PointSchema,
  TrackSchema,
  NoteSchema,
  EaseSchema,
} from './schema.js';
export { getJsonSchema } from './json-schema.js';
export type { Score, Track, Point, Note, Ease } from './schema.js';
export {
  sampleAt,
  interpolateTrack,
  getTrackDuration,
  prepareTrackPoints,
  createTrackSampler,
  resolveTrack,
} from './interpolator.js';
export type { SampledPoint, ResolvedSample, TrackSampler } from './interpolator.js';
export { expandNotes } from './notes.js';
export { Voice, SimpleSynth, hueToSynthParams, hueToTimbre, midiToFrequency, hashSeed } from './synth.js';
export type { SynthParams, TimbreParams } from './synth.js';
export { lightnessToCutoff } from './timbre.js';
export { render } from './renderer.js';
export type { RenderResult } from './renderer.js';
export { writeWavFile } from './wav.js';
