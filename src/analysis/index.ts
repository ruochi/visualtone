import type { Score } from '../schema.js';
import { buildFindings } from './findings.js';
import { analyzeHarmony } from './harmony.js';
import { measureLoudness } from './loudness.js';
import { analyzeMasking, type MaskingReport } from './masking.js';
import { getProfile, type Profile } from './profiles.js';
import { analyzeRhythm } from './rhythm.js';
import { analyzeStereo } from './stereo.js';
import { BANDS, mixdown, spectrogram, type Spectrogram } from './stft.js';
import { analyzeSpace, bandShare } from './space.js';
import { analyzeStructure } from './structure.js';
import type { AnalysisReport } from './types.js';
import { analyzeDynamics, repetitionScore } from './dynamics.js';
import { measureVoiceover, roleOf } from './voiceover.js';

export interface PlotData {
  specTimes: number[];
  specFreqs: number[];
  specDb: Float32Array;
  specFrames: number;
  specBins: number;
  stemIds?: string[];
  stemShares?: number[];
  stemTimes?: number[];
  stemFreqs?: number[];
  stemDb?: Float32Array[];
  phase: { l: number; r: number }[];
  kickEnvelope: number[];
  kickPunch: number | null;
  shortTermTimes: number[];
  shortTermLufs: number[];
  barTimes: number[];
  barEnergyDb: number[];
  ssm: number[][];
  chroma: number[][];
  chromaTimes: number[];
  maskIds?: string[];
  maskMatrix?: number[][];
  busShares: { id: string; share: number }[];
  tailTimes: number[];
  tailRatiosDb: number[];
  hitTracks: { id: string; times: number[]; peaksDb: number[] }[];
}

export interface Analysis {
  report: AnalysisReport;
  plot: PlotData;
  spec: Spectrogram;
  masking?: MaskingReport;
}

export interface AnalyzeInput {
  buffers: Float32Array[];
  sampleRate: number;
  stems?: { id: string; l: Float32Array; r: Float32Array }[];
  score?: Score;
  profile?: Profile | string;
  inputs?: AnalysisReport['inputs'];
}

