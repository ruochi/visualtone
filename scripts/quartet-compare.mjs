// Same string quartet, twice: the current synth, then TinySOL notes spliced onto the same grid.
// Missing pitches use the nearest recording, shifted with the body resonances left in place.
//
//   node scripts/quartet-compare.mjs [--listen out.mp4]
//
// Prints the per-voice third-octave difference (synth minus TinySOL) and writes
// /tmp/quartet-band.json. WAVs stay in /tmp. With --listen, also builds an MP4.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadScoreFile } from '../dist/load-score.js';
import { render } from '../dist/renderer.js';
import { parseAt, parseLen, parsePitch } from '../dist/units.js';
import { readWavFile, writeWavFile } from '../dist/wav.js';

const root = new URL('..', import.meta.url).pathname;
const listenAt = process.argv.indexOf('--listen');
const listenPath = listenAt >= 0 ? process.argv[listenAt + 1] : null;
const outDir = '/tmp/tinysol-quartet';
const cacheDir = join(outDir, 'src');
mkdirSync(cacheDir, { recursive: true });

const score = JSON.parse(readFileSync(join(root, 'examples/string-quartet.json'), 'utf8'));
const catalog = JSON.parse(readFileSync(join(root, 'references/catalog.json'), 'utf8'));
const SET = {
  'violin-1': 'tinysol-violin',
  'violin-2': 'tinysol-violin',
  viola: 'tinysol-viola',
  cello: 'tinysol-cello',
};

const library = {};
for (const id of new Set(Object.values(SET))) {
  library[id] = catalog.sets.find((s) => s.id === id).notes.filter((n) =>
    existsSync(join(root, 'references/recorded', id, `${n.midi}_${n.size}.wav`)),
  );
}

function pick(setId, midi, size) {
  const want = size >= 0.75 ? 0.9 : 0.6;
  const same = library[setId].filter((n) => n.size === want);
  const notes = same.length ? same : library[setId];
  let best = notes[0];
  let bestD = Infinity;
  for (const n of notes) {
    const d = Math.abs(n.midi - midi);
    if (d < bestD) {
      best = n;
      bestD = d;
    }
  }
  return best;
}

function shiftPath(setId, note, semis) {
  const dest = join(cacheDir, `${setId}-${note.midi}_${note.size}-${semis}.wav`);
  if (!existsSync(dest)) {
    const src = join(root, 'references/recorded', setId, `${note.midi}_${note.size}.wav`);
    const pitch = (2 ** (semis / 12)).toFixed(6);
    const af = Math.abs(semis) < 0.01
      ? 'aresample=48000'
      : `rubberband=pitch=${pitch}:formant=preserved:pitchq=quality:transients=smooth,aresample=48000`;
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-af', af, '-ar', '48000', dest]);
  }
  return dest;
}

const loaded = new Map();
function audio(path) {
  if (!loaded.has(path)) {
    const wav = readWavFile(readFileSync(path));
    const n = wav.buffers[0].length;
    const mono = new Float32Array(n);
    for (const b of wav.buffers) for (let i = 0; i < n; i++) mono[i] += b[i] / wav.buffers.length;
    loaded.set(path, { mono, sampleRate: wav.sampleRate });
  }
  return loaded.get(path);
}

function onsetOf(mono, sr) {
  let peak = 0;
  for (let i = 0; i < mono.length; i++) peak = Math.max(peak, Math.abs(mono[i]));
  const th = peak * 0.015;
  let i = 0;
  for (; i < mono.length; i++) if (Math.abs(mono[i]) > th) break;
  return Math.max(0, i / sr - 0.02);
}

function rmsSpan(mono, sr, t0, t1) {
  const a = Math.max(0, Math.floor(t0 * sr));
  const b = Math.min(mono.length, Math.floor(t1 * sr));
  let s = 0;
  let n = 0;
  for (let i = a; i < b; i++) {
    s += mono[i] * mono[i];
    n++;
  }
  return n ? Math.sqrt(s / n) : 0;
}

