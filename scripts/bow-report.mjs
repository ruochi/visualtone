// Bowed-string report: motion metrics, side-by-side spectrograms, and a listening video.
//   node scripts/bow-report.mjs [--listen]
//
// For each bowed set, scores the holdout and two valid notes against the recording.
// Writes spectrogram PNGs (recording on the left, current synth on the right) to
// /opt/cursor/artifacts/bow-report/. With --listen, also builds bow_listen.mp4:
// recording, then the presets frozen in references/fit/bow-before-body.json, then current.
// WAVs stay in /tmp and are not committed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TIMBRE_V1_IDS, analyzeNote, compareTimbre, metricExcess, noteName } from '../dist/analysis/timbre.js';
import { HARMONIC_PRESETS } from '../dist/engines/harmonic.js';
import { resampleBuffer } from '../dist/resample.js';
import { writeWavFile } from '../dist/wav.js';
import { loadWav, noteTiming, recordedFile, renderNote } from './lib/score-note.mjs';

const root = new URL('..', import.meta.url).pathname;
const listen = process.argv.includes('--listen');
const outDir = '/opt/cursor/artifacts/bow-report';
const tmp = '/tmp/bow-report';
mkdirSync(outDir, { recursive: true });
mkdirSync(join(tmp, 'seg'), { recursive: true });

const catalog = JSON.parse(readFileSync(join(root, 'references/catalog.json'), 'utf8'));
const floor = JSON.parse(readFileSync(join(root, 'references/floor.json'), 'utf8')).metrics;
const before = JSON.parse(readFileSync(join(root, 'references/fit/bow-before-body.json'), 'utf8'));
const font = '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc';
const v1 = new Set(TIMBRE_V1_IDS);

const SETS = [
  { id: 'tinysol-violin', title: '小提琴', preset: 'violin' },
  { id: 'tinysol-viola', title: '中提琴', preset: 'viola' },
  { id: 'tinysol-cello', title: '大提琴', preset: 'cello' },
  { id: 'tinysol-bass', title: '低音提琴', preset: 'contrabass' },
];
const METRICS = ['motion.am', 'motion.corr', 'motion.opposite', 'ladder', 'gapNoise', 'topPartial', 'vibrato.depth', 'vibrato.cv', 'hnr', 'harmonics'];

