// One coordinate search of the violin slope and the fixed body peaks.
// The loss is the menuet harmonic-slope distance, not TinySOL excess.
// The dense body (seed, count, Q, level) stays put.
//
//   node scripts/violin-slope-fit.mjs
//
// Writes references/violin-slope-fit.json. Does not edit the preset.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARMONIC_PRESETS } from '../dist/engines/harmonic.js';
import { loadScoreFile } from '../dist/load-score.js';
import { render } from '../dist/renderer.js';
import { writeWavFile } from '../dist/wav.js';

const root = new URL('..', import.meta.url).pathname;
const scorePath = join(root, 'examples/violin-minuet.json');
const recPath = '/tmp/violin-solo/rec-phrase.wav';
const synthPath = '/tmp/violin-solo/fit-synth.wav';
const py = join(root, 'scripts/violin-solo-figures.py');
const PHRASE = 24 * (60 / 115);
mkdirSync('/tmp/violin-solo', { recursive: true });

const base = structuredClone(HARMONIC_PRESETS.violin);
const saved = HARMONIC_PRESETS.violin;

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
    cursor = cursor[key];
  }
  const last = parts[parts.length - 1];
  cursor[/^\d+$/.test(last) ? Number(last) : last] = value;
}

function getPath(obj, path) {
  return path.split('.').reduce((o, key) => o[/^\d+$/.test(key) ? Number(key) : key], obj);
}

function lossOf(values) {
  const preset = structuredClone(base);
  for (const [path, value] of Object.entries(values)) setPath(preset, path, value);
  HARMONIC_PRESETS.violin = preset;
  const loaded = loadScoreFile(scorePath);
  const rendered = render(loaded.score);
  const mix = rendered.buffers;
  const n = Math.round(PHRASE * rendered.sampleRate);
  const mono = new Float32Array(n);
  const frames = Math.min(n, mix[0].length);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (const b of mix) s += b[i];
    mono[i] = s / mix.length;
  }
  writeFileSync(synthPath, writeWavFile([mono, mono], rendered.sampleRate, { bitDepth: 32, dither: false }));
  const out = execFileSync('python3', [
    py, '--slope-only',
    '--recording', recPath,
    '--synth', synthPath,
    '--score', scorePath,
  ], { encoding: 'utf8' });
  const summary = JSON.parse(out.trim().split('\n').pop());
  return summary;
}

const start = {
  'slope.base': getPath(base, 'slope.base'),
  'modes.4.db': getPath(base, 'modes.4.db'),
  'modes.2.db': getPath(base, 'modes.2.db'),
  'modes.3.db': getPath(base, 'modes.3.db'),
};
const axes = [
  ['slope.base', [0.12, 0.1675, 0.22, 0.28, 0.36, 0.46]],
  ['modes.4.db', [14, 8, 4, 0, -4]],
  ['modes.2.db', [-12.42, -8, -4, 0, 4]],
  ['modes.3.db', [10.52, 6, 2, 0]],
];

const trace = [];
try {
  let current = { ...start };
  let best = lossOf(current);
  console.log(`start ${best.meanAbsDb}  ${JSON.stringify(current)}`);
  trace.push({ values: current, ...best });
  for (const [path, values] of axes) {
    let axisBest = best;
    let axisValues = current;
    for (const value of values) {
      if (Math.abs(value - current[path]) < 1e-9) continue;
      const trial = { ...current, [path]: value };
      const got = lossOf(trial);
      console.log(`  ${path}=${value}  ${got.meanAbsDb}`);
      trace.push({ values: trial, ...got });
      if (got.meanAbsDb < axisBest.meanAbsDb) {
        axisBest = got;
        axisValues = trial;
      }
    }
    current = axisValues;
    best = axisBest;
    console.log(`keep ${path}=${current[path]}  ${best.meanAbsDb}`);
  }
  const report = {
    target: 'menuet harmonic slope, median absolute partial error',
    fixed: ['body.seed', 'body.count', 'body.qLo', 'body.qHi', 'body.db', 'modes.0', 'modes.1'],
    start,
    startLoss: trace[0].meanAbsDb,
    best: current,
    bestLoss: best.meanAbsDb,
    partialDb: best.partialDb,
    trace,
  };
  writeFileSync(join(root, 'references/violin-slope-fit.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`best ${best.meanAbsDb}  ${JSON.stringify(current)}`);
} finally {
  HARMONIC_PRESETS.violin = saved;
}
