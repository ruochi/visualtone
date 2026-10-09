import { readFileSync } from 'node:fs';
import { analyzeNote, compareTimbre } from '../../dist/analysis/timbre.js';
import { render } from '../../dist/renderer.js';
import { resampleBuffer } from '../../dist/resample.js';
import { ScoreSchema } from '../../dist/schema.js';
import { readWavFile } from '../../dist/wav.js';

/** On-disk name. NSynth keeps the instrument suffix; everything else is midi_size.wav. */
export function recordedFile(note) {
  if (note.instrument && note.file) return note.file;
  return `${note.midi}_${note.size}.wav`;
}

/** Per-note hold wins. A set-level hold (NSynth) is the fallback. */
export function noteTiming(set, note) {
  if (note?.hold !== undefined) return { hold: note.hold, tail: note.tail ?? set?.tail ?? 0.8 };
  if (set?.hold !== undefined) return { hold: set.hold, tail: set.tail ?? 1 };
  return undefined;
}

export function loadWav(path) {
  const wav = readWavFile(readFileSync(path));
  const n = wav.buffers[0].length;
  const mono = new Float32Array(n);
  for (const b of wav.buffers) for (let i = 0; i < n; i++) mono[i] += b[i] / wav.buffers.length;
  return { mono, sampleRate: wav.sampleRate };
}

/** Render one note the way compare-references does. `timing` overrides the hold and tail derived from the recording length. */
export function renderNote(engine, hue, midi, size, kind, seconds, timing) {
  const hold = timing?.hold ?? (kind === 'sustain' ? Math.min(1.6, Math.max(0.8, seconds * 0.7)) : Math.min(0.45, Math.max(0.12, seconds * 0.35)));
  const tail = timing?.tail ?? (kind === 'sustain' ? 0.45 : 1.1);
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

/**
 * Score one rendered note against a recording.
 * When the recording is below 48 kHz, the render is resampled to that rate so both
 * sides are measured inside the same band.
 */
export function scoreAgainst(refBuf, engine, hue, midi, size, kind, timing, floor, refReady) {
  const oursBuf = renderNote(engine, hue, midi, size, kind, refBuf.mono.length / refBuf.sampleRate, timing);
  const oursMono = refBuf.sampleRate === 48000 ? oursBuf.mono : resampleBuffer(oursBuf.mono, 48000, refBuf.sampleRate);
  const refOpts = { midi };
  if (timing?.hold !== undefined) refOpts.noteOff = timing.hold;
  const ref = refReady ?? analyzeNote(refBuf.mono, refBuf.sampleRate, refOpts);
  const ours = analyzeNote(oursMono, refBuf.sampleRate, { midi, start: 0, stop: oursBuf.stop, noteOff: oursBuf.noteOff });
  const cmp = compareTimbre(ours, ref, floor);
  return { ours, ref, cmp };
}
