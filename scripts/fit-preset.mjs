// Fit one harmonic preset to a catalog set. The fit split is optimized; the test split is held out.
// Usage: node scripts/fit-preset.mjs <instrument> <set-id>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  BAR_PRESETS,
  DRUM_PRESETS,
  EPIANO_PRESETS,
  ORGAN_REG,
  PIANO_PRESETS,
  PLUCK_PRESETS,
  WIND_PRESETS,
} from '../dist/engines/acoustic.js';
import { HARMONIC_PRESETS } from '../dist/engines/harmonic.js';
import { noteTiming } from './lib/score-note.mjs';

const root = new URL('..', import.meta.url).pathname;
const instrument = process.argv[2];
const setId = process.argv[3];
if (!instrument || !setId) {
  console.error('usage: node scripts/fit-preset.mjs <instrument> <set-id>');
  process.exit(1);
}

const SPECS = {
  'electric-bass': [
    { path: 'slope.base', min: 0.02, max: 1.4, step: 0.16 },
    { path: 'slope.soft', min: 0, max: 0.8, step: 0.1 },
    { path: 'slope.light', min: 0, max: 0.4, step: 0.05 },
    { path: 'resonance.hz', min: 40, max: 500, step: 50 },
    { path: 'resonance.q', min: 1.5, max: 18, step: 2 },
    { path: 'resonance.mix', min: 0, max: 0.7, step: 0.1 },
    { path: 'noise.level', min: 0, max: 0.1, step: 0.012 },
    { path: 'noise.hz', min: 60, max: 1200, step: 150 },
    { path: 'transient.level', min: 0, max: 1.4, step: 0.2 },
    { path: 'transient.brighten', min: 0, max: 1, step: 0.12 },
    { path: 'transient.sec', min: 0.015, max: 0.25, step: 0.04 },
    { path: 'transient.noise', min: 0, max: 0.6, step: 0.08 },
    { path: 'attackSec', min: 0.003, max: 0.08, step: 0.01 },
    { path: 'life.shimmerRms', min: 0, max: 0.15, step: 0.02 },
    { path: 'ring.sec', min: 0.25, max: 6, step: 0.6, start: 1.2 },
    { path: 'ring.pitchPow', min: 0, max: 1.5, step: 0.25, start: 0.4 },
    { path: 'ring.partialPow', min: 0.05, max: 1.5, step: 0.2, start: 0.35 },
  ],
};

const FAMILIES = {
  violin: 'bow',
  viola: 'bow',
  cello: 'bow',
  contrabass: 'bass',
  trumpet: 'brass',
  horn: 'brass',
  trombone: 'brass',
  tuba: 'brass',
  saxophone: 'brass',
  oboe: 'reed',
  bassoon: 'reed',
};

function familySpec(preset, family) {
  const specs = [
    { path: 'slope.base', min: 0.015, max: 1.6, step: 0.08 },
    { path: 'slope.soft', min: 0, max: 5.5, step: 0.28 },
    { path: 'slope.light', min: 0, max: 0.35, step: 0.04 },
  ];
  if (family === 'brass') specs.push({ path: 'slope.high', min: 0, max: 2.4, step: 0.16 });
  specs.push(
    { path: 'resonance.hz', min: 40, max: 4500, step: Math.max(30, preset.resonance.hz * 0.28) },
    { path: 'resonance.q', min: 1.2, max: 20, step: 1.6 },
    { path: 'resonance.mix', min: 0, max: 0.75, step: 0.07 },
    { path: 'noise.level', min: 0, max: 0.25, step: 0.02 },
    { path: 'noise.hz', min: 60, max: 6000, step: Math.max(50, preset.noise.hz * 0.3) },
    { path: 'attackSec', min: 0.006, max: 0.14, step: 0.014 },
    { path: 'life.vibratoCents', min: 0, max: 30, step: 2 },
    { path: 'life.vibratoHz', min: 2, max: 8.5, step: 0.45 },
    { path: 'life.shimmerRms', min: 0, max: 0.14, step: 0.012 },
    { path: 'life.wanderCents', min: 0, max: 8, step: 0.6 },
  );
  return specs;
}

const MODEL_OF = {
  marimba: 'bar',
  xylophone: 'bar',
  glockenspiel: 'bar',
  vibraphone: 'bar',
  tom: 'drum',
  piano: 'piano',
  harp: 'pluck',
  flute: 'wind',
  clarinet: 'wind',
  organ: 'organ',
  'electric-piano': 'epiano',
};
const TABLES = {
  harmonic: HARMONIC_PRESETS,
  bar: BAR_PRESETS,
  drum: DRUM_PRESETS,
  piano: PIANO_PRESETS,
  pluck: PLUCK_PRESETS,
  wind: WIND_PRESETS,
  epiano: EPIANO_PRESETS,
  organ: { organ: { stops: ORGAN_REG[0] } },
};
const model = process.argv[4] || MODEL_OF[instrument] || 'harmonic';
const preset = TABLES[model]?.[instrument];
if (!preset) throw new Error(`${instrument} is not a ${model} preset`);

