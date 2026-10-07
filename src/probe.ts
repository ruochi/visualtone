import { analyzeNote, noteName, type NoteFeatures } from './analysis/timbre.js';
import type { Finding } from './analysis/types.js';
import { render } from './renderer.js';
import { ScoreSchema, type Score } from './schema.js';

export interface ProbeOptions {
  pitches?: number[];
  sizes?: number[];
  /** Seconds each note is held. Default 1.5. */
  noteSec?: number;
  /** Silence after each note-off. Default 2. */
  tailSec?: number;
  sampleRate?: number;
  seed?: number;
}

export interface ProbeCell {
  midi: number;
  size: number;
  start: number;
  noteOn: number;
  noteOff: number;
  stop: number;
}

export interface ProbeReport {
  sampleRate: number;
  cells: (ProbeCell & { features: NoteFeatures })[];
  tracking: {
    pitchMaxAbsCents: number | null;
    pitchMeanAbsCents: number | null;
    /** Peak at the largest size minus the smallest, dB, median over pitches. */
    levelSpanDb: number | null;
    /** log2 of the centroid at the largest size over the smallest, median over pitches. */
    brightnessSpanOct: number | null;
    /** Slope of log2(decay rate) per octave at the middle size. Positive means higher notes die sooner. */
    decayPerOctave: number | null;
    medianDecayDbPerSec: number | null;
    clicks: number;
    nonFinite: number;
  };
  findings: Finding[];
}

export const DEFAULT_PITCHES = [36, 48, 60, 72, 84];
export const DEFAULT_SIZES = [0.3, 0.6, 0.9];
const LEAD = 0.05;

/** Lay out one note per (pitch, size) with silence between them. */
export function probeLayout(opts: ProbeOptions = {}): ProbeCell[] {
  const pitches = opts.pitches ?? DEFAULT_PITCHES;
  const sizes = opts.sizes ?? DEFAULT_SIZES;
  const noteSec = opts.noteSec ?? 1.5;
  const tailSec = opts.tailSec ?? 2;
  const slot = LEAD + noteSec + tailSec;
  const cells: ProbeCell[] = [];
  for (const midi of pitches) {
    for (const size of sizes) {
      const start = cells.length * slot;
      cells.push({ midi, size, start, noteOn: start + LEAD, noteOff: start + LEAD + noteSec, stop: start + slot });
    }
  }
  return cells;
}

