export {
  ScoreSchema,
  PointSchema,
  TrackSchema,
  NoteSchema,
  EaseSchema,
  MasterSchema,
  getChannelIndices,
} from './schema.js';
export type { Score, Track, Point, Note, Ease, TimbreOverride } from './schema.js';
export { getJsonSchema } from './json-schema.js';
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
export { resolveScore } from './resolve.js';
export type { ResolvedTrackCurve } from './resolve.js';
export {
  Voice,
  SimpleSynth,
  hueToSynthParams,
  hueToTimbre,
  hueToTimbreVector,
  midiToFrequency,
  hashSeed,
  applyMacros,
} from './synth.js';
export type { SynthParams, TimbreVector, TimbreParams, TimbreOverride as VoiceTimbreOverride } from './synth.js';
export { buildWavetable, clearWavetableCache } from './wavetable.js';
export { lightnessToCutoff } from './timbre.js';
export {
  spectralCentroid,
  stereoCorrelation,
  measureRmsDb,
} from './fx.js';
export { render } from './renderer.js';
export type { RenderResult } from './renderer.js';
export { writeWavFile } from './wav.js';
