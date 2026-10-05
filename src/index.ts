export { ScoreSchema, PointSchema, TrackSchema, getJsonSchema } from './schema.js';
export type { Score, Track, Point } from './schema.js';
export { interpolateTrack, getTrackDuration } from './interpolator.js';
export type { SampledPoint } from './interpolator.js';
export { SimpleSynth, hueToSynthParams, midiToFrequency } from './synth.js';
export type { SynthParams } from './synth.js';
export { render } from './renderer.js';
export type { RenderResult } from './renderer.js';
export { writeWavFile } from './wav.js';
