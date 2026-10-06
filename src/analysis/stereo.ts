import { Biquad } from '../mix.js';

export interface StereoReport {
  correlation: number;
  sideMidDb: number;
  /** 10*log10(E_left / E_right) below 120 Hz. Positive means left is louder. */
  lowBalanceDb: number;
  lowCorrelation: number;
  midCorrelation: number;
  highCorrelation: number;
  /** Same ratio, full band. */
  balanceDb: number;
  phase: { l: number; r: number }[];
}

function energyRatioDb(l: ArrayLike<number>, r: ArrayLike<number>): number {
  let el = 0;
  let er = 0;
  const n = Math.min(l.length, r.length);
  for (let i = 0; i < n; i++) {
    el += l[i] * l[i];
    er += r[i] * r[i];
  }
  return 10 * Math.log10((el + 1e-12) / (er + 1e-12));
}

function correlation(l: ArrayLike<number>, r: ArrayLike<number>): number {
  const n = Math.min(l.length, r.length);
  let sl = 0;
  let sr = 0;
  for (let i = 0; i < n; i++) {
    sl += l[i];
    sr += r[i];
  }
  const ml = sl / Math.max(1, n);
  const mr = sr / Math.max(1, n);
  let lr = 0;
  let l2 = 0;
  let r2 = 0;
  for (let i = 0; i < n; i++) {
    const a = l[i] - ml;
    const b = r[i] - mr;
    lr += a * b;
    l2 += a * a;
    r2 += b * b;
  }
  const d = Math.sqrt(l2 * r2);
  return d > 0 ? lr / d : 1;
}

function filterPair(
  l: Float32Array,
  r: Float32Array,
  sampleRate: number,
  make: () => Biquad,
): [Float32Array, Float32Array] {
  const fl = make();
  const fr = make();
  const ol = new Float32Array(l.length);
  const or = new Float32Array(r.length);
  for (let i = 0; i < l.length; i++) {
    ol[i] = fl.process(l[i]);
    or[i] = fr.process(r[i]);
  }
  return [ol, or];
}

export function analyzeStereo(buffers: Float32Array[], sampleRate: number): StereoReport {
  if (buffers.length < 2) {
    return {
      correlation: 1,
      sideMidDb: -80,
      lowBalanceDb: 0,
      lowCorrelation: 1,
      midCorrelation: 1,
      highCorrelation: 1,
      balanceDb: 0,
      phase: [],
    };
  }
  const l = buffers[0];
  const r = buffers[1];
  const [lowL, lowR] = filterPair(l, r, sampleRate, () => new Biquad('lowpass', sampleRate, 120));
  const [midL, midR] = filterPair(l, r, sampleRate, () => new Biquad('highpass', sampleRate, 120));
  const midLpL = new Biquad('lowpass', sampleRate, 2000);
  const midLpR = new Biquad('lowpass', sampleRate, 2000);
  for (let i = 0; i < midL.length; i++) {
    midL[i] = midLpL.process(midL[i]);
    midR[i] = midLpR.process(midR[i]);
  }
  const [hiL, hiR] = filterPair(l, r, sampleRate, () => new Biquad('highpass', sampleRate, 2000));

  let em = 0;
  let es = 0;
  const step = Math.max(1, Math.floor(l.length / 2500));
  const phase: { l: number; r: number }[] = [];
  for (let i = 0; i < l.length; i++) {
    const m = (l[i] + r[i]) * 0.5;
    const s = (l[i] - r[i]) * 0.5;
    em += m * m;
    es += s * s;
    if (i % step === 0) phase.push({ l: l[i], r: r[i] });
  }

  return {
    correlation: correlation(l, r),
    sideMidDb: 10 * Math.log10((es + 1e-12) / (em + 1e-12)),
    lowBalanceDb: energyRatioDb(lowL, lowR),
    lowCorrelation: correlation(lowL, lowR),
    midCorrelation: correlation(midL, midR),
    highCorrelation: correlation(hiL, hiR),
    balanceDb: energyRatioDb(l, r),
    phase,
  };
}
