import type { Analysis } from '../analysis/index.js';
import type { Finding } from '../analysis/types.js';
import { prepareTrackPoints, sampleAt } from '../interpolator.js';
import type { Score } from '../schema.js';
import { Canvas, hueRgb, lerpColor, type RGB } from './canvas.js';
import { encodePng } from './png.js';

const INK: RGB = [220, 224, 230];
const DIM: RGB = [140, 148, 160];
const GRID: RGB = [36, 40, 52];
const ACCENT: RGB = [120, 210, 190];
const WARN: RGB = [240, 170, 70];
const BAD: RGB = [230, 90, 90];

const PANEL_NAMES = ['curves', 'spectrogram', 'stems', 'bands', 'loudness', 'phase', 'kick', 'masking', 'ssm'] as const;
export type PanelName = (typeof PANEL_NAMES)[number];

function flag(f: Finding): string {
  if (f.id === 'clip') return 'CLIP';
  if (f.id === 'stereo.lowBalance') return 'LOW IMBAL';
  if (f.id === 'stereo.lowCorrelation') return 'LOW NOT MONO';
  if (f.id === 'stereo.width') return 'WIDTH';
  if (f.id === 'loudness.integrated') return 'LUFS';
  if (f.id === 'loudness.plr') return 'PLR';
  if (f.id === 'structure.contrast') return 'FLAT';
  if (f.id.startsWith('band.')) return f.id.slice(5).toUpperCase();
  if (f.id.startsWith('share.')) return f.id.slice(6).toUpperCase() + ' LOUD';
  if (f.id.startsWith('mask.')) return 'MASK ' + f.id.slice(5).replace('|', '/').toUpperCase();
  return f.id.toUpperCase();
}

function severityColor(s: Finding['severity']): RGB {
  return s === 'high' ? BAD : s === 'medium' ? WARN : DIM;
}

function drawHeader(c: Canvas, analysis: Analysis, x: number, y: number, w: number): number {
  const r = analysis.report;
  c.fillRect(x, y, w, 36, [20, 24, 34]);
  c.text(x + 10, y + 8, 'VISUALTONE LISTEN', INK, 2);
  const summary = [
    `LUFS ${r.loudness.integratedLufs.toFixed(1)}`,
    `PLR ${r.loudness.plr.toFixed(1)}`,
    `TP ${r.loudness.truePeakDbtp.toFixed(1)}`,
    `KEY ${r.harmony.key ?? '-'}`,
    `BPM ${r.rhythm.tempo ? r.rhythm.tempo.toFixed(1) : '-'}`,
    `SWING ${r.rhythm.swing === null ? '-' : r.rhythm.swing.toFixed(2)}`,
    `${r.duration.toFixed(1)}S`,
  ].join('   ');
  c.text(x + 280, y + 14, summary, ACCENT, 1);
  let yy = y + 44;
  const shown = r.findings.slice(0, 8);
  if (shown.length === 0) {
    c.text(x + 10, yy, 'NO FINDINGS', ACCENT, 1);
    yy += 16;
  }
  for (const f of shown) {
    c.fillRect(x + 10, yy, 8, 8, severityColor(f.severity));
    c.text(x + 24, yy, `${f.severity}  ${flag(f)}  ${f.value.toFixed(2)}  ${f.target}`, INK, 2);
    yy += 20;
  }
  if (r.profile) {
    c.text(x + 10, yy + 2, `PROFILE ${r.profile.name}`, DIM, 1);
    yy += 16;
  }
  return yy - y + 8;
}

