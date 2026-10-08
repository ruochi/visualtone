// Pull dry electronic-bass notes out of the NSynth valid and test archives.
// WAV files stay under references/recorded and out of git. The catalog set is rewritten each run.
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const root = new URL('..', import.meta.url).pathname;
const cache = process.env.NSYNTH_DIR || '/tmp/refs';
const recorded = join(root, 'references/recorded/nsynth-electric-bass');
const SET_ID = 'nsynth-electric-bass';
const EXCLUDE = new Set(['reverb', 'tempo-synced', 'distortion', 'nonlinear_env', 'multiphonic']);
const VELOCITIES = [50, 100, 127];
const PITCHES = 5;

const SPLITS = [
  {
    split: 'valid',
    file: 'nsynth-valid.jsonwav.tar.gz',
    url: 'http://download.magenta.tensorflow.org/datasets/nsynth/nsynth-valid.jsonwav.tar.gz',
    bytes: 1068767009,
  },
  {
    split: 'test',
    file: 'nsynth-test.jsonwav.tar.gz',
    url: 'http://download.magenta.tensorflow.org/datasets/nsynth/nsynth-test.jsonwav.tar.gz',
    bytes: 349501546,
  },
];

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 4).join(' ')}\n${r.stderr || r.stdout}`);
  return r.stdout;
}

async function ensureArchive(spec) {
  const dest = join(cache, spec.file);
  if (existsSync(dest) && statSync(dest).size === spec.bytes) return dest;
  mkdirSync(cache, { recursive: true });
  console.log('downloading', spec.file);
  const res = await fetch(spec.url);
  if (!res.ok) throw new Error(`${res.status} ${spec.url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  return dest;
}

function evenly(sorted, n) {
  if (sorted.length <= n) return sorted.slice();
  const out = [];
  for (let i = 0; i < n; i++) out.push(sorted[Math.round((i * (sorted.length - 1)) / (n - 1))]);
  return [...new Set(out)];
}

function select(examples, split) {
  const byInstrument = new Map();
  for (const [noteStr, ex] of Object.entries(examples)) {
    if (ex.instrument_family_str !== 'bass' || ex.instrument_source_str !== 'electronic') continue;
    if ((ex.qualities_str || []).some((q) => EXCLUDE.has(q))) continue;
    if (ex.pitch < 28 || ex.pitch > 57 || !VELOCITIES.includes(ex.velocity)) continue;
    if (!byInstrument.has(ex.instrument_str)) byInstrument.set(ex.instrument_str, []);
    byInstrument.get(ex.instrument_str).push({ noteStr, ex });
  }
  const chosen = [];
  for (const [instrument, notes] of [...byInstrument.entries()].sort()) {
    const byPitch = new Map();
    for (const note of notes) {
      if (!byPitch.has(note.ex.pitch)) byPitch.set(note.ex.pitch, []);
      byPitch.get(note.ex.pitch).push(note);
    }
    const full = [...byPitch.entries()]
      .filter(([, list]) => VELOCITIES.every((v) => list.some((n) => n.ex.velocity === v)))
      .map(([pitch]) => pitch)
      .sort((a, b) => a - b);
    const pitches = evenly(full.length ? full : [...byPitch.keys()].sort((a, b) => a - b), PITCHES);
    for (const pitch of pitches) {
      for (const note of byPitch.get(pitch)) chosen.push({ split, instrument, ...note });
    }
  }
  return chosen;
}

const chosen = [];
for (const spec of SPLITS) {
  const archive = await ensureArchive(spec);
  const jsonName = `nsynth-${spec.split}/examples.json`;
  const jsonPath = join(cache, 'nsynth', jsonName);
  if (!existsSync(jsonPath)) {
    mkdirSync(dirname(jsonPath), { recursive: true });
    run('tar', ['-xzf', archive, '-C', join(cache, 'nsynth'), jsonName]);
  }
  const examples = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const picked = select(examples, spec.split);
  console.log(spec.split, 'notes', picked.length, 'instruments', new Set(picked.map((p) => p.instrument)).size);
  const tmp = join(cache, `nsynth-pick-${spec.split}`);
  mkdirSync(tmp, { recursive: true });
  const pending = [];
  for (const note of picked) {
    const size = Number((note.ex.velocity / 127).toFixed(3));
    const wavName = `${note.ex.pitch}_${size.toFixed(3)}_${note.instrument}.wav`;
    const dest = join(recorded, wavName);
    note.size = size;
    note.wavName = wavName;
    note.dest = dest;
    note.member = `nsynth-${spec.split}/audio/${note.noteStr}.wav`;
    if (existsSync(dest) && statSync(dest).size > 1000) continue;
    pending.push(note);
  }
  if (pending.length) {
    run('tar', ['-xzf', archive, '-C', tmp, ...pending.map((n) => n.member)]);
    mkdirSync(recorded, { recursive: true });
    for (const note of pending) renameSync(join(tmp, note.member), note.dest);
    run('rm', ['-rf', tmp]);
  }
  chosen.push(...picked);
}

const catalogPath = join(root, 'references/catalog.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const set = {
  id: SET_ID,
  source: 'NSynth',
  license: 'CC-BY-4.0',
  url: 'https://magenta.tensorflow.org/datasets/nsynth',
  credit:
    'Engel et al., Neural Audio Synthesis of Musical Notes with WaveNet Autoencoders, 2017. The notes were rendered from commercial sample libraries and released by Google under CC BY 4.0.',
  engine: 'bass',
  hue: 270,
  kind: 'sustain',
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
catalog.sets = catalog.sets.filter((s) => s.id !== SET_ID);
catalog.sets.push(set);
writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
console.log(`wrote ${set.notes.length} notes into ${SET_ID}`);
