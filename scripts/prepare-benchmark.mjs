// Expand TinySOL sets to 6 pitches × pp/mf/ff and mark a pitch holdout.
// The highest selected pitch (every dynamic) is test; the rest are valid.
// Multi-pitch strike sets keep their notes and gain the same split.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const catalogPath = join(root, 'references/catalog.json');
const metaPath = process.env.TINYSOL_META || '/tmp/refs/TinySOL_metadata.csv';
const SIZE = { pp: 0.3, mf: 0.6, ff: 0.9 };
const DYNS = ['pp', 'mf', 'ff'];

const INSTRUMENT = {
  'tinysol-flute': 'Flute',
  'tinysol-clarinet': 'Clarinet in Bb',
  'tinysol-violin': 'Violin',
  'tinysol-viola': 'Viola',
  'tinysol-cello': 'Cello',
  'tinysol-trumpet': 'Trumpet in C',
  'tinysol-horn': 'French Horn',
  'tinysol-trombone': 'Trombone',
  'tinysol-sax': 'Alto Saxophone',
  'tinysol-bass': 'Contrabass',
  'tinysol-tuba': 'Bass Tuba',
  'tinysol-oboe': 'Oboe',
  'tinysol-bassoon': 'Bassoon',
};

function parseMeta(text) {
  const lines = text.trim().split(/\n/);
  const head = lines[0].split(',').map((h) => h.trim());
  const idx = Object.fromEntries(head.map((h, i) => [h, i]));
  const rows = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    if (c[idx['Technique (abbr.)']] !== 'ord') continue;
    rows.push({
      path: c[idx.Path],
      instrument: c[idx['Instrument (in full)']],
      pitch: Number(c[idx['Pitch ID']]),
      dyn: c[idx.Dynamics],
      instance: Number(c[idx['Instance ID']]),
      string: c[idx['String ID (if applicable)']] || '',
      retune: c[idx['Needed digital retuning']].trim() === 'TRUE',
    });
  }
  return rows;
}

function evenly(sorted, n) {
  if (sorted.length <= n) return sorted.slice();
  const out = [];
  for (let i = 0; i < n; i++) out.push(sorted[Math.round((i * (sorted.length - 1)) / (n - 1))]);
  return [...new Set(out)];
}

function pitchWindow(existing, qualified) {
  let lo = Math.min(...existing);
  let hi = Math.max(...existing);
  const qmin = qualified[0];
  const qmax = qualified[qualified.length - 1];
  if (hi - lo < 17 || existing.length < 4) {
    const mid = (lo + hi) / 2;
    lo = Math.max(qmin, Math.round(mid - 12));
    hi = Math.min(qmax, Math.round(mid + 12));
    if (hi - lo < 17) {
      if (lo <= qmin) hi = Math.min(qmax, lo + 24);
      else lo = Math.max(qmin, hi - 24);
    }
  }
  const pool = qualified.filter((p) => p >= lo && p <= hi);
  return pool.length >= 4 ? pool : qualified;
}

function notesFor(rows, instrument, existingMidis) {
  const mine = rows.filter((r) => r.instrument === instrument);
  const byPitch = new Map();
  for (const row of mine) {
    if (!DYNS.includes(row.dyn)) continue;
    if (!byPitch.has(row.pitch)) byPitch.set(row.pitch, []);
    byPitch.get(row.pitch).push(row);
  }
  const qualified = [];
  const chosen = new Map();
  for (const [pitch, list] of [...byPitch.entries()].sort((a, b) => a[0] - b[0])) {
    const strings = new Set(list.filter((r) => r.dyn === 'pp').map((r) => r.string));
    for (const dyn of DYNS) {
      const have = new Set(list.filter((r) => r.dyn === dyn).map((r) => r.string));
      for (const s of [...strings]) if (!have.has(s)) strings.delete(s);
    }
    if (!strings.size) continue;
    const string = [...strings].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
    const files = {};
    for (const dyn of DYNS) {
      const hit = list
        .filter((r) => r.dyn === dyn && r.string === string)
        .sort((a, b) => Number(a.retune) - Number(b.retune) || a.instance - b.instance || a.path.localeCompare(b.path))[0];
      files[dyn] = hit.path;
    }
    qualified.push(pitch);
    chosen.set(pitch, files);
  }
  const window = pitchWindow(existingMidis, qualified);
  const pitches = evenly(window, 6);
  const holdout = Math.max(...pitches);
  const notes = [];
  for (const pitch of pitches) {
    for (const dyn of DYNS) {
      notes.push({
        midi: pitch,
        size: SIZE[dyn],
        dynamics: dyn,
        archive: chosen.get(pitch)[dyn],
        split: pitch === holdout ? 'test' : 'valid',
      });
    }
  }
  return notes;
}

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const rows = parseMeta(readFileSync(metaPath, 'utf8'));

for (const set of catalog.sets) {
  const instrument = INSTRUMENT[set.id];
  if (instrument) {
    const existing = [...new Set(set.notes.map((n) => n.midi))];
    set.notes = notesFor(rows, instrument, existing);
    console.log(
      set.id,
      set.notes.length,
      'pitches',
      [...new Set(set.notes.map((n) => n.midi))].join(','),
      'holdout',
      set.notes.find((n) => n.split === 'test').midi,
    );
    continue;
  }
  if (set.id.startsWith('nsynth-')) continue;
  const midis = [...new Set(set.notes.map((n) => n.midi))];
  if (midis.length < 2) continue;
  const holdout = Math.max(...midis);
  for (const note of set.notes) note.split = note.midi === holdout ? 'test' : 'valid';
  console.log(set.id, 'split holdout', holdout, 'n=' + set.notes.length);
}

writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
console.log('wrote', catalogPath);
