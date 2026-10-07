import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeNote, compareTimbre, noteName, timbreToJson, type NoteFeatures, type TimbreComparison } from './analysis/timbre.js';
import { loadScoreFile } from './load-score.js';
import { DEFAULT_PITCHES, DEFAULT_SIZES, probeTrack } from './probe.js';
import { render } from './renderer.js';
import { readWavFile, writeWavFile } from './wav.js';

function flag(name: string, args: string[]): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function num(name: string, args: string[]): number | undefined {
  const v = flag(name, args);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} 需要一个数字，收到 "${v}"`);
  return n;
}

function list(name: string, args: string[]): number[] | undefined {
  const v = flag(name, args);
  return v === undefined ? undefined : v.split(',').map(Number).filter(Number.isFinite);
}

function monoWav(path: string): { mono: Float32Array; sampleRate: number } {
  const wav = readWavFile(readFileSync(path));
  const n = wav.buffers[0].length;
  const mono = new Float32Array(n);
  for (const b of wav.buffers) for (let i = 0; i < n; i++) mono[i] += b[i] / wav.buffers.length;
  return { mono, sampleRate: wav.sampleRate };
}

const f1 = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '-' : v.toFixed(d));

export function printFeatures(f: NoteFeatures): void {
  const e = f.envelope;
  const s = f.spectrum;
  const h = f.harmonics;
  const pitch = f.f0Hz ? `${f.f0Hz.toFixed(2)} Hz (${noteName(69 + 12 * Math.log2(f.f0Hz / 440))}${f.centsOff === null ? '' : ` ${f.centsOff >= 0 ? '+' : ''}${f.centsOff.toFixed(1)} cents`})` : '-';
  console.log(
    `pitch     ${pitch}  std ${f1(f.pitch.stdCents)}  drift ${f1(f.pitch.driftCents)}  glide ${f1(f.pitch.glideCents)}  ` +
      `vibrato ${f.pitch.vibratoRateHz === null ? '-' : `${f.pitch.vibratoRateHz.toFixed(2)} Hz ±${f1(f.pitch.vibratoDepthCents)} cents`}`,
  );
  console.log(
    `envelope  attack ${f1(e.attackMs)} ms  peak ${f1(e.peakMs)} ms  decay ${f1(e.decayDbPerSec)} dB/s ` +
      `(early ${f1(e.earlyDecayDbPerSec)}, late ${f1(e.lateDecayDbPerSec)})  T60 ${f1(e.t60Sec, 2)} s  release ${f1(e.releaseMs, 0)} ms`,
  );
  console.log(`          ${e.curve.map((p) => `${p.tMs}ms ${f1(p.db)}`).join('  ')}`);
  console.log(
    `bright    centroid ${f1(s.centroidHz, 0)} Hz (${f1(s.brightness, 2)}× f0)  attack ${f1(s.centroidAttackHz, 0)}  sustain ${f1(s.centroidSustainHz, 0)}  ` +
      `rolloff ${f1(s.rolloffHz, 0)}  flatness ${f1(s.flatnessAttack, 3)} / ${f1(s.flatnessSustain, 3)}`,
  );
  console.log(`partials  ${h.amplitudesDb.map((v) => f1(v)).join(' ')}`);
  console.log(
    `          slope ${f1(h.slopeDbPerOct)} dB/oct  odd/even ${f1(h.oddEvenDb)} dB  B ${h.inharmonicity === null ? '-' : h.inharmonicity.toExponential(2)}  ` +
      `HNR ${f1(h.hnrDb)} dB  spurious ${f1(h.spuriousDb)} dB`,
  );
  console.log(`decay/n   ${h.decayDbPerSec.map((v) => f1(v)).join(' ')} dB/s`);
  console.log(`peaks     ${f.peaks.map((p) => (p.ratio === null ? `${p.hz.toFixed(0)}Hz` : `${p.ratio.toFixed(3)}`) + `(${p.db.toFixed(0)})`).join(' ')}`);
  console.log(`artifacts clicks ${f.artifacts.clicks}  dc ${f.artifacts.dcOffset.toFixed(4)}  non-finite ${f.artifacts.nonFinite}`);
}

export function printComparison(c: TimbreComparison): void {
  console.log(`\n对比参照：通过 ${c.passed}/${c.total}，距离 ${c.distance.toFixed(2)}（0 = 一样）`);
  for (const m of [...c.metrics].sort((a, b) => b.error - a.error)) {
    const mark = m.error <= 1 ? 'ok ' : m.error <= 2 ? '!  ' : '!! ';
    console.log(`  ${mark}${m.label.padEnd(10)} ${f1(m.value, 2).padStart(9)} ${m.ref === null ? '' : `ref ${f1(m.ref, 2)}`} ${m.unit}  err ${m.error.toFixed(2)}`);
  }
  for (const f of c.findings) {
    console.log(`  [${f.severity}] ${f.message}`);
    console.log(`    ${f.suggestion}`);
  }
}

export function runTimbre(args: string[]): void {
  const input = args[1];
  if (!input || input.startsWith('-')) {
    console.error('Usage: visualtone timbre <note.wav|score.json> [--midi 60] [--ref ref.wav] [--track id] [--start s] [--stop s] [--note-off s] [--json out.json]');
    process.exit(1);
  }
  let mono: Float32Array;
  let sampleRate: number;
  if (input.endsWith('.wav')) {
    ({ mono, sampleRate } = monoWav(input));
  } else {
    const loaded = loadScoreFile(input);
    const trackId = flag('--track', args);
    const rendered = render(loaded.score, { stems: true, clips: loaded.clips });
    sampleRate = rendered.sampleRate;
    const src = trackId ? rendered.stems!.find((s) => s.id === trackId) : undefined;
    if (trackId && !src) throw new Error(`乐谱里没有轨道 "${trackId}"`);
    const l = src ? src.l : rendered.buffers[0];
    const r = src ? src.r : (rendered.buffers[1] ?? rendered.buffers[0]);
    mono = new Float32Array(l.length);
    for (let i = 0; i < l.length; i++) mono[i] = (l[i] + r[i]) * 0.5;
  }
  const midi = num('--midi', args);
  const features = analyzeNote(mono, sampleRate, {
    midi,
    start: num('--start', args),
    stop: num('--stop', args),
    noteOff: num('--note-off', args),
  });
  printFeatures(features);
  const refPath = flag('--ref', args);
  let ref: NoteFeatures | undefined;
  let comparison: TimbreComparison | undefined;
  if (refPath) {
    const r = monoWav(refPath);
    ref = analyzeNote(r.mono, r.sampleRate, { midi: num('--ref-midi', args) ?? midi });
    console.log(`\nreference ${refPath}`);
    printFeatures(ref);
    comparison = compareTimbre(features, ref);
    printComparison(comparison);
  }
  const jsonPath = flag('--json', args);
  if (jsonPath) {
    writeFileSync(jsonPath, timbreToJson({ features, ref, comparison }));
    console.log(`Wrote ${jsonPath}`);
  }
}

export function runProbe(args: string[]): void {
  const input = args[1];
  if (!input || input.startsWith('-')) {
    console.error('Usage: visualtone probe <track.json|score.json> [--track id] [--pitches 36,48,60,72,84] [--sizes 0.3,0.6,0.9] [--note 1.5] [--tail 2] [--sr 48000] [--ref dir] [--wav out.wav] [--json out.json]');
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(input, 'utf8')) as Record<string, unknown>;
  let template = raw;
  let sampleRate = num('--sr', args);
  if (Array.isArray(raw.tracks)) {
    const id = flag('--track', args);
    const tracks = raw.tracks as Record<string, unknown>[];
    const found = id ? tracks.find((t) => t.id === id) : tracks[0];
    if (!found) throw new Error(id ? `乐谱里没有轨道 "${id}"` : '乐谱里没有轨道');
    template = found;
    if (sampleRate === undefined && typeof raw.sampleRate === 'number') sampleRate = raw.sampleRate;
  }
  const report = probeTrack(template, {
    pitches: list('--pitches', args) ?? DEFAULT_PITCHES,
    sizes: list('--sizes', args) ?? DEFAULT_SIZES,
    noteSec: num('--note', args),
    tailSec: num('--tail', args),
    sampleRate,
  });
  console.log(`probe ${String(template.id ?? '')}  engine ${String(template.engine ?? 'wavetable')}  hue ${String(template.hue ?? '-')}  ${report.sampleRate} Hz`);
  console.log('note  size   cents  attack ms  decay dB/s   T60 s  centroid  ×f0    B         HNR  clicks');
  for (const c of report.cells) {
    const f = c.features;
    console.log(
      `${noteName(c.midi).padEnd(5)} ${c.size.toFixed(2)} ${f1(f.centsOff).padStart(7)} ${f1(f.envelope.attackMs).padStart(10)} ` +
        `${f1(f.envelope.decayDbPerSec).padStart(11)} ${f1(f.envelope.t60Sec, 2).padStart(7)} ${f1(f.spectrum.centroidHz, 0).padStart(9)} ` +
        `${f1(f.spectrum.brightness, 2).padStart(5)}  ${(f.harmonics.inharmonicity === null ? '-' : f.harmonics.inharmonicity.toExponential(1)).padEnd(8)} ` +
        `${f1(f.harmonics.hnrDb).padStart(5)} ${String(f.artifacts.clicks).padStart(6)}`,
    );
  }
  const t = report.tracking;
  console.log(
    `\ntracking  pitch max ${f1(t.pitchMaxAbsCents)} / mean ${f1(t.pitchMeanAbsCents)} cents  level span ${f1(t.levelSpanDb)} dB  ` +
      `brightness span ${f1(t.brightnessSpanOct, 2)} oct  decay/oct ${f1(t.decayPerOctave, 2)}  clicks ${t.clicks}`,
  );
  if (report.findings.length === 0) console.log('\nNo findings.');
  else {
    console.log(`\nFindings (${report.findings.length}):`);
    for (const f of report.findings) {
      console.log(`  [${f.severity}] ${f.message}`);
      console.log(`    ${f.suggestion}`);
    }
  }

  const comparisons: { file: string; midi: number; size: number; comparison: TimbreComparison }[] = [];
  const refDir = flag('--ref', args);
  if (refDir) {
    const sizes = [...new Set(report.cells.map((c) => c.size))].sort((a, b) => a - b);
    const midSize = sizes[Math.floor(sizes.length / 2)];
    for (const file of readdirSync(refDir).sort()) {
      const m = file.match(/^(\d+)(?:_([\d.]+))?\.wav$/i);
      if (!m) continue;
      const midi = Number(m[1]);
      const size = m[2] !== undefined ? Number(m[2]) : midSize;
      const cell = report.cells.find((c) => c.midi === midi && Math.abs(c.size - size) < 1e-6);
      if (!cell) {
        console.log(`\n${file}: 探针里没有 ${noteName(midi)}@${size}，跳过`);
        continue;
      }
      const r = monoWav(join(refDir, file));
      const comparison = compareTimbre(cell.features, analyzeNote(r.mono, r.sampleRate, { midi }));
      comparisons.push({ file, midi, size, comparison });
      console.log(`\n${noteName(midi)}@${size} vs ${file}`);
      printComparison(comparison);
    }
  }

  const wavPath = flag('--wav', args);
  if (wavPath) {
    writeFileSync(wavPath, writeWavFile([report.buffer], report.sampleRate, { bitDepth: 24, dither: false }));
    console.log(`Wrote ${wavPath}`);
  }
  const jsonPath = flag('--json', args);
  if (jsonPath) {
    const { buffer: _b, score: _s, ...rest } = report;
    writeFileSync(jsonPath, timbreToJson({ ...rest, comparisons }));
    console.log(`Wrote ${jsonPath}`);
  }
}
