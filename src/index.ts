export {
  ScoreSchema,
  PointSchema,
  TrackSchema,
  NoteSchema,
  EaseSchema,
  MasterSchema,
  EqSchema,
  CompSchema,
  LfoSchema,
  AutomationSchema,
  HumanizeSchema,
  getChannelIndices,
} from './schema.js';
export type { Score, Track, Point, Note, Ease, TimbreOverride, Lfo } from './schema.js';
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
  lookaheadLimit,
} from './fx.js';
export type { LimiterConfig } from './fx.js';
export { render } from './renderer.js';
export type { RenderResult, RenderOptions } from './renderer.js';
export { writeWavFile } from './wav.js';
export type { BitDepth, WavOptions } from './wav.js';
export { Biquad, StereoEq, Compressor, lfoValue, keyframeAt } from './mix.js';
export type { EqConfig, CompConfig, LfoShape } from './mix.js';
export { swingTime, applyGroove } from './groove.js';
export { readWavFile } from './wav.js';
export type { DecodedWav } from './wav.js';
export { analyze, reportToJson } from './analysis/index.js';
export type { Analysis, AnalyzeInput, PlotData } from './analysis/index.js';
export type { AnalysisReport, Finding } from './analysis/types.js';
export { PROFILES, getProfile, profileFromReports } from './analysis/profiles.js';
export type { Profile } from './analysis/profiles.js';
export { diffFindings } from './analysis/findings.js';
export { renderReport } from './report/panels.js';
export { encodePng } from './report/png.js';
