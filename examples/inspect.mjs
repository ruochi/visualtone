// Objective listening aid: per-track RMS, spectral band balance, crest factor.
// Usage: node examples/inspect.mjs examples/funk.json
import { readFileSync } from 'node:fs';
import { baseDirOf, parseScore, render } from '../dist/index.js';

const path = process.argv[2];
const score = parseScore(JSON.parse(readFileSync(path, 'utf8')));
const sr = score.sampleRate;

/** Energy share per band using a cheap FFT-free filterbank (one-pole splits). */
function bands(x) {
  const edges = [60, 250, 2000, 6000];
  const names = ['sub <60', 'low 60-250', 'mid 250-2k', 'presence 2-6k', 'air >6k'];
  const lp = edges.map(() => 0);
  const coef = edges.map((f) => 1 - Math.exp((-2 * Math.PI * f) / sr));
  const e = new Float64Array(names.length);
  for (let i = 0; i < x.length; i++) {
    let prev = 0;
    for (let b = 0; b < edges.length; b++) {
      lp[b] += coef[b] * (x[i] - lp[b]);
      e[b] += (lp[b] - prev) ** 2;
      prev = lp[b];
    }
    e[edges.length] += (x[i] - prev) ** 2;
  }
  const total = e.reduce((a, b) => a + b, 0) || 1;
  return names.map((n, i) => `${n} ${((100 * e[i]) / total).toFixed(0)}%`).join(' | ');
}

const db = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : '-inf');
const stats = (x) => {
  let s = 0, p = 0, dc = 0;
  for (const v of x) { s += v * v; p = Math.max(p, Math.abs(v)); dc += v; }
  const r = Math.sqrt(s / x.length);
  return { rms: r, peak: p, crest: p / (r || 1), dc: dc / x.length, finite: x.every(Number.isFinite) };
};

const full = render(score, { baseDir: baseDirOf(path) });
const m = stats(full.left);
console.log(`MIX  rms ${db(m.rms)} dBFS  peak ${db(m.peak)}  crest ${db(m.crest)} dB  dc ${m.dc.toExponential(1)}  finite ${m.finite}`);
console.log(`     loudness ${full.report.loudnessDb.toFixed(1)}  limiter ${full.report.limiterDb.toFixed(1)} dB`);
console.log(`     ${bands(full.left)}`);
for (const issue of full.report.issues) console.log(`! ${issue.code}: ${issue.message}`);

for (const t of score.tracks) {
  const solo = render(
    { ...score, tracks: [t], mix: { ...score.mix, loudness: 0, ceiling: 0 } },
    { baseDir: baseDirOf(path) },
  );
  const s = stats(solo.left);
  console.log(`${t.id.padEnd(6)} crest ${db(s.crest)} dB  ${bands(solo.left)}`);
}
