import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TIMBRE_V1_IDS, analyzeNote, compareTimbre, metricExcess, noteName } from '../dist/analysis/timbre.js';
import { loadWav, noteTiming, recordedFile, scoreAgainst } from './lib/score-note.mjs';

const root = new URL('..', import.meta.url).pathname;
const catalog = JSON.parse(readFileSync(join(root, 'references/catalog.json'), 'utf8'));
let floorMetrics;
try {
  floorMetrics = JSON.parse(readFileSync(join(root, 'references/floor.json'), 'utf8')).metrics;
} catch {
  floorMetrics = undefined;
}
const scaleOf = (id) => Math.max(1, floorMetrics?.[id] ?? 1);
const v1Ids = new Set(TIMBRE_V1_IDS);
const recorded = join(root, 'references/recorded');

const want = new Set(process.argv.slice(2));
const report = [];
const baselines = [];
for (const set of catalog.sets) {
  if (!set.engine) continue;
  if (want.size && !want.has(set.id)) continue;
  const dir = join(recorded, set.id);
  const recordings = [];
  for (const note of set.notes || []) {
    const file = recordedFile(note);
    const path = join(dir, file);
    if (!existsSync(path)) {
      console.log(`skip ${set.id} ${file}: missing`);
      continue;
    }
    const timing = noteTiming(set, note);
    const catalogMidi = note.midi;
    const size = note.size;
    const instrument = note.instrument;
    const refBuf = loadWav(path);
    const refOpts = { midi: catalogMidi };
    if (timing?.hold !== undefined) refOpts.noteOff = timing.hold;
    let ref = analyzeNote(refBuf.mono, refBuf.sampleRate, refOpts);
    let midi = catalogMidi;
    if (ref.f0Hz) {
      const sounded = 69 + 12 * Math.log2(ref.f0Hz / 440);
      const nearest = Math.round(sounded);
      // Some sample maps label a recording an octave away from the pitch it plays.
      // 0.55 semitone still catches a lock that sits ~45 cents off the nearest note.
      if (Math.abs(sounded - nearest) < 0.55 && Math.abs(nearest - catalogMidi) >= 6) midi = nearest;
    }
    if (midi !== catalogMidi) {
      ref = analyzeNote(refBuf.mono, refBuf.sampleRate, { ...refOpts, midi });
    }
    if (instrument) recordings.push({ midi, size, instrument, features: ref });
    const scored = scoreAgainst(refBuf, set.engine, set.hue, midi, size, set.kind, timing, floorMetrics, ref);
    const { ours, cmp } = scored;
    const worst = [...cmp.metrics].sort((a, b) => b.error / scaleOf(b.id) - a.error / scaleOf(a.id))[0];
    const split = note.split;
    const row = {
      id: set.id,
      source: set.source,
      catalogMidi,
      midi,
      note: noteName(midi),
      size,
      ...(instrument ? { instrument } : {}),
      ...(split ? { split } : {}),
      distance: Number(cmp.distance.toFixed(2)),
      excess: cmp.excess === null ? null : Number(cmp.excess.toFixed(2)),
      excessV1: floorMetrics ? Number(metricExcess(cmp.metrics, floorMetrics, v1Ids)?.toFixed(2)) : null,
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
      `${set.id.padEnd(18)} ${row.note.padEnd(4)} @${size.toFixed(1)}  dist ${row.distance.toFixed(2)}  excess ${row.excess === null ? '-' : row.excess.toFixed(2)}  v1 ${row.excessV1 === null ? '-' : row.excessV1.toFixed(2)}  ${cmp.passed}/${cmp.total}  ${row.worst}`,
    );
  }
  const groups = new Map();
  for (const rec of recordings) {
    const key = `${rec.midi}@${rec.size}`;
    const group = groups.get(key) || [];
    group.push(rec);
    groups.set(key, group);
  }
  const pairDistance = [];
  const pairExcess = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const cmp = compareTimbre(group[i].features, group[j].features, floorMetrics);
        pairDistance.push(cmp.distance);
        if (cmp.excess !== null) pairExcess.push(cmp.excess);
      }
    }
  }
  if (pairDistance.length) {
    const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
    const baseline = {
      id: set.id,
      pairs: pairDistance.length,
      distance: Number(mean(pairDistance).toFixed(2)),
      excess: pairExcess.length ? Number(mean(pairExcess).toFixed(2)) : null,
    };
    baselines.push(baseline);
    console.log(`  real-vs-real ${set.id}: ${baseline.pairs} pairs  excess ${baseline.excess}`);
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
  const v1 = rows.map((r) => r.excessV1).filter((v) => v !== null);
  console.log(
    `  ${id.padEnd(18)} ${avg(rows.map((r) => r.distance)).toFixed(2)}   excess ${excess.length ? avg(excess).toFixed(2) : '-'}  v1 ${v1.length ? avg(v1).toFixed(2) : '-'}  n=${rows.length}`,
  );
  for (const split of ['valid', 'test']) {
    const part = rows.filter((r) => r.split === split && r.excess !== null);
    if (part.length) console.log(`    ${split.padEnd(16)} excess ${avg(part.map((r) => r.excess)).toFixed(2)}  n=${part.length}`);
  }
}
console.log('\nshimmer, 8–20 Hz envelope modulation in dB (ours / recording; higher is livelier)');
for (const [id, rows] of bySet) {
  const xs = rows.map((r) => r.life?.shimmer).filter(Boolean);
  if (!xs.length) continue;
  console.log(`  ${id.padEnd(18)} ${avg(xs.map((p) => p[0])).toFixed(1)} / ${avg(xs.map((p) => p[1])).toFixed(1)}`);
}
writeFileSync(
  join(root, 'references/gap.json'),
  JSON.stringify({ ceiling: catalog.ceiling, ...(baselines.length ? { baselines } : {}), rows: report }, null, 2) + '\n',
);
console.log('wrote references/gap.json');
