// Pull one more NSynth family into the catalog. Valid notes are the fit split; test notes are held out.
// Usage: node scripts/fetch-nsynth-set.mjs vibraphone|electric-piano
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const cache = process.env.NSYNTH_DIR || '/tmp/refs';
const EXCLUDE = new Set(['reverb', 'tempo-synced', 'distortion', 'nonlinear_env', 'multiphonic']);
const VELOCITIES = [50, 100, 127];

const JOBS = {
  vibraphone: {
    id: 'nsynth-vibraphone',
    family: 'mallet',
    source: 'acoustic',
    pitchMin: 53,
    pitchMax: 96,
    instruments: 1,
    engine: 'marimba',
    hue: 240,
    kind: 'strike',
    credit: 'NSynth mallet, dry notes from mallet_acoustic_056. Engel et al. 2017, CC BY 4.0.',
  },
  'electric-piano': {
    id: 'nsynth-electric-piano',
    family: 'keyboard',
    source: 'electronic',
    pitchMin: 48,
    pitchMax: 84,
    instruments: 3,
    engine: 'epiano',
    hue: 0,
    kind: 'sustain',
    credit: 'NSynth electronic keyboards. Engel et al. 2017, CC BY 4.0.',
  },
};

const job = JOBS[process.argv[2]];
if (!job) {
  console.error('usage: node scripts/fetch-nsynth-set.mjs vibraphone|electric-piano');
  process.exit(1);
}

const SPLITS = ['valid', 'test'];

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 6).join(' ')}\n${r.stderr || r.stdout}`);
  return r.stdout;
}

function evenly(sorted, n) {
  if (sorted.length <= n) return sorted.slice();
  const out = [];
  for (let i = 0; i < n; i++) out.push(sorted[Math.round((i * (sorted.length - 1)) / (n - 1))]);
  return [...new Set(out)];
}

function loadExamples(split) {
  const jsonPath = join(cache, 'nsynth', `nsynth-${split}`, 'examples.json');
  return JSON.parse(readFileSync(jsonPath, 'utf8'));
}

function candidates(examples) {
  const byInstrument = new Map();
  for (const [noteStr, ex] of Object.entries(examples)) {
    if (ex.instrument_family_str !== job.family || ex.instrument_source_str !== job.source) continue;
    if ((ex.qualities_str || []).some((q) => EXCLUDE.has(q))) continue;
    if (ex.pitch < job.pitchMin || ex.pitch > job.pitchMax || !VELOCITIES.includes(ex.velocity)) continue;
    if (!byInstrument.has(ex.instrument_str)) byInstrument.set(ex.instrument_str, []);
    byInstrument.get(ex.instrument_str).push({ noteStr, ex });
  }
  return byInstrument;
}

const bySplit = Object.fromEntries(SPLITS.map((split) => [split, candidates(loadExamples(split))]));
const shared = [...bySplit.valid.keys()].filter((id) => bySplit.test.has(id));
shared.sort((a, b) => bySplit.valid.get(b).length - bySplit.valid.get(a).length);
const instruments = shared.slice(0, job.instruments);
if (!instruments.length) throw new Error(`no ${job.family} ${job.source} instruments in both splits`);
console.log('instruments', instruments.join(', '));

const recorded = join(root, 'references/recorded', job.id);
mkdirSync(recorded, { recursive: true });
const chosen = [];
for (const split of SPLITS) {
  const archive = join(cache, `nsynth-${split}.jsonwav.tar.gz`);
  const pending = [];
  for (const instrument of instruments) {
    const notes = bySplit[split].get(instrument);
    const byPitch = new Map();
    for (const note of notes) {
      if (!byPitch.has(note.ex.pitch)) byPitch.set(note.ex.pitch, []);
      byPitch.get(note.ex.pitch).push(note);
    }
    const full = [...byPitch.entries()]
      .filter(([, list]) => VELOCITIES.every((v) => list.some((n) => n.ex.velocity === v)))
      .map(([pitch]) => pitch)
      .sort((a, b) => a - b);
    const pitches = evenly(full.length >= 4 ? full : [...byPitch.keys()].sort((a, b) => a - b), 5);
    for (const pitch of pitches) {
      for (const note of byPitch.get(pitch)) {
        if (!VELOCITIES.includes(note.ex.velocity)) continue;
        const size = Number((note.ex.velocity / 127).toFixed(3));
        const wavName = `${note.ex.pitch}_${size.toFixed(3)}_${instrument}.wav`;
        const dest = join(recorded, wavName);
        const item = { split, instrument, size, wavName, dest, noteStr: note.noteStr, ex: note.ex };
        chosen.push(item);
        if (existsSync(dest) && statSync(dest).size > 1000) continue;
        pending.push(item);
      }
    }
  }
  if (!pending.length) continue;
  const tmp = join(cache, `nsynth-pick-${job.id}-${split}`);
  mkdirSync(tmp, { recursive: true });
  const members = pending.map((n) => `nsynth-${split}/audio/${n.noteStr}.wav`);
  run('tar', ['-xzf', archive, '-C', tmp, ...members]);
  for (const note of pending) renameSync(join(tmp, `nsynth-${split}/audio/${note.noteStr}.wav`), note.dest);
  run('rm', ['-rf', tmp]);
  console.log(split, 'extracted', pending.length);
}

const catalogPath = join(root, 'references/catalog.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const set = {
  id: job.id,
  source: 'NSynth',
  license: 'CC-BY-4.0',
  url: 'https://magenta.tensorflow.org/datasets/nsynth',
  credit: job.credit,
  engine: job.engine,
  hue: job.hue,
  kind: job.kind,
  hold: 3,
  tail: 1,
  notes: chosen
    .sort((a, b) => a.split.localeCompare(b.split) || a.instrument.localeCompare(b.instrument) || a.ex.pitch - b.ex.pitch || a.ex.velocity - b.ex.velocity)
    .map((note) => ({
      midi: note.ex.pitch,
      size: note.size,
      velocity: note.ex.velocity,
      split: note.split,
      instrument: note.instrument,
      file: note.wavName,
    })),
};
catalog.sets = catalog.sets.filter((s) => s.id !== job.id);
catalog.sets.push(set);
writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
console.log(`wrote ${set.notes.length} notes into ${job.id}`);