const clipsByTrack = new Map(score.tracks.map((t) => [t.id, []]));
let maxShift = 0;
for (const track of score.tracks) {
  const setId = SET[track.id];
  const notes = track.notes
    .map((n) => ({
      t: parseAt(n.at, score.bpm, score.meter),
      dur: parseLen(n.len, score.bpm),
      midi: parsePitch(n.pitch),
      size: n.size,
    }))
    .sort((a, b) => a.t - b.t);
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const next = notes[i + 1];
    const gap = next ? next.t - (n.t + n.dur) : 9;
    const src = pick(setId, n.midi, n.size);
    const semis = n.midi - src.midi;
    maxShift = Math.max(maxShift, Math.abs(semis));
    const path = shiftPath(setId, src, semis);
    const buf = audio(path);
    const on = onsetOf(buf.mono, buf.sampleRate);
    const body = rmsSpan(buf.mono, buf.sampleRate, on + 0.12, on + 0.45);
    const gain = body > 1e-6 ? (n.size * 0.2) / body : 1;
    const sustainEnd = Math.min(on + n.dur + 0.04, buf.mono.length / buf.sampleRate - 0.01);
    clipsByTrack.get(track.id).push({
      src: path,
      at: n.t,
      gain,
      fadeIn: 0.004,
      fadeOut: Math.min(0.045, n.dur * 0.25),
      trim: [on, sustainEnd],
    });
    if (gap > 0.35 && src.hold) {
      const relStart = Math.max(0, src.hold - 0.03);
      const relLen = Math.min(1.15, gap + 0.05);
      const relEnd = Math.min(buf.mono.length / buf.sampleRate - 0.01, relStart + relLen);
      if (relEnd - relStart > 0.08) {
        clipsByTrack.get(track.id).push({
          src: path,
          at: n.t + n.dur - 0.03,
          gain,
          fadeIn: 0.04,
          fadeOut: Math.min(0.35, relLen * 0.45),
          trim: [relStart, relEnd],
        });
      }
    }
  }
}

const tinysolScore = {
  sampleRate: 48000,
  duration: score.duration,
  seed: score.seed,
  master: score.master,
  tracks: score.tracks.map((t) => ({
    id: t.id,
    channel: t.channel,
    pan: t.pan,
    room: t.room,
    space: t.space,
    clips: clipsByTrack.get(t.id),
  })),
};
const scorePath = join(outDir, 'score.json');
writeFileSync(scorePath, JSON.stringify(tinysolScore));

const synthLoaded = loadScoreFile(join(root, 'examples/string-quartet.json'));
const realLoaded = loadScoreFile(scorePath);
const synth = render(synthLoaded.score, { stems: true });
const real = render(realLoaded.score, { stems: true, clips: realLoaded.clips });
writeFileSync('/tmp/string-quartet.wav', synth.wav);
writeFileSync('/tmp/string-quartet-tinysol.wav', real.wav);

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const p = i + k + len / 2;
        const xr = re[p] * wr - im[p] * wi;
        const xi = re[p] * wi + im[p] * wr;
        re[p] = re[i + k] - xr;
        im[p] = im[i + k] - xi;
        re[i + k] += xr;
        im[i + k] += xi;
      }
    }
  }
}

const bands = [];
for (let f = 63; f < 16000; f *= 2 ** (1 / 3)) bands.push(f);

