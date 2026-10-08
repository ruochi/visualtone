// Median compareTimbre error between two real recordings of the same note.
// TinySOL records some violin and cello notes on more than one string.
// That spread is natural variation, so a rendered note inside it is not a defect.
//
//   node scripts/measure-floor.mjs [path/to/TinySOL.tar.gz]
//
// Writes references/floor.json. The archive is not committed.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeNote, compareTimbre } from '../dist/analysis/timbre.js';
import { readWavFile } from '../dist/wav.js';

const root = new URL('..', import.meta.url).pathname;
const tar = process.argv[2] || '/tmp/refs/TinySOL.tar.gz';
const NAMES = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
const midiOf = (name) => {
  const m = name.match(/^([A-G]#?)(-?\d)$/);
  return 12 * (Number(m[2]) + 1) + NAMES[m[1]];
};

const listed = execFileSync('tar', ['-tzf', tar], { maxBuffer: 64e6 }).toString().trim().split('\n');
const groups = new Map();
for (const path of listed) {
  const base = path.split('/').pop();
  const m = base && base.match(/^(Vn|Vc)-ord-([A-G]#?-?\d)-(pp|mf|ff)-(\d+c)-.+\.wav$/);
  if (!m || !path.includes('/ordinario/')) continue;
  const key = `${m[1]}|${m[2]}|${m[3]}`;
  const g = groups.get(key) || [];
  g.push({ path, string: m[4], midi: midiOf(m[2]) });
  groups.set(key, g);
}
const wanted = [];
for (const g of groups.values()) if (new Set(g.map((x) => x.string)).size >= 2) wanted.push(...g);

const dir = mkdtempSync(join(tmpdir(), 'vt-floor-'));
execFileSync('tar', ['-xzf', tar, '-C', dir, ...wanted.map((w) => w.path)], { maxBuffer: 64e6 });

function load(path) {
  const wav = readWavFile(readFileSync(join(dir, path)));
  const n = wav.buffers[0].length;
  const mono = new Float32Array(n);
  for (const b of wav.buffers) for (let i = 0; i < n; i++) mono[i] += b[i] / wav.buffers.length;
  return analyzeNote(mono, wav.sampleRate, { midi: wanted.find((w) => w.path === path).midi });
}

const features = new Map();
for (const w of wanted) features.set(w.path, load(w.path));

const errors = new Map();
let pairs = 0;
for (const g of groups.values()) {
  const uniq = [];
  const seen = new Set();
  for (const w of g) if (!seen.has(w.string)) { seen.add(w.string); uniq.push(w); }
  for (let i = 0; i < uniq.length; i++) {
    for (let j = i + 1; j < uniq.length; j++) {
      pairs++;
      const cmp = compareTimbre(features.get(uniq[i].path), features.get(uniq[j].path));
      for (const metric of cmp.metrics) {
        const xs = errors.get(metric.id) || [];
        xs.push(metric.error);
        errors.set(metric.id, xs);
      }
    }
  }
}

const metrics = {};
const counts = {};
for (const [id, xs] of errors) {
  if (xs.length < 8) continue;
  const s = [...xs].sort((a, b) => a - b);
  metrics[id] = Number(s[s.length >> 1].toFixed(2));
  counts[id] = xs.length;
}
const floor = {
  source: 'TinySOL violin and cello, same pitch and dynamic, played on two different strings',
  pairs,
  metrics,
  counts,
};
writeFileSync(join(root, 'references/floor.json'), JSON.stringify(floor, null, 2) + '\n');
rmSync(dir, { recursive: true, force: true });
console.log(`pairs ${pairs}`);
for (const [id, v] of Object.entries(metrics).sort((a, b) => b[1] - a[1])) console.log(`  ${id.padEnd(16)} ${v.toFixed(2)}  n=${counts[id]}`);
console.log('wrote references/floor.json');
