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
const positionals = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const picture = process.argv.includes('--picture');
const instrument = positionals[0];
const setId = positionals[1];
if (!instrument || !setId) {
  console.error('usage: node scripts/fit-preset.mjs <instrument> <set-id> [--picture]');
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
const model = positionals[2] || MODEL_OF[instrument] || 'harmonic';
const preset = TABLES[model]?.[instrument];
if (!preset) throw new Error(`${instrument} is not a ${model} preset`);

function span(path, min, max, step, start) {
  return { path, min, max, step, ...(start === undefined ? {} : { start }) };
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

function pictureSpec(preset) {
  const specs = [
    span('slope.base', 0.04, 0.55, 0.05),
    span('slope.soft', 0, 0.55, 0.06),
    span('noise.direct', 0, 0.55, 0.05, 0),
    span('noise.directHz', 800, 6000, 700),
    span('noise.level', 0, 0.16, 0.02),
    span('life.vibratoCents', 0, 24, 1.5),
    span('life.shimmerRms', 0, 0.06, 0.01),
    span('resonance.mix', 0, 0.45, 0.05),
    span('resonance.hz', 60, 800, 70),
  ];
  if (preset.lowpass) specs.push(span('lowpass.hz', 2800, 14000, 1200));
  if (preset.body) {
    specs.push(
      span('body.count', 16, 480, 32),
      span('body.qLo', 16, 140, 8),
      span('body.qHi', 40, 220, 12),
      span('body.db', 1, 16, 1),
      span('life.vibratoDepthJitter', 0, 0.2, 0.04),
      span('life.vibratoRateJitter', 0, 0.15, 0.03),
    );
  }
  // High notes sit on vibratoHighCents. The holdout is up there, and partials only
  // wobble when that depth is wide enough to cross a body peak.
  if (preset.life?.vibratoHighCents !== undefined) specs.push(span('life.vibratoHighCents', 0, 28, 2));
  return specs;
}

const specs = picture
  ? pictureSpec(preset)
  : SPECS[instrument] || MODEL_SPECS[instrument] || (FAMILIES[instrument] ? familySpec(preset, FAMILIES[instrument]) : null);
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
    workerData: { instrument, model, notes: part, floor, picture },
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
  const loss = rows.reduce((s, r) => s + (picture ? r.picture : r.excess) + r.penalty, 0) / rows.length;
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

if (picture && preset.body) best['body.seed'] = Math.round(preset.body.seed ?? 1);

const clamp = (value, spec) => Math.min(spec.max, Math.max(spec.min, value));
async function descend(fromRound, toRound) {
  for (let round = fromRound; round < toRound; round++) {
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
}

const warm = process.env.FIT_WARM === '1';
if (warm) {
  try {
    const saved = JSON.parse(readFileSync(join(root, 'references/fit', `${instrument}.json`), 'utf8'));
    const params = saved.followup?.body?.params;
    if (params) {
      best = { ...best, ...params };
      bestLoss = (await evaluate(best, false, ['valid'])).loss;
      console.log(`warm start loss ${bestLoss.toFixed(3)}`);
    }
  } catch (err) {
    console.log(`warm start skipped: ${err.message}`);
  }
} else if (process.env.FIT_DENSE !== '1') {
  await descend(0, rounds);
}
if (process.env.FIT_DENSE === '1' && preset.body) {
  best['body.count'] = 320;
  best['body.qLo'] = 50;
  best['body.qHi'] = 160;
  best['body.db'] = 3;
  bestLoss = (await evaluate(best, false, ['valid'])).loss;
  console.log(`forced dense loss ${bestLoss.toFixed(3)}`);
  await descend(0, 2);
}

// Sparse peaks leave most partials on a flat stretch, so vibrato does not move them.
// These corners pack narrow peaks densely enough that the median partial sits on a slope.
let bodyMoved = false;
if (picture && preset.body && best['body.db'] !== undefined) {
  const countSpec = specs.find((s) => s.path === 'body.count');
  const qLoSpec = specs.find((s) => s.path === 'body.qLo');
  const qHiSpec = specs.find((s) => s.path === 'body.qHi');
  const dbSpec = specs.find((s) => s.path === 'body.db');
  const corners = [
    [160, 40, 120, 4],
    [320, 50, 160, 3],
    [320, 60, 180, 5],
    [240, 30, 100, 6],
    [480, 80, 200, 4],
    [80, 24, 90, 10],
  ];
  for (const [count, qLo, qHi, db] of corners) {
    const trial = {
      ...best,
      'body.count': clamp(count, countSpec),
      'body.qLo': clamp(qLo, qLoSpec),
      'body.qHi': clamp(qHi, qHiSpec),
      'body.db': clamp(db, dbSpec),
    };
    const { loss } = await evaluate(trial, false, ['valid']);
    if (loss < bestLoss - 1e-4) {
      best = trial;
      bestLoss = loss;
      bodyMoved = true;
      console.log(
        `  dense count ${trial['body.count']} q ${trial['body.qLo']}-${trial['body.qHi']} db ${trial['body.db']}  loss ${loss.toFixed(3)}`,
      );
    } else process.stdout.write('.');
  }
  console.log(
    `\ndense body loss ${bestLoss.toFixed(3)} count ${best['body.count']} q ${best['body.qLo']}-${best['body.qHi']} db ${best['body.db']}`,
  );
}

// Peak locations matter once the peaks are steep. Search seeds on that shape, then retune.
if (picture && preset.body) {
  const seedBefore = best['body.seed'];
  let seedLoss = bestLoss;
  for (let seed = 1; seed <= 24; seed++) {
    const trial = { ...best, 'body.seed': seed };
    const { loss } = await evaluate(trial, false, ['valid']);
    if (loss < seedLoss - 1e-4) {
      best = trial;
      bestLoss = loss;
      seedLoss = loss;
      console.log(`  body.seed -> ${seed}  loss ${loss.toFixed(3)}`);
    } else process.stdout.write('.');
  }
  console.log(`\nbody seed ${best['body.seed']} loss ${bestLoss.toFixed(3)}`);
  if (bodyMoved) await descend(1, 3);
  else if (best['body.seed'] !== seedBefore) await descend(rounds - 1, rounds);
}

if (best['body.count'] !== undefined) best['body.count'] = Math.round(best['body.count']);
if (best['body.seed'] !== undefined) best['body.seed'] = Math.round(best['body.seed']);
const fit = await evaluate(best, false, ['valid']);
const holdout = await evaluate(best, false, ['test']);
const params = usesRing ? { ...best, 'ring.refHz': 55 } : { ...best };
const noteRows = [...fit.rows, ...holdout.rows].map((r) => ({
  file: r.file,
  split: r.split,
  midi: r.midi,
  size: r.size,
  excess: Number(r.excess.toFixed(3)),
  cents: r.cents === null ? null : Number(r.cents.toFixed(2)),
  clicks: r.clicks,
  worst: r.worst,
}));
const outDir = join(root, 'references/fit');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${instrument}.json`);
let previous = null;
try {
  previous = JSON.parse(readFileSync(outPath, 'utf8'));
} catch {
  previous = null;
}
const run = {
  why: 'Dynamic body: seeded narrow peaks plus the old modes, looked up from each partial’s instantaneous frequency. Vibrato no longer lifts every partial together. Seed 1..24 picked on the valid split.',
  rounds,
  fitExcess: Number(meanExcess(fit.rows).toFixed(3)),
  fitLoss: Number(fit.loss.toFixed(3)),
  holdoutExcess: Number(meanExcess(holdout.rows).toFixed(3)),
  holdoutLoss: Number(holdout.loss.toFixed(3)),
  params,
  notes: noteRows,
};
// A picture fit of an instrument that already has a record appends under followup.body
// so the earlier before/after numbers stay comparable.
const report =
  previous && picture && preset.body
    ? { ...previous, followup: { ...(previous.followup ?? {}), body: run } }
    : {
        instrument,
        set: setId,
        rounds,
        before: {
          fitExcess: Number(meanExcess(beforeEval.rows).toFixed(3)),
          holdoutExcess: Number(meanExcess(beforeHold.rows).toFixed(3)),
          params: Object.fromEntries(specs.filter((s) => !s.path.startsWith('ring.')).map((s) => [s.path, start[s.path]])),
        },
        after: {
          fitExcess: run.fitExcess,
          fitLoss: run.fitLoss,
          holdoutExcess: run.holdoutExcess,
          holdoutLoss: run.holdoutLoss,
          params,
        },
        notes: noteRows,
      };
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
const shown = report.followup?.body ?? report.after;
console.log(
  `valid excess ${meanExcess(beforeEval.rows).toFixed(3)} -> ${shown.fitExcess}  loss ${beforeEval.loss.toFixed(3)} -> ${shown.fitLoss}`,
);
console.log(
  `holdout excess ${meanExcess(beforeHold.rows).toFixed(3)} -> ${shown.holdoutExcess}  loss ${shown.holdoutLoss}`,
);
console.log('wrote', outPath);
for (const w of workers) await w.worker.terminate();