function ltas(st) {
  const sr = 48000;
  const N = 4096;
  const acc = new Float64Array(N / 2);
  const m = new Float32Array(st.l.length);
  for (let i = 0; i < m.length; i++) m[i] = 0.5 * (st.l[i] + st.r[i]);
  let frames = 0;
  for (let s = 0; s + N < m.length; s += N / 2) {
    let e = 0;
    for (let i = 0; i < N; i++) e += m[s + i] ** 2;
    if (e / N < 1e-7) continue;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = m[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    fft(re, im);
    for (let k = 0; k < N / 2; k++) acc[k] += re[k] ** 2 + im[k] ** 2;
    frames++;
  }
  const out = bands.map((f) => {
    const lo = Math.max(1, Math.floor((f / 2 ** (1 / 6)) * N / sr));
    const hi = Math.min(N / 2 - 1, Math.ceil(f * 2 ** (1 / 6) * N / sr));
    let s = 0;
    for (let k = lo; k <= hi; k++) s += acc[k];
    return 10 * Math.log10(s / Math.max(1, frames) + 1e-20);
  });
  const ref = Math.max(...out);
  return out.map((x) => x - ref);
}

const voices = [];
let rmsNum = 0;
let rmsDen = 0;
for (const track of score.tracks) {
  const sa = synth.stems.find((s) => s.id === track.id);
  const sb = real.stems.find((s) => s.id === track.id);
  const la = ltas(sa);
  const lb = ltas(sb);
  const diffs = bands.map((f, i) => la[i] - lb[i]);
  const row = bands.map((f, i) => `${f < 1000 ? Math.round(f) : `${(f / 1000).toFixed(1)}k`}:${diffs[i].toFixed(0)}`);
  const kept = diffs.filter((_, i) => bands[i] >= 300 && bands[i] <= 8000);
  const rms = Math.sqrt(kept.reduce((s, v) => s + v * v, 0) / kept.length);
  rmsNum += kept.reduce((s, v) => s + v * v, 0);
  rmsDen += kept.length;
  voices.push({ id: track.id, rms: Number(rms.toFixed(2)), diffs: diffs.map((v) => Number(v.toFixed(2))) });
  console.log(`\n${track.id}  300 Hz–8 kHz rms ${rms.toFixed(2)} dB`);
  console.log(row.join(' '));
}
const rms = Math.sqrt(rmsNum / rmsDen);
console.log(`\nall voices 300 Hz–8 kHz rms ${rms.toFixed(2)} dB   max pitch shift ${maxShift} st`);
const report = { rms: Number(rms.toFixed(2)), maxShift, voices };
writeFileSync('/tmp/quartet-band.json', JSON.stringify(report, null, 2) + '\n');
console.log('wrote /tmp/quartet-band.json');

if (!listenPath) process.exit(0);

const font = '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc';
const seg = join(outDir, 'seg');
mkdirSync(seg, { recursive: true });
function card(text, sub, dest) {
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-t', '2.4', '-i', 'color=c=0x1c1814:s=1280x720:r=30',
    '-f', 'lavfi', '-t', '2.4', '-i', 'anullsrc=r=48000:cl=stereo',
    '-filter_complex',
    `[0:v]drawtext=fontfile=${font}:text='${text}':x=(w-text_w)/2:y=280:fontsize=68:fontcolor=0xf4efe6,` +
      `drawtext=fontfile=${font}:text='${sub}':x=(w-text_w)/2:y=390:fontsize=28:fontcolor=0xa89880[v]`,
    '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', dest,
  ]);
}
function play(label, wav, dest) {
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x1c1814:s=1280x720:r=30',
    '-i', wav,
    '-filter_complex', `[0:v]drawtext=fontfile=${font}:text='${label}':x=64:y=56:fontsize=36:fontcolor=0xf4efe6[v]`,
    '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', dest,
  ]);
}
card('合成', '现在的小提琴、中提琴、大提琴', join(seg, 'card-synth.mp4'));
card('TinySOL 录音', '同一首。缺的音用最近的录音，最多移 3 个半音', join(seg, 'card-real.mp4'));
play('合成', '/tmp/string-quartet.wav', join(seg, 'play-synth.mp4'));
play('TinySOL', '/tmp/string-quartet-tinysol.wav', join(seg, 'play-real.mp4'));
const list = ['card-synth', 'play-synth', 'card-real', 'play-real'].map((n) => `file '${join(seg, `${n}.mp4`)}'`).join('\n');
writeFileSync(join(seg, 'list.txt'), list);
execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(seg, 'list.txt'), '-c', 'copy', listenPath]);
console.log('wrote', listenPath);