function span(path, min, max, step) {
  return { path, min, max, step };
}
const MODEL_SPECS = {
  marimba: barSpec(),
  xylophone: barSpec(),
  glockenspiel: barSpec(),
  vibraphone: barSpec(),
  tom: [span('tau', 0.08, 1.4, 0.12), span('noise', 0, 0.4, 0.04), span('click', 0, 1, 0.1), span('bend', 0, 8, 1)],
  piano: [
    span('slope', 0.2, 1.2, 0.08),
    span('stiffness', 0.00002, 0.0004, 0.00004),
    span('decay', 0.6, 5, 0.4),
    span('decayOrder', 0.4, 1.6, 0.15),
    span('hammer', 0.05, 0.7, 0.08),
    span('noise', 0, 0.2, 0.02),
  ],
  harp: [span('bodyHz', 80, 500, 40), span('disp', -0.4, 0.05, 0.06), span('loss', 0.96, 0.999, 0.008), span('lossLight', 0, 0.03, 0.004)],
  flute: windSpec(),
  clarinet: windSpec(),
  organ: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => span(`stops.${i}`, 0, 1.2, 0.08)),
  'electric-piano': [
    span('index', 0.2, 6, 0.5),
    span('indexLight', 0, 6, 0.5),
    span('envDecay', 0.15, 2.5, 0.25),
    span('indexDecay', 0.04, 0.8, 0.08),
    span('indexDecayLight', 0, 0.6, 0.06),
  ],
};
function barSpec() {
  return [
    span('decays.0', 0.15, 4, 0.35),
    span('decays.1', 0.04, 2.5, 0.15),
    span('decays.2', 0.02, 2, 0.12),
    span('decays.3', 0.02, 1.5, 0.08),
    span('gains.0', 0, 1.5, 0.12),
    span('gains.1', 0, 1, 0.08),
    span('gains.2', 0, 0.6, 0.05),
    span('pitchPow', 0.2, 2, 0.2),
    span('noise', 0, 0.9, 0.08),
    span('ratios.1', 1.5, 6, 0.25),
    span('ratios.2', 3, 14, 0.4),
  ];
}
function windSpec() {
  return [
    span('jet', 0.8, 2.2, 0.12),
    span('jetStrike', 0, 0.6, 0.06),
    span('even', 0, 0.5, 0.04),
    span('evenStrike', 0, 0.6, 0.06),
    span('evenMix', 0, 0.5, 0.05),
    span('evenMixStrike', 0, 0.4, 0.04),
    span('attack', 0.008, 0.08, 0.008),
    span('shimmerRms', 0, 0.08, 0.008),
    span('wanderCents', 0, 8, 0.6),
  ];
}

const specs = SPECS[instrument] || MODEL_SPECS[instrument] || (FAMILIES[instrument] ? familySpec(preset, FAMILIES[instrument]) : null);
if (!specs) throw new Error(`no parameter spec for ${instrument}`);

const catalog = JSON.parse(readFileSync(join(root, 'references/catalog.json'), 'utf8'));
const set = catalog.sets.find((s) => s.id === setId);
if (!set) throw new Error(`no catalog set ${setId}`);
let floor;
try {
  floor = JSON.parse(readFileSync(join(root, 'references/floor.json'), 'utf8')).metrics;
} catch {
  floor = undefined;
}

const notes = set.notes.map((note) => ({
  file: note.file || `${note.midi}_${note.size}.wav`,
  path: join(root, 'references/recorded', set.id, note.file && note.instrument ? note.file : `${note.midi}_${note.size}.wav`),
  midi: note.midi,
  size: note.size,
  split: note.split || 'valid',
  engine: set.engine,
  hue: set.hue,
  kind: set.kind,
  timing: noteTiming(set, note),
}));

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const start = {};
for (const spec of specs) {
  const cur = getPath(preset, spec.path);
  start[spec.path] = cur === undefined ? spec.start : cur;
}
const rounds = Number(process.env.FIT_ROUNDS || 4);
const workersN = Number(process.env.FIT_WORKERS || 4);

function chunk(list, n) {
  const out = Array.from({ length: n }, () => []);
  list.forEach((item, i) => out[i % n].push(item));
  return out.filter((c) => c.length);
}