/** A score that plays the probe grid on one track. Time-based fields of the template are dropped. */
export function probeScore(track: Record<string, unknown>, opts: ProbeOptions = {}): { score: Score; cells: ProbeCell[] } {
  const cells = probeLayout(opts);
  const {
    notes: _n,
    points: _p,
    clip: _c,
    clips: _cs,
    sfx: _s,
    offset: _o,
    automation: _a,
    duck: _d,
    space: _sp,
    room: _r,
    echo: _e,
    ...rest
  } = track;
  const score = ScoreSchema.parse({
    sampleRate: opts.sampleRate ?? 48000,
    seed: opts.seed ?? 1,
    duration: cells.length ? cells[cells.length - 1].stop : 0.1,
    master: { loudness: -18, drive: 0 },
    tracks: [
      {
        channel: [0, 1],
        ...rest,
        id: 'probe',
        notes: cells.map((c) => ({ t: c.noteOn, y: c.midi, size: c.size, duration: c.noteOff - c.noteOn, ease: 'hold' })),
      },
    ],
  });
  return { score, cells };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Measure every cell of a probe buffer and check the habits most acoustic instruments share. */
export function analyzeProbe(mono: Float32Array, sampleRate: number, cells: ProbeCell[]): ProbeReport {
  const measured = cells.map((c) => ({
    ...c,
    features: analyzeNote(mono, sampleRate, { start: c.start, stop: c.stop, noteOff: c.noteOff, midi: c.midi }),
  }));
  const cents = measured.filter((c) => c.features.centsOff !== null).map((c) => ({ c, v: c.features.centsOff! }));
  const worst = cents.reduce<(typeof cents)[number] | null>((w, x) => (w === null || Math.abs(x.v) > Math.abs(w.v) ? x : w), null);
  const pitches = [...new Set(cells.map((c) => c.midi))];
  const sizes = [...new Set(cells.map((c) => c.size))].sort((a, b) => a - b);
  const cellAt = (midi: number, size: number) => measured.find((c) => c.midi === midi && c.size === size);

  const levelSpans: number[] = [];
  const brightSpans: number[] = [];
  if (sizes.length >= 2) {
    for (const m of pitches) {
      const lo = cellAt(m, sizes[0])?.features;
      const hi = cellAt(m, sizes[sizes.length - 1])?.features;
      if (!lo || !hi || !Number.isFinite(lo.envelope.peakDb) || !Number.isFinite(hi.envelope.peakDb)) continue;
      levelSpans.push(hi.envelope.peakDb - lo.envelope.peakDb);
      if (lo.spectrum.centroidHz > 0 && hi.spectrum.centroidHz > 0) brightSpans.push(Math.log2(hi.spectrum.centroidHz / lo.spectrum.centroidHz));
    }
  }
  const mid = sizes[Math.floor(sizes.length / 2)];
  const decays = pitches
    .map((m) => ({ m, d: cellAt(m, mid)?.features.envelope.decayDbPerSec ?? null }))
    .filter((x): x is { m: number; d: number } => x.d !== null && x.d >= 1);
  let decayPerOctave: number | null = null;
  if (decays.length >= 2) {
    const xs = decays.map((x) => x.m / 12);
    const ys = decays.map((x) => Math.log2(x.d));
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
    const my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < xs.length; i++) {
      sxx += (xs[i] - mx) ** 2;
      sxy += (xs[i] - mx) * (ys[i] - my);
    }
    decayPerOctave = sxx > 0 ? sxy / sxx : null;
  }
  const allDecays = measured.map((c) => c.features.envelope.decayDbPerSec).filter((d): d is number => d !== null);
  const clicks = measured.reduce((s, c) => s + c.features.artifacts.clicks, 0);
  const nonFinite = measured.reduce((s, c) => s + c.features.artifacts.nonFinite, 0);
  const tracking: ProbeReport['tracking'] = {
    pitchMaxAbsCents: worst ? Math.abs(worst.v) : null,
    pitchMeanAbsCents: cents.length ? cents.reduce((s, x) => s + Math.abs(x.v), 0) / cents.length : null,
    levelSpanDb: median(levelSpans),
    brightnessSpanOct: median(brightSpans),
    decayPerOctave,
    medianDecayDbPerSec: median(allDecays),
    clicks,
    nonFinite,
  };

  const findings: Finding[] = [];
  if (nonFinite > 0) {
    findings.push({
      id: 'probe.nonFinite',
      severity: 'high',
      metric: 'artifacts.nonFinite',
      value: nonFinite,
      target: '0',
      message: `有 ${nonFinite} 个采样是 NaN 或无穷大`,
      suggestion: '检查滤波器和反馈环路是否发散',
    });
  }
  const off = cents.filter((x) => Math.abs(x.v) > 10).sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  if (off.length) {
    const list = off
      .slice(0, 4)
      .map((x) => `${noteName(x.c.midi)}@${x.c.size} ${x.v > 0 ? '+' : ''}${x.v.toFixed(0)}`)
      .join('，');
    findings.push({
      id: 'probe.pitch',
      severity: Math.abs(off[0].v) > 25 ? 'high' : 'medium',
      metric: 'centsOff',
      value: off[0].v,
      target: '±10 cents',
      message: `有 ${off.length} 个音不准（音分）：${list}`,
      suggestion: '音越高偏得越多，通常是延迟线长度取整、环路滤波的相位延迟没补偿',
    });
  }
  const missing = measured.filter((c) => c.features.f0Hz === null);
  if (missing.length) {
    findings.push({
      id: 'probe.unpitched',
      severity: 'low',
      metric: 'f0Hz',
      value: missing.length,
      target: '0',
      message: `${missing.length} 个音量不出音高：${missing.slice(0, 4).map((c) => `${noteName(c.midi)}@${c.size}`).join('，')}`,
      suggestion: '钟、鼓这类不该有明确音高的乐器可以忽略；其它乐器检查是不是没发声或者音高不稳',
    });
  }
  if (clicks > 0) {
    const where = measured.find((c) => c.features.artifacts.clicks > 0)!;
    findings.push({
      id: 'probe.clicks',
      severity: 'medium',
      metric: 'artifacts.clicks',
      value: clicks,
      target: '0',
      message: `有 ${clicks} 处咔哒声，第一处在 ${noteName(where.midi)}@${where.size} 的 ${where.features.artifacts.clickTimes[0]?.toFixed(3)} s`,
      suggestion: '音符结束或参数跳变时要做几毫秒的淡出或平滑',
    });
  }
  if (tracking.levelSpanDb !== null && tracking.levelSpanDb < 3) {
    findings.push({
      id: 'probe.velocityLevel',
      severity: 'low',
      metric: 'tracking.levelSpanDb',
      value: tracking.levelSpanDb,
      target: '> 3 dB',
      message: `力度从 ${sizes[0]} 到 ${sizes[sizes.length - 1]}，响度只差 ${tracking.levelSpanDb.toFixed(1)} dB`,
      suggestion: '让 size 影响激励强度',
    });
  }
  if (tracking.brightnessSpanOct !== null && tracking.brightnessSpanOct < 0.1) {
    findings.push({
      id: 'probe.velocityBrightness',
      severity: 'low',
      metric: 'tracking.brightnessSpanOct',
      value: tracking.brightnessSpanOct,
      target: '> 0.1 oct',
      message: `力度加大后亮度只变了 ${tracking.brightnessSpanOct.toFixed(2)} 个八度`,
      suggestion: '声学乐器越用力越亮：让 size 同时打开激励的高频',
    });
  }
  if (tracking.medianDecayDbPerSec !== null && tracking.medianDecayDbPerSec >= 2 && decayPerOctave !== null && decayPerOctave <= 0) {
    findings.push({
      id: 'probe.decayByPitch',
      severity: 'low',
      metric: 'tracking.decayPerOctave',
      value: decayPerOctave,
      target: '> 0',
      message: `高音并没有衰减得更快（每八度 ${decayPerOctave.toFixed(2)}）`,
      suggestion: '弦和板的高音通常死得更快：让损耗随音高变大',
    });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { sampleRate, cells: measured, tracking, findings };
}

/** Render the probe grid for one track template and measure it from the dry stem. */
export function probeTrack(
  track: Record<string, unknown>,
  opts: ProbeOptions = {},
): ProbeReport & { buffer: Float32Array; score: Score } {
  const { score, cells } = probeScore(track, opts);
  const rendered = render(score, { stems: true });
  const stem = rendered.stems!.find((s) => s.id === 'probe')!;
  const mono = new Float32Array(stem.l.length);
  for (let i = 0; i < mono.length; i++) mono[i] = (stem.l[i] + stem.r[i]) * 0.5;
  return { ...analyzeProbe(mono, rendered.sampleRate, cells), buffer: mono, score };
}