function drawCurves(c: Canvas, analysis: Analysis, score: Score | undefined, x: number, y: number, w: number): number {
  const h = 200;
  c.text(x, y, 'SCORE CURVES', DIM, 1);
  const top = y + 14;
  c.fillRect(x, top, w, h, [12, 14, 20]);
  if (!score) {
    c.text(x + 8, top + 8, 'NO SCORE', DIM, 1);
    return h + 22;
  }
  const y0 = 28;
  const y1 = 100;
  const dur = analysis.report.duration || 1;
  for (let p = y0; p <= y1; p += 12) {
    const py = top + ((y1 - p) / (y1 - y0)) * (h - 4) + 2;
    c.hline(x, x + w, py, GRID);
  }
  const bpm = score.bpm;
  if (bpm) {
    const bar = (4 * 60) / bpm;
    for (let t = 0; t < dur; t += bar) {
      c.vline(x + (t / dur) * w, top, top + h, GRID);
    }
  }
  const step = Math.max(1, Math.floor((dur * 80) / w));
  for (const track of score.tracks) {
    const points = prepareTrackPoints(track);
    const color = hueRgb(track.hue, track.lightness ?? 0.6);
    let prev: { x: number; y: number } | null = null;
    for (let i = 0; i <= w; i += 1) {
      const t = (i / w) * dur;
      if (i % step !== 0 && i !== w) continue;
      const s = sampleAt(points, t, track.lightness ?? 0.5);
      if (!s || s.size < 0.02) {
        prev = null;
        continue;
      }
      const px = x + i;
      const py = top + ((y1 - Math.max(y0, Math.min(y1, s.y))) / (y1 - y0)) * (h - 4);
      const thick = Math.max(1, Math.round(s.size * 3));
      if (prev) c.line(prev.x, prev.y, px, py, color);
      c.fillRect(px, py - thick, 2, thick * 2, color);
      prev = { x: px, y: py };
    }
  }
  c.text(x + 4, top + 4, 'Y 100', DIM, 1);
  c.text(x + 4, top + h - 12, 'Y 28', DIM, 1);
  return h + 22;
}

function drawHeat(
  c: Canvas,
  x: number,
  y: number,
  w: number,
  h: number,
  db: Float32Array,
  frames: number,
  bins: number,
  floor = -80,
) {
  for (let py = 0; py < h; py++) {
    const b = Math.min(bins - 1, Math.floor(((h - 1 - py) / h) * bins));
    for (let px = 0; px < w; px++) {
      const f = Math.min(frames - 1, Math.floor((px / w) * frames));
      const v = db[f * bins + b];
      const t = (v - floor) / -floor;
      c.set(x + px, y + py, lerpColor(t));
    }
  }
}

function drawSpectrogram(c: Canvas, analysis: Analysis, _score: Score | undefined, x: number, y: number, w: number): number {
  const h = 240;
  c.text(x, y, 'SPECTROGRAM  40HZ - 16KHZ', DIM, 1);
  const top = y + 14;
  const { specDb, specFrames, specBins, specFreqs } = analysis.plot;
  drawHeat(c, x, top, w, h, specDb, specFrames, specBins);
  for (const hz of [100, 1000, 5000]) {
    const idx = specFreqs.findIndex((f) => f >= hz);
    if (idx < 0) continue;
    const py = top + ((specBins - idx) / specBins) * h;
    c.hline(x, x + w, py, [255, 255, 255]);
    c.text(x + 4, py - 10, hz >= 1000 ? `${hz / 1000}K` : String(hz), INK, 1);
  }
  return h + 22;
}

function drawStems(c: Canvas, analysis: Analysis, _score: Score | undefined, x: number, y: number, w: number): number {
  const ids = analysis.plot.stemIds;
  const dbs = analysis.plot.stemDb;
  if (!ids || !dbs || !analysis.plot.stemTimes) {
    c.text(x, y, 'STEMS  (RENDER WITH STEMS)', DIM, 1);
    return 20;
  }
  c.text(x, y, 'STEMS', DIM, 1);
  const rowH = 22;
  const labelW = 110;
  let yy = y + 14;
  ids.forEach((id, i) => {
    const share = analysis.plot.stemShares?.[i] ?? 0;
    c.text(x, yy + 6, `${id} ${(share * 100).toFixed(0)}%`.slice(0, 16), INK, 1);
    const frames = analysis.plot.stemTimes!.length;
    const bins = analysis.plot.stemFreqs!.length;
    drawHeat(c, x + labelW, yy, w - labelW, rowH - 2, dbs[i], frames, bins);
    yy += rowH;
  });
  return yy - y + 6;
}

