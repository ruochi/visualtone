import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeNote, compareTimbre, noteName } from '../dist/analysis/timbre.js';
import { render } from '../dist/renderer.js';
import { ScoreSchema } from '../dist/schema.js';
import { readWavFile } from '../dist/wav.js';

const root = new URL('..', import.meta.url).pathname;
const catalog = JSON.parse(readFileSync(join(root, 'references/catalog.json'), 'utf8'));
let floorMetrics;
try {
  floorMetrics = JSON.parse(readFileSync(join(root, 'references/floor.json'), 'utf8')).metrics;
} catch {
  floorMetrics = undefined;
}
const scaleOf = (id) => Math.max(1, floorMetrics?.[id] ?? 1);
const recorded = join(root, 'references/recorded');

function loadWav(path) {
  const wav = readWavFile(readFileSync(path));
  const n = wav.buffers[0].length;
  const mono = new Float32Array(n);
  for (const b of wav.buffers) for (let i = 0; i < n; i++) mono[i] += b[i] / wav.buffers.length;
  return { mono, sampleRate: wav.sampleRate };
}

function renderNote(engine, hue, midi, size, kind, seconds) {
  const hold = kind === 'sustain' ? Math.min(1.6, Math.max(0.8, seconds * 0.7)) : Math.min(0.45, Math.max(0.12, seconds * 0.35));
  const tail = kind === 'sustain' ? 0.45 : 1.1;
  const score = ScoreSchema.parse({
    sampleRate: 48000,
    seed: 1,
    duration: 0.05 + hold + tail,
    master: { loudness: -30, drive: 0 },
    tracks: [
      {
        id: 'n',
        hue,
        engine,
        channel: [0, 1],
        notes: [{ t: 0.05, y: midi, size, duration: hold, ease: 'hold' }],
      },
    ],
  });
  const stem = render(score, { stems: true }).stems[0];
  const mono = new Float32Array(stem.l.length);
  for (let i = 0; i < mono.length; i++) mono[i] = (stem.l[i] + stem.r[i]) * 0.5;
  return { mono, noteOff: 0.05 + hold, stop: 0.05 + hold + tail };
}

const want = new Set(process.argv.slice(2));
const report = [];
for (const set of catalog.sets) {
  if (!set.engine) continue;
  if (want.size && !want.has(set.id)) continue;
  const dir = join(recorded, set.id);
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.wav'));
  } catch {
    console.log(`skip ${set.id}: no recordings`);
    continue;
  }
  for (const file of files.sort()) {
    const m = file.match(/^(\d+)_([\d.]+)\.wav$/);
    if (!m) continue;
    const catalogMidi = Number(m[1]);
    const size = Number(m[2]);
    const refBuf = loadWav(join(dir, file));
    let ref = analyzeNote(refBuf.mono, refBuf.sampleRate, { midi: catalogMidi });
    let midi = catalogMidi;
    if (ref.f0Hz) {
      const sounded = 69 + 12 * Math.log2(ref.f0Hz / 440);
      const nearest = Math.round(sounded);
      // Some sample maps label a recording an octave away from the pitch it plays.
      // 0.55 semitone still catches a lock that sits ~45 cents off the nearest note.
      if (Math.abs(sounded - nearest) < 0.55 && Math.abs(nearest - catalogMidi) >= 6) midi = nearest;
    }
    if (midi !== catalogMidi) ref = analyzeNote(refBuf.mono, refBuf.sampleRate, { midi });
    const oursBuf = renderNote(set.engine, set.hue, midi, size, set.kind, refBuf.mono.length / refBuf.sampleRate);
    const ours = analyzeNote(oursBuf.mono, 48000, { midi, start: 0, stop: oursBuf.stop, noteOff: oursBuf.noteOff });
    const cmp = compareTimbre(ours, ref, floorMetrics);
    const worst = [...cmp.metrics].sort((a, b) => b.error / scaleOf(b.id) - a.error / scaleOf(a.id))[0];
    const row = {
      id: set.id,
      source: set.source,
      catalogMidi,
      midi,
      note: noteName(midi),
      size,
      distance: Number(cmp.distance.toFixed(2)),
      excess: cmp.excess === null ? null : Number(cmp.excess.toFixed(2)),
      passed: cmp.passed,
      total: cmp.total,
      oursCents: ours.centsOff,
      refCents: ref.centsOff,
      worst: worst ? `${worst.label} ${worst.error.toFixed(2)}` : '',
      life: Object.fromEntries(
        ['shimmer', 'flutter', 'pitch.jitter', 'brightnessLag']
          .map((id) => cmp.metrics.find((m) => m.id === id))
          .filter((m) => m && m.value !== null && m.ref !== null)
          .map((m) => [m.id, [Number(m.value.toFixed(1)), Number(m.ref.toFixed(1))]]),
      ),
    };
    report.push(row);
    console.log(
      `${set.id.padEnd(18)} ${row.note.padEnd(4)} @${size.toFixed(1)}  dist ${row.distance.toFixed(2)}  excess ${row.excess === null ? '-' : row.excess.toFixed(2)}  ${cmp.passed}/${cmp.total}  ${row.worst}`,
    );
  }
}

const bySet = new Map();
for (const row of report) {
  const g = bySet.get(row.id) || [];
  g.push(row);
  bySet.set(row.id, g);
}
const avg = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
console.log('\nmean distance, then excess over the real-vs-real floor (1 ≈ two takes of the same note)');
for (const [id, rows] of bySet) {
  const excess = rows.map((r) => r.excess).filter((v) => v !== null);
  console.log(`  ${id.padEnd(18)} ${avg(rows.map((r) => r.distance)).toFixed(2)}   excess ${excess.length ? avg(excess).toFixed(2) : '-'}  n=${rows.length}`);
}
console.log('\nshimmer, 8–20 Hz envelope modulation in dB (ours / recording; higher is livelier)');
for (const [id, rows] of bySet) {
  const xs = rows.map((r) => r.life?.shimmer).filter(Boolean);
  if (!xs.length) continue;
  console.log(`  ${id.padEnd(18)} ${avg(xs.map((p) => p[0])).toFixed(1)} / ${avg(xs.map((p) => p[1])).toFixed(1)}`);
}
writeFileSync(join(root, 'references/gap.json'), JSON.stringify({ ceiling: catalog.ceiling, rows: report }, null, 2) + '\n');
console.log('wrote references/gap.json');
