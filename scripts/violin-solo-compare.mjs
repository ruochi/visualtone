// Bach BWV 1006 Menuet I, bars 1–8, against one solo recording.
//
//   node scripts/violin-solo-compare.mjs [--recording path.wav] [--listen out.mp4]
//
// The written grid is 115 BPM. The recording phrase starts at 13.30 s.
// Physics (body, bow, seed) are not refit. WAVs stay in /tmp.
// Figures go to /opt/cursor/artifacts/violin_minuet/.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadScoreFile } from '../dist/load-score.js';
import { render } from '../dist/renderer.js';
import { writeWavFile } from '../dist/wav.js';

const root = new URL('..', import.meta.url).pathname;
const BPM = 115;
const OFFSET = 13.3;
const PHRASE = 24 * (60 / BPM);
const TAIL = 0.75;

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const recording = arg('--recording', '/tmp/violin-solo/minuet.wav');
const listenAt = process.argv.indexOf('--listen');
const listenPath = listenAt >= 0 ? process.argv[listenAt + 1] : null;
const tmp = '/tmp/violin-solo';
const figDir = '/opt/cursor/artifacts/violin_minuet';
mkdirSync(tmp, { recursive: true });
mkdirSync(figDir, { recursive: true });

const py = join(root, 'scripts/violin-solo-figures.py');
const scorePath = join(root, 'examples/violin-minuet.json');

if (process.argv.includes('--align-only')) {
  execFileSync('python3', [
    py, '--align-only', '--recording', recording, '--score', scorePath,
    '--offset', String(OFFSET), '--phrase', String(PHRASE),
  ], { stdio: 'inherit' });
  process.exit(0);
}

const { readWavFile } = await import('../dist/wav.js');
const decoded = readWavFile(readFileSync(recording));
const sr = decoded.sampleRate;
if (sr !== 48000) throw new Error(`expected 48000 Hz, got ${sr}`);
const src = decoded.buffers;
const mono = new Float32Array(src[0].length);
for (const b of src) for (let i = 0; i < mono.length; i++) mono[i] += b[i] / src.length;

function sliceAt(start, dur) {
  const i0 = Math.round(start * sr);
  const n = Math.round(dur * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i0 + i;
    out[i] = j >= 0 && j < mono.length ? mono[j] : 0;
  }
  return out;
}

function fade(x, samples) {
  const y = new Float32Array(x);
  for (let i = 0; i < samples && i < y.length; i++) {
    const g = i / samples;
    y[i] *= g;
    y[y.length - 1 - i] *= g;
  }
  return y;
}

function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

const recPhrase = sliceAt(OFFSET, PHRASE);
const recListen = fade(sliceAt(OFFSET, PHRASE + TAIL), Math.round(0.012 * sr));

console.log('rendering violin…');
const loaded = loadScoreFile(scorePath);
const rendered = render(loaded.score, { bitDepth: 32 });
const mix = rendered.buffers;
const synthFull = new Float32Array(mix[0].length);
for (const b of mix) for (let i = 0; i < synthFull.length; i++) synthFull[i] += b[i] / mix.length;

function take(dur) {
  const n = Math.round(dur * sr);
  const out = new Float32Array(n);
  const m = Math.min(n, synthFull.length);
  out.set(synthFull.subarray(0, m));
  return out;
}

const synthPhrase = take(PHRASE);
const synthListen = fade(take(PHRASE + TAIL), Math.round(0.012 * sr));
const g = rms(synthListen) > 1e-8 ? rms(recListen) / rms(synthListen) : 1;
for (let i = 0; i < synthListen.length; i++) synthListen[i] *= g;

function wav(samples) {
  return writeWavFile([samples, samples], sr, { bitDepth: 32, dither: false });
}
writeFileSync(join(tmp, 'rec-phrase.wav'), wav(recPhrase));
writeFileSync(join(tmp, 'synth-phrase.wav'), wav(synthPhrase));
writeFileSync(join(tmp, 'rec-listen.wav'), writeWavFile([recListen, recListen], sr, { bitDepth: 16 }));
writeFileSync(join(tmp, 'synth-listen.wav'), writeWavFile([synthListen, synthListen], sr, { bitDepth: 16 }));

const reportPath = join(root, 'references/violin-solo-menuet.json');
execFileSync('python3', [
  py,
  '--recording', join(tmp, 'rec-phrase.wav'),
  '--synth', join(tmp, 'synth-phrase.wav'),
  '--score', scorePath,
  '--out', figDir,
  '--json', reportPath,
  '--offset', String(OFFSET),
  '--phrase', String(PHRASE),
], { stdio: 'inherit' });

if (!listenPath) {
  console.log('figures', figDir);
  process.exit(0);
}

const font = '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc';
const seg = join(tmp, 'seg');
mkdirSync(seg, { recursive: true });
writeFileSync(join(seg, 'card1.txt'), '巴赫第三帕蒂塔  小步舞曲 I');
writeFileSync(join(seg, 'card2.txt'), '前八小节    录音 Vicond    CC BY 3.0');
writeFileSync(join(seg, 'lab-rec.txt'), '录音');
writeFileSync(join(seg, 'lab-syn.txt'), '合成');

function card(dest) {
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-t', '2.6', '-i', 'color=c=0x1c1814:s=1280x720:r=30',
    '-f', 'lavfi', '-t', '2.6', '-i', 'anullsrc=r=48000:cl=stereo',
    '-filter_complex',
    `[0:v]drawtext=fontfile=${font}:textfile=${join(seg, 'card1.txt')}:x=(w-text_w)/2:y=280:fontsize=52:fontcolor=0xf4efe6,` +
      `drawtext=fontfile=${font}:textfile=${join(seg, 'card2.txt')}:x=(w-text_w)/2:y=380:fontsize=26:fontcolor=0xa89880[v]`,
    '-map', '[v]', '-map', '1:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', dest,
  ]);
}

function play(labelFile, wavPath, dest) {
  // One picture of the whole phrase. A scrolling column never fills the frame in 13 seconds.
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', wavPath,
    '-f', 'lavfi', '-t', '14', '-i', 'color=c=0x1c1814:s=1280x720:r=30',
    '-filter_complex',
    `[0:a]aformat=channel_layouts=stereo,asplit=2[a][s];` +
      `[s]showspectrumpic=s=1180x500:mode=combined:color=magma:scale=log:fscale=log:win_func=hann:legend=0[sp];` +
      `[1:v][sp]overlay=(W-w)/2:150,drawtext=fontfile=${font}:textfile=${labelFile}:x=64:y=48:fontsize=36:fontcolor=0xf4efe6[v]`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-shortest', dest,
  ]);
}

card(join(seg, 'card.mp4'));
play(join(seg, 'lab-rec.txt'), join(tmp, 'rec-listen.wav'), join(seg, 'rec.mp4'));
play(join(seg, 'lab-syn.txt'), join(tmp, 'synth-listen.wav'), join(seg, 'syn.mp4'));
writeFileSync(join(seg, 'list.txt'), ['card', 'rec', 'syn'].map((n) => `file '${join(seg, `${n}.mp4`)}'`).join('\n') + '\n');
execFileSync('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'concat', '-safe', '0', '-i', join(seg, 'list.txt'),
  '-c', 'copy', '-movflags', '+faststart', listenPath,
]);
console.log('wrote', listenPath);
