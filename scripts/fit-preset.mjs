// Fit one harmonic preset to a catalog set. The fit split is optimized; the test split is held out.
// Usage: node scripts/fit-preset.mjs <instrument> <set-id>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { HARMONIC_PRESETS } from '../dist/engines/harmonic.js';

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

const specs = SPECS[instrument];
if (!specs) throw new Error(`no parameter spec for ${instrument}`);
const preset = HARMONIC_PRESETS[instrument];
if (!preset) throw new Error(`${instrument} is not a harmonic preset`);

const catalog = JSON.parse(readFileSync(join(root, 'references/catalog.json'), 'utf8'));
const set = catalog.sets.find((s) => s.id === setId);
if (!set) throw new Error(`no catalog set ${setId}`);
let floor;
try {
  floor = JSON.parse(readFileSync(join(root, 'references/floor.json'), 'utf8')).metrics;
} catch {
  floor = undefined;
}

const timing = set.hold !== undefined ? { hold: set.hold, tail: set.tail ?? 1 } : undefined;
const notes = set.notes.map((note) => ({
  file: note.file,
  path: join(root, 'references/recorded', set.id, note.file),
  midi: note.midi,
  size: note.size,
  split: note.split || 'valid',
  engine: set.engine,
  hue: set.hue,
  kind: set.kind,
  timing,
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
    workerData: { instrument, notes: part, floor },
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
const beforeEval = await evaluate(start, true, ['valid']);
console.log(`before fit excess ${meanExcess(beforeEval.rows).toFixed(3)}  loss ${beforeEval.loss.toFixed(3)}`);

let best = { ...start };
let bestLoss = (await evaluate(best, false, ['valid'])).loss;
console.log(`ring start loss ${bestLoss.toFixed(3)}`);

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
    params: Object.fromEntries(specs.filter((s) => !s.path.startsWith('ring.')).map((s) => [s.path, start[s.path]])),
  },
  after: {
    fitExcess: Number(meanExcess(fit.rows).toFixed(3)),
    fitLoss: Number(fit.loss.toFixed(3)),
    holdoutExcess: Number(meanExcess(holdout.rows).toFixed(3)),
    holdoutLoss: Number(holdout.loss.toFixed(3)),
    params: { ...best, 'ring.refHz': 55 },
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
console.log(`holdout excess ${report.after.holdoutExcess}`);
console.log('wrote', outPath);
for (const w of workers) await w.worker.terminate();