function drawBands(c: Canvas, analysis: Analysis, _score: Score | undefined, x: number, y: number, w: number): number {
  c.text(x, y, 'BANDS', DIM, 1);
  const bands = analysis.report.bands;
  const top = y + 16;
  const rowH = 22;
  const labelW = 120;
  const maxShare = Math.max(0.3, ...bands.map((b) => Math.max(b.share, b.target?.[1] ?? 0)));
  const scale = (share: number) => ((w - labelW - 8) * share) / maxShare;
  bands.forEach((b, i) => {
    const yy = top + i * rowH;
    c.text(x, yy + 4, `${b.name} ${(b.share * 100).toFixed(1)}%`, INK, 1);
    if (b.target) {
      const x0 = x + labelW + scale(b.target[0]);
      const x1 = x + labelW + scale(b.target[1]);
      c.fillRect(x0, yy + 4, Math.max(1, x1 - x0), 12, [40, 48, 64]);
    }
    c.fillRect(x + labelW, yy + 6, Math.max(1, scale(b.share)), 8, ACCENT);
  });
  return 16 + bands.length * rowH + 8;
}

function drawLoudness(c: Canvas, analysis: Analysis, _score: Score | undefined, x: number, y: number, w: number): number {
  const h = 120;
  c.text(x, y, 'LOUDNESS  SHORT-TERM LUFS + BAR ENERGY', DIM, 1);
  const top = y + 14;
  c.fillRect(x, top, w, h, [12, 14, 20]);
  const dur = analysis.report.duration || 1;
  const times = analysis.plot.shortTermTimes;
  const values = analysis.plot.shortTermLufs;
  const bars = analysis.plot.barEnergyDb;
  const bt = analysis.plot.barTimes;
  if (bars.length > 1) {
    const bw = Math.max(2, w / bars.length - 2);
    bars.forEach((e, i) => {
      const t = Math.max(0, Math.min(1, (e + 18) / 18));
      const bh = t * (h - 16);
      c.fillRect(x + (bt[i] / dur) * w - bw / 2, top + h - 4 - bh, bw, Math.max(1, bh), [40, 70, 120]);
    });
  }
  if (values.length > 1) {
    const finite = values.filter((v) => Number.isFinite(v));
    const lo = Math.min(-36, ...finite);
    const hi = Math.max(-6, ...finite);
    const px = (t: number) => x + (t / dur) * w;
    const py = (v: number) => top + 4 + ((hi - v) / Math.max(1, hi - lo)) * (h - 12);
    for (let i = 1; i < values.length; i++) {
      if (!Number.isFinite(values[i - 1]) || !Number.isFinite(values[i])) continue;
      c.line(px(times[i - 1]), py(values[i - 1]), px(times[i]), py(values[i]), ACCENT);
    }
    c.text(x + 4, top + 2, `${hi.toFixed(0)} LUFS`, DIM, 1);
  }
  return h + 22;
}

function drawPhase(c: Canvas, analysis: Analysis, _score: Score | undefined, x: number, y: number, w: number): number {
  const h = 150;
  c.text(x, y, 'PHASE', DIM, 1);
  const top = y + 14;
  const size = h;
  c.fillRect(x, top, size, size, [12, 14, 20]);
  c.line(x, top + size, x + size, top, GRID);
  const st = analysis.report.stereo;
  for (const p of analysis.plot.phase) {
    const px = x + ((p.l + 1) / 2) * size;
    const py = top + ((1 - p.r) / 2) * size;
    c.set(Math.round(px), Math.round(py), ACCENT);
  }
  const tx = x + size + 16;
  const lines = [
    `CORR ${st.correlation.toFixed(2)}`,
    `SIDE/MID ${st.sideMidDb.toFixed(1)} DB`,
    `LOW BAL ${st.lowBalanceDb.toFixed(1)} DB`,
    `LOW CORR ${st.lowCorrelation.toFixed(2)}`,
    `MID CORR ${st.midCorrelation.toFixed(2)}`,
    `HIGH CORR ${st.highCorrelation.toFixed(2)}`,
  ];
  lines.forEach((line, i) => c.text(tx, top + 8 + i * 16, line, INK, 1));
  void w;
  return h + 22;
}

function drawKick(c: Canvas, analysis: Analysis, _score: Score | undefined, x: number, y: number, w: number): number {
  const h = 90;
  const env = analysis.plot.kickEnvelope;
  const punch = analysis.plot.kickPunch;
  c.text(x, y, `KICK  FIRST 0.5S LOW BAND   PUNCH ${punch === null ? '-' : punch.toFixed(2)}`, DIM, 1);
  const top = y + 14;
  c.fillRect(x, top, w, h, [12, 14, 20]);
  const max = Math.max(1e-6, ...env);
  const bw = w / Math.max(1, env.length);
  env.forEach((v, i) => {
    const db = 20 * Math.log10(Math.max(v, 1e-9) / max);
    const bh = (Math.max(0, Math.min(1, (db + 36) / 36)) * (h - 22));
    c.fillRect(x + i * bw + 4, top + h - bh - 4, Math.max(1, bw - 8), Math.max(1, bh), ACCENT);
    if (i % 2 === 0) c.text(x + i * bw + 6, top + 2, `${i * 50}`, DIM, 1);
  });
  return h + 22;
}

