export interface Finding {
  id: string;
  severity: 'high' | 'medium' | 'low';
  metric: string;
  value: number;
  /** Human-readable target, e.g. "-14..-7" or "< 2". */
  target: string;
  message: string;
  suggestion: string;
}

export interface AnalysisReport {
  duration: number;
  sampleRate: number;
  channels: number;
  loudness: {
    integratedLufs: number;
    rangeLufs: number;
    truePeakDbtp: number;
    samplePeak: number;
    plr: number;
  };
  bands: { name: string; share: number; target?: [number, number] }[];
  stereo: {
    correlation: number;
    sideMidDb: number;
    lowBalanceDb: number;
    lowCorrelation: number;
    midCorrelation: number;
    highCorrelation: number;
    balanceDb: number;
  };
  rhythm: {
    tempo: number | null;
    swing: number | null;
    onsetCount: number;
    kickPunch: number | null;
    kickEnvelope: number[];
    sidechainDb: number | null;
  };
  harmony: {
    key: string | null;
    mode: 'major' | 'minor' | null;
    correlation: number;
    chroma: number[];
  };
  structure: {
    windowSec: number;
    times: number[];
    energyDb: number[];
    contrastDb: number;
    novelty: number[];
  };
  masking?: {
    trackIds: string[];
    shares: number[];
    overlap: number[][];
    pairs: { a: string; b: string; overlap: number; cover: number; bandLo: number; bandHi: number }[];
    lowBalanceDb: number[];
    lowEnergy: number[];
  };
  profile?: { name: string; note: string };
  findings: Finding[];
}