const workers = chunk(notes, workersN).map((part) => {
  const worker = new Worker(new URL('./fit-worker.mjs', import.meta.url), {
    workerData: { instrument, model, notes: part, floor },
  });
  const ready = new Promise((resolve, reject) => {
    const onReady = (msg) => {
      if (msg.ready) {
        worker.off('message', onReady);
        resolve();
      }
    };
    worker.on('message', onReady);
    worker.on('error', reject);
  });
  return { worker, ready };
});
await Promise.all(workers.map((w) => w.ready));
console.log(`workers ready, ${notes.length} notes, ${rounds} rounds`);

function ask(worker, msg) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      worker.off('message', onMessage);
      reject(err);
    };
    const onMessage = (message) => {
      worker.off('error', onError);
      resolve(message);
    };
    worker.once('message', onMessage);
    worker.once('error', onError);
    worker.postMessage(msg);
  });
}

async function evaluate(values, clearRing, splits) {
  const parts = await Promise.all(workers.map((w) => ask(w.worker, { values, clearRing, splits, refHz: 55 })));
  const rows = parts.flatMap((p) => p.rows);
  const loss = rows.reduce((s, r) => s + r.excess + r.penalty, 0) / rows.length;
  return { loss, rows };
}

const meanExcess = (rows) => rows.reduce((s, r) => s + r.excess, 0) / rows.length;
const usesRing = specs.some((spec) => spec.path.startsWith('ring.'));
const beforeEval = await evaluate(start, usesRing, ['valid']);
const beforeHold = await evaluate(start, usesRing, ['test']);
console.log(
  `before fit excess ${meanExcess(beforeEval.rows).toFixed(3)}  holdout ${meanExcess(beforeHold.rows).toFixed(3)}  loss ${beforeEval.loss.toFixed(3)}`,
);

let best = { ...start };
let bestLoss = beforeEval.loss;
if (usesRing) {
  bestLoss = (await evaluate(best, false, ['valid'])).loss;
  console.log(`ring start loss ${bestLoss.toFixed(3)}`);
}

const clamp = (value, spec) => Math.min(spec.max, Math.max(spec.min, value));
for (let round = 0; round < rounds; round++) {
  for (const spec of specs) {
    const step = spec.step / 2 ** round;
    let moved = false;
    for (const dir of [1, -1]) {
      const value = clamp(best[spec.path] + dir * step, spec);
      if (Math.abs(value - best[spec.path]) < 1e-9) continue;
      const trial = { ...best, [spec.path]: value };
      const { loss } = await evaluate(trial, false, ['valid']);
      if (loss < bestLoss - 1e-4) {
        best = trial;
        bestLoss = loss;
        moved = true;
        console.log(`  r${round} ${spec.path} -> ${value.toFixed(4)}  loss ${loss.toFixed(3)}`);
        break;
      }
    }
    if (!moved) process.stdout.write('.');
  }
  console.log(`\nround ${round} loss ${bestLoss.toFixed(3)}`);
}

const fit = await evaluate(best, false, ['valid']);
const holdout = await evaluate(best, false, ['test']);
const report = {
  instrument,
  set: setId,
  rounds,
  before: {
    fitExcess: Number(meanExcess(beforeEval.rows).toFixed(3)),
    holdoutExcess: Number(meanExcess(beforeHold.rows).toFixed(3)),
    params: Object.fromEntries(specs.filter((s) => !s.path.startsWith('ring.')).map((s) => [s.path, start[s.path]])),
  },
  after: {
    fitExcess: Number(meanExcess(fit.rows).toFixed(3)),
    fitLoss: Number(fit.loss.toFixed(3)),
    holdoutExcess: Number(meanExcess(holdout.rows).toFixed(3)),
    holdoutLoss: Number(holdout.loss.toFixed(3)),
    params: usesRing ? { ...best, 'ring.refHz': 55 } : { ...best },
  },
  notes: [...fit.rows, ...holdout.rows].map((r) => ({
    file: r.file,
    split: r.split,
    midi: r.midi,
    size: r.size,
    excess: Number(r.excess.toFixed(3)),
    cents: r.cents === null ? null : Number(r.cents.toFixed(2)),
    clicks: r.clicks,
    worst: r.worst,
  })),
};
const outDir = join(root, 'references/fit');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${instrument}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(`fit excess ${report.before.fitExcess} -> ${report.after.fitExcess}`);
console.log(`holdout excess ${report.before.holdoutExcess} -> ${report.after.holdoutExcess}`);
console.log('wrote', outPath);
for (const w of workers) await w.worker.terminate();