export function analyze(input: AnalyzeInput): Analysis {
  const { buffers, sampleRate } = input;
  const duration = buffers[0].length / sampleRate;
  const mono = mixdown(buffers);
  const spec = spectrogram(mono, sampleRate, 4096, 512, 64);
  const loudness = measureLoudness(buffers, sampleRate);
  const stereo = analyzeStereo(buffers, sampleRate);
  const bpm = input.score?.bpm;
  const trackStems = input.stems?.filter((s) => !s.id.startsWith('bus:'));
  let harmonySpec = spec;
  if (trackStems && trackStems.length > 1) {
    const pitched = trackStems.filter((s) => {
      const role = roleOf(input.score, s.id);
      if (role === 'voice' || role === 'sfx') return false;
      return !/kick|hat|clap|shaker|riser|ride/i.test(s.id);
    });
    if (pitched.length > 0 && pitched.length < trackStems.length) {
      const buf = new Float32Array(pitched[0].l.length);
      for (const stem of pitched) {
        for (let i = 0; i < buf.length; i++) buf[i] += (stem.l[i] + stem.r[i]) * 0.5;
      }
      harmonySpec = spectrogram(buf, sampleRate, 4096, 2048, 48);
    }
  }
  const harmony = analyzeHarmony(harmonySpec);
  const structure = analyzeStructure(mono, spec, sampleRate, duration, bpm);
  const rhythm = analyzeRhythm(mono, sampleRate, spec, bpm, trackStems);
  const masking = trackStems && trackStems.length > 0 ? analyzeMasking(trackStems, sampleRate) : undefined;
  const space = analyzeSpace(mono, sampleRate, rhythm.onsetTimes, input.stems);
  const dynamics = analyzeDynamics(trackStems, sampleRate);
  const warmth = bandShare(mono, sampleRate, 150, 500);

  const bandTotal = spec.bandPower.reduce((s, v) => s + v, 0) || 1;
  const bands = BANDS.map((b, i) => ({ name: b.name, share: spec.bandPower[i] / bandTotal }));

  const profile = typeof input.profile === 'string' ? getProfile(input.profile) : input.profile;
  if (typeof input.profile === 'string' && !profile) {
    throw new Error(`Unknown profile "${input.profile}". Use deep-house, techno, pop-edm, ambient, or voiceover-bed.`);
  }

  const report: AnalysisReport = {
    duration,
    sampleRate,
    channels: buffers.length,
    loudness: {
      integratedLufs: loudness.integratedLufs,
      rangeLufs: loudness.rangeLufs,
      truePeakDbtp: loudness.truePeakDbtp,
      samplePeak: loudness.samplePeak,
      plr: loudness.plr,
    },
    bands: bands.map((b) => ({
      ...b,
      target: profile?.bands[b.name],
    })),
    stereo: {
      correlation: stereo.correlation,
      sideMidDb: stereo.sideMidDb,
      lowBalanceDb: stereo.lowBalanceDb,
      lowCorrelation: stereo.lowCorrelation,
      midCorrelation: stereo.midCorrelation,
      highCorrelation: stereo.highCorrelation,
      balanceDb: stereo.balanceDb,
      bandSideMidDb: stereo.bandSideMidDb,
    },
    warmth,
    space: {
      wetShare: space.wetShare,
      busShares: space.busShares,
      tailRatioDb: space.tailRatioDb,
    },
    dynamics: {
      hitVariationDb: dynamics.hitVariationDb,
      repetition: repetitionScore(structure.ssm),
      tracks: dynamics.tracks.map((t) => ({ id: t.id, variationDb: t.variationDb })),
    },
    rhythm: {
      tempo: rhythm.tempo,
      swing: rhythm.swing,
      onsetCount: rhythm.onsetCount,
      kickPunch: rhythm.kickPunch,
      kickEnvelope: rhythm.kickEnvelope,
      sidechainDb: rhythm.sidechainDb,
    },
    harmony,
    structure: {
      windowSec: structure.windowSec,
      times: structure.times,
      energyDb: structure.energyDb,
      contrastDb: structure.contrastDb,
      novelty: structure.novelty,
    },
    masking: masking
      ? {
          trackIds: masking.trackIds,
          shares: masking.shares,
          overlap: masking.overlap,
          pairs: masking.pairs,
          lowBalanceDb: masking.lowBalanceDb,
          lowEnergy: masking.lowEnergy,
        }
      : undefined,
    profile: profile ? { name: profile.name, note: profile.note } : undefined,
    inputs: input.inputs,
    voiceover:
      measureVoiceover({
        stems: trackStems,
        sampleRate,
        duration,
        score: input.score,
        masking,
      }) ??
      (profile?.voiceover
        ? { presenceGapDb: null, sfxOverlap: null, sfxPer10s: null, sfxMinGapSec: null }
        : undefined),
    findings: [],
  };
  report.findings = buildFindings(report, profile, input.score);

  const chroma: number[][] = [];
  for (let f = 0; f < spec.frames; f++) {
    const row: number[] = [];
    let s = 0;
    for (let pc = 0; pc < 12; pc++) {
      row.push(spec.chroma[f * 12 + pc]);
      s += spec.chroma[f * 12 + pc];
    }
    chroma.push(s > 0 ? row.map((v) => v / s) : row);
  }

  const plot: PlotData = {
    specTimes: spec.times,
    specFreqs: spec.freqs,
    specDb: spec.db,
    specFrames: spec.frames,
    specBins: spec.bins,
    stemIds: masking?.trackIds,
    stemShares: masking?.shares,
    stemTimes: masking?.spec.times,
    stemFreqs: masking?.spec.freqs,
    stemDb: masking?.spec.db,
    phase: stereo.phase,
    kickEnvelope: rhythm.kickEnvelope,
    kickPunch: rhythm.kickPunch,
    shortTermTimes: loudness.shortTermTimes,
    shortTermLufs: loudness.shortTermLufs,
    barTimes: structure.times,
    barEnergyDb: structure.energyDb,
    ssm: structure.ssm,
    chroma,
    chromaTimes: spec.times,
    maskIds: masking?.trackIds,
    maskMatrix: masking?.overlap,
    busShares: space.busShares,
    tailTimes: space.tailTimes,
    tailRatiosDb: space.tailRatiosDb,
    hitTracks: dynamics.tracks.map((t) => ({ id: t.id, times: t.times, peaksDb: t.peaksDb })),
  };

  return { report, plot, spec, masking };
}

export function reportToJson(report: AnalysisReport): string {
  return JSON.stringify(report, null, 2);
}