function drawMask(c: Canvas, analysis: Analysis, _score: Score | undefined, x: number, y: number, w: number): number {
  const ids = analysis.plot.maskIds;
  const m = analysis.plot.maskMatrix;
  if (!ids || !m) {
    c.text(x, y, 'MASKING  (NO STEMS)', DIM, 1);
    return 20;
  }
  c.text(x, y, 'MASKING OVERLAP', DIM, 1);
  const top = y + 16;
  const label = 100;
  const cell = Math.max(8, Math.min(28, Math.floor((w - label) / ids.length)));
  ids.forEach((id, i) => {
    c.text(x, top + i * cell + 2, id.slice(0, 14), DIM, 1);
    for (let j = 0; j < ids.length; j++) {
      const v = i === j ? 1 : m[i][j];
      c.fillRect(x + label + j * cell, top + i * cell, cell - 1, cell - 1, lerpColor(v));
    }
  });
  return 16 + ids.length * cell + 8;
}

function drawSsm(c: Canvas, analysis: Analysis, _score: Score | undefined, x: number, y: number, w: number): number {
  const h = 200;
  c.text(x, y, 'SELF SIMILARITY + CHROMA', DIM, 1);
  const top = y + 14;
  const ssm = analysis.plot.ssm;
  const size = Math.min(h, Math.floor(w * 0.45));
  const cell = size / Math.max(1, ssm.length);
  for (let i = 0; i < ssm.length; i++) {
    for (let j = 0; j < ssm.length; j++) {
      c.fillRect(x + j * cell, top + i * cell, Math.ceil(cell), Math.ceil(cell), lerpColor(ssm[i][j]));
    }
  }
  const chroma = analysis.plot.chroma;
  const cx = x + size + 24;
  const cw = w - size - 24;
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const rowH = h / 12;
  for (let pc = 0; pc < 12; pc++) {
    c.text(cx, top + pc * rowH, names[pc], DIM, 1);
    for (let px = 0; px < cw - 24; px++) {
      const f = Math.min(chroma.length - 1, Math.floor((px / (cw - 24)) * chroma.length));
      const v = chroma[f]?.[pc] ?? 0;
      c.vline(cx + 20 + px, top + pc * rowH, top + (pc + 1) * rowH - 1, lerpColor(Math.min(1, v * 8)));
    }
  }
  return h + 22;
}

const DRAW: Record<PanelName, (c: Canvas, a: Analysis, s: Score | undefined, x: number, y: number, w: number) => number> = {
  curves: drawCurves,
  spectrogram: drawSpectrogram,
  stems: drawStems,
  bands: drawBands,
  loudness: drawLoudness,
  phase: drawPhase,
  kick: drawKick,
  masking: drawMask,
  ssm: drawSsm,
};

export function renderReport(analysis: Analysis, score?: Score, panel?: string): Buffer {
  const margin = 16;
  const width = panel ? 1100 : 1600;
  const names: PanelName[] = panel ? [panel as PanelName] : [...PANEL_NAMES];
  if (panel && !DRAW[panel as PanelName]) {
    throw new Error(`Unknown panel "${panel}". Use ${PANEL_NAMES.join(', ')}`);
  }
  const inner = width - margin * 2;
  // Measure by drawing onto a tall scratch canvas, then crop.
  const scratch = new Canvas(width, 4000);
  let y = margin;
  const headerH = panel ? 0 : drawHeader(scratch, analysis, margin, y, inner);
  if (!panel) y += headerH;
  for (const name of names) {
    y += DRAW[name](scratch, analysis, score, margin, y, inner);
    y += 8;
  }
  const height = Math.min(4000, Math.max(32, y + margin));
  const out = new Canvas(width, height);
  out.px.set(scratch.px.subarray(0, width * height * 4));
  return encodePng(out.px, width, height);
}
