import type { AnalysisReport } from './types.js';

export interface Profile {
  name: string;
  /** Where the numbers come from. Built-ins are mixing experience, not a standard. */
  note: string;
  lufs: [number, number];
  /** Peak-to-loudness ratio, dB. Club masters sit lower (denser) than this project's default. */
  plr: [number, number];
  /** Energy share per band, 0–1. */
  bands: Record<string, [number, number]>;
  lowCorrelationMin: number;
  /** |L/R energy ratio| below 120 Hz, dB. */
  lowBalanceMaxDb: number;
  sideMidDb: [number, number];
  contrastMinDb: number;
  maskOverlapMax: number;
  /** A family of tracks (pad-1 + pad-2 + …) above this share is too loud. */
  trackShareMax: number;
}

const EXPERIENCE = '通用混音经验值，不是测量标准';

export const PROFILES: Record<string, Profile> = {
  'deep-house': {
    name: 'deep-house',
    note: EXPERIENCE,
    lufs: [-14, -7],
    plr: [5, 9],
    bands: {
      sub: [0.06, 0.22],
      bass: [0.2, 0.48],
      mid: [0.25, 0.5],
      presence: [0.035, 0.14],
      air: [0.008, 0.06],
    },
    lowCorrelationMin: 0.85,
    lowBalanceMaxDb: 2,
    sideMidDb: [-16, -4],
    contrastMinDb: 2.5,
    maskOverlapMax: 0.45,
    trackShareMax: 0.3,
  },
  techno: {
    name: 'techno',
    note: EXPERIENCE,
    lufs: [-10, -5],
    plr: [4, 8],
    bands: {
      sub: [0.1, 0.3],
      bass: [0.22, 0.5],
      mid: [0.15, 0.4],
      presence: [0.03, 0.12],
      air: [0.004, 0.04],
    },
    lowCorrelationMin: 0.9,
    lowBalanceMaxDb: 1.5,
    sideMidDb: [-18, -8],
    contrastMinDb: 1.5,
    maskOverlapMax: 0.45,
    trackShareMax: 0.45,
  },
  'pop-edm': {
    name: 'pop-edm',
    note: EXPERIENCE,
    lufs: [-12, -6],
    plr: [6, 10],
    bands: {
      sub: [0.04, 0.16],
      bass: [0.16, 0.4],
      mid: [0.28, 0.55],
      presence: [0.05, 0.16],
      air: [0.01, 0.07],
    },
    lowCorrelationMin: 0.8,
    lowBalanceMaxDb: 2,
    sideMidDb: [-12, -3],
    contrastMinDb: 3,
    maskOverlapMax: 0.4,
    trackShareMax: 0.35,
  },
  ambient: {
    name: 'ambient',
    note: EXPERIENCE,
    lufs: [-24, -12],
    plr: [10, 20],
    bands: {
      sub: [0.02, 0.16],
      bass: [0.08, 0.35],
      mid: [0.3, 0.65],
      presence: [0.03, 0.16],
      air: [0.015, 0.12],
    },
    lowCorrelationMin: 0.3,
    lowBalanceMaxDb: 4,
    sideMidDb: [-10, -1],
    contrastMinDb: 0.4,
    maskOverlapMax: 0.6,
    trackShareMax: 0.55,
  },
};

export function getProfile(name: string): Profile | undefined {
  return PROFILES[name];
}

function padRange(values: number[], absPad: number, relPad = 0.1): [number, number] {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = Math.max(hi - lo, absPad);
  return [lo - span * relPad, hi + span * relPad];
}

/** Build a profile from one or more already-analyzed reference mixes. */
export function profileFromReports(name: string, reports: AnalysisReport[]): Profile {
  if (reports.length === 0) throw new Error('profile needs at least one report');
  const lufs = reports.map((r) => r.loudness.integratedLufs);
  const plr = reports.map((r) => r.loudness.plr);
  const bands: Record<string, [number, number]> = {};
  for (const band of reports[0].bands) {
    bands[band.name] = padRange(
      reports.map((r) => r.bands.find((b) => b.name === band.name)?.share ?? 0),
      0.03,
    );
  }
  return {
    name,
    note: '由参考曲提取的统计范围',
    lufs: padRange(lufs, 2, 0),
    plr: padRange(plr, 1.5, 0),
    bands,
    lowCorrelationMin: Math.min(...reports.map((r) => r.stereo.lowCorrelation)) - 0.05,
    lowBalanceMaxDb: Math.max(...reports.map((r) => Math.abs(r.stereo.lowBalanceDb))) + 1,
    sideMidDb: padRange(
      reports.map((r) => r.stereo.sideMidDb),
      2,
      0,
    ),
    contrastMinDb: Math.max(0, Math.min(...reports.map((r) => r.structure.contrastDb)) - 0.5),
    maskOverlapMax: 0.5,
    trackShareMax: 0.45,
  };
}