function pick(set) {
  const mf = set.notes.filter((n) => n.size === 0.6);
  const pool = mf.length ? mf : set.notes;
  const test = pool.filter((n) => n.split === 'test').sort((a, b) => b.midi - a.midi)[0];
  const valid = pool.filter((n) => n.split !== 'test').sort((a, b) => a.midi - b.midi);
  const chosen = [valid[0], valid[Math.floor(valid.length / 2)], test].filter(Boolean);
  const seen = new Set();
  return chosen.filter((n) => {
    const key = `${n.midi}_${n.size}_${n.split}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function score(refBuf, engine, hue, midi, size, kind, timing) {
  const rendered = renderNote(engine, hue, midi, size, kind, refBuf.mono.length / refBuf.sampleRate, timing);
  const oursMono = refBuf.sampleRate === 48000 ? rendered.mono : resampleBuffer(rendered.mono, 48000, refBuf.sampleRate);
  const refOpts = { midi };
  if (timing?.hold !== undefined) refOpts.noteOff = timing.hold;
  const ref = analyzeNote(refBuf.mono, refBuf.sampleRate, refOpts);
  const ours = analyzeNote(oursMono, refBuf.sampleRate, { midi, start: 0, stop: rendered.stop, noteOff: rendered.noteOff });
  const cmp = compareTimbre(ours, ref, floor);
  return { rendered, ours, ref, cmp };
}

function cell(cmp, id) {
  const m = cmp.metrics.find((x) => x.id === id);
  if (!m || m.value === null || !Number.isFinite(m.value)) return '-';
  return m.ref === null || !Number.isFinite(m.ref) ? m.value.toFixed(2) : `${m.value.toFixed(2)}/${m.ref.toFixed(2)}`;
}

function clip(mono, sampleRate, from, seconds) {
  const a = Math.max(0, Math.floor(from * sampleRate));
  const b = Math.min(mono.length, a + Math.floor(seconds * sampleRate));
  const y = new Float32Array(b - a);
  let peak = 1e-9;
  for (let i = 0; i < y.length; i++) {
    y[i] = mono[a + i];
    peak = Math.max(peak, Math.abs(y[i]));
  }
  const g = 0.8 / peak;
  for (let i = 0; i < y.length; i++) y[i] *= g;
  return y;
}

function writeWav(mono, sampleRate, path) {
  writeFileSync(path, writeWavFile([mono, mono], sampleRate, { dither: false }));
}

function withPreset(id, preset, fn) {
  const saved = HARMONIC_PRESETS[id];
  HARMONIC_PRESETS[id] = preset;
  try {
    return fn();
  } finally {
    HARMONIC_PRESETS[id] = saved;
  }
}

const specOf = 's=640x420:mode=combined:color=magma:scale=log:fscale=lin:legend=0:win_func=hann';
const clips = [];

for (const spec of SETS) {
  const set = catalog.sets.find((s) => s.id === spec.id);
  console.log(`\n===== ${spec.title}`);
  for (const note of pick(set)) {
    const timing = noteTiming(set, note);
    const refBuf = loadWav(join(root, 'references/recorded', set.id, recordedFile(note)));
    const now = score(refBuf, set.engine, set.hue, note.midi, note.size, set.kind, timing);
    const old = withPreset(spec.preset, before[spec.preset], () =>
      score(refBuf, set.engine, set.hue, note.midi, note.size, set.kind, timing),
    );
    const v1now = metricExcess(now.cmp.metrics, floor, v1);
    console.log(
      `  ${noteName(note.midi)} ${note.split || ''}  excess ${now.cmp.excess.toFixed(2)}  v1 ${v1now.toFixed(2)}  (old excess ${old.cmp.excess.toFixed(2)})`,
    );
    for (const id of METRICS) console.log(`    ${id.padEnd(16)} now ${cell(now.cmp, id).padEnd(18)} old ${cell(old.cmp, id)}`);

    const tag = `${spec.preset}-${noteName(note.midi)}-${note.split || 'note'}`;
    const rec = clip(refBuf.mono, refBuf.sampleRate, 0.35, 3);
    const nowClip = clip(now.rendered.mono, 48000, 0.4, 3);
    const oldClip = clip(old.rendered.mono, 48000, 0.4, 3);
    writeWav(rec, refBuf.sampleRate, join(tmp, `${tag}-rec.wav`));
    writeWav(nowClip, 48000, join(tmp, `${tag}-now.wav`));
    writeWav(oldClip, 48000, join(tmp, `${tag}-old.wav`));
    const png = join(outDir, `${tag}.png`);
    execFileSync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', join(tmp, `${tag}-rec.wav`),
      '-i', join(tmp, `${tag}-now.wav`),
      '-filter_complex',
      `[0:a]showspectrumpic=${specOf},drawtext=fontfile=${font}:text='录音':x=16:y=12:fontsize=22:fontcolor=white[a];` +
        `[1:a]showspectrumpic=${specOf},drawtext=fontfile=${font}:text='现在':x=16:y=12:fontsize=22:fontcolor=white[b];` +
        `[a][b]hstack=inputs=2`,
      '-frames:v', '1', png,
    ]);
    console.log(`    png ${png}`);
    if (note.split === 'test') {
      clips.push({ spec, note, tag, title: `${spec.title}  ${noteName(note.midi)}  mf` });
    }
  }
}

if (!listen) {
  console.log(`\npngs in ${outDir}`);
  process.exit(0);
}

const list = [];
function segment(name, seconds, input, label) {
  const path = join(tmp, 'seg', `${name}.mp4`);
  const text = `drawtext=fontfile=${font}:text='${label}':x=40:y=36:fontsize=32:fontcolor=white`;
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  if (input) {
    args.push(
      '-i', input,
      '-f', 'lavfi', '-i', `color=c=0x14120f:s=1280x720:d=${seconds}:r=30`,
      '-filter_complex',
      `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=pad_dur=0.2[a];` +
        `[0:a]showspectrumpic=s=1180x500:mode=combined:color=magma:scale=log:fscale=lin:legend=0:win_func=hann[sp];` +
        `[1:v][sp]overlay=(W-w)/2:150,${text}[v]`,
      '-map', '[v]', '-map', '[a]',
    );
  } else {
    args.push(
      '-f', 'lavfi', '-i', `color=c=0x14120f:s=1280x720:d=${seconds}:r=30`,
      '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${seconds}`,
      '-vf', text,
      '-map', '0:v', '-map', '1:a',
    );
  }
  args.push('-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', path);
  execFileSync('ffmpeg', args);
  list.push(path);
}

segment('intro', 2.5, null, '弓弦  录音 / 上一轮 / 现在');
let n = 0;
for (const clip of clips) {
  segment(`t${n}`, 1.4, null, clip.title);
  segment(`r${n}`, 3, join(tmp, `${clip.tag}-rec.wav`), `${clip.title}   录音`);
  segment(`o${n}`, 3, join(tmp, `${clip.tag}-old.wav`), `${clip.title}   上一轮`);
  segment(`c${n}`, 3, join(tmp, `${clip.tag}-now.wav`), `${clip.title}   现在`);
  n++;
}
writeFileSync(join(tmp, 'list.txt'), list.map((p) => `file '${p}'`).join('\n') + '\n');
const video = '/opt/cursor/artifacts/bow_listen.mp4';
execFileSync('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'concat', '-safe', '0', '-i', join(tmp, 'list.txt'),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000',
  '-movflags', '+faststart', video,
]);
console.log(`\nvideo ${video}`);
