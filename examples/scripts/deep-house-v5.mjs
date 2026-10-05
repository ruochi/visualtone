#!/usr/bin/env node
// Generates examples/deep-house-v5.json — 122 BPM deep house in F minor, 16 bars + tail.
// Run: node examples/scripts/deep-house-v5.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BPM = 122;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const S16 = BEAT / 4;
const BARS = 16;
const END = BARS * BAR;
const r = (x) => Math.round(x * 10000) / 10000;
const at = (bar, beat = 0) => r(bar * BAR + beat * BEAT);

// Fm9 | Dbmaj9 | Bbm9 | Cm7 — stab voicings share Ab/C for smooth voice leading.
const CHORDS = [
  { bass: 41, stab: [56, 60, 63, 67], pad: [72, 75, 79] },
  { bass: 37, stab: [56, 60, 63, 65], pad: [72, 75, 77] },
  { bass: 34, stab: [56, 60, 61, 65], pad: [72, 73, 77] },
  { bass: 36, stab: [55, 58, 60, 63], pad: [70, 72, 75] },
];
const chordAt = (bar) => CHORDS[bar % 4];

// ---------- drums ----------
const kick = [];
for (let bar = 0; bar <= BARS; bar++) {
  const beats = bar === BARS ? [0] : [0, 1, 2, 3];
  for (const b of beats) {
    if (bar === 7 && b === 3) continue; // one-beat break before the drop
    kick.push({ t: at(bar, b), y: 33, size: b === 0 ? 0.95 : 0.88, duration: bar === BARS ? 0.6 : 0.3, ease: 'exp' });
  }
}

const clap = [];
for (let bar = 4; bar < BARS; bar++) {
  for (const b of [1, 3]) clap.push({ t: at(bar, b), y: 62, size: 0.9, duration: 0.16, ease: 'exp' });
  if (bar % 4 === 3) clap.push({ t: at(bar, 3.75), y: 64, size: 0.45, duration: 0.08, ease: 'exp' });
}

const openHat = [];
for (let bar = 0; bar < BARS; bar++) {
  for (const b of [0.5, 1.5, 2.5, 3.5]) {
    openHat.push({ t: at(bar, b), y: 92, size: bar < 2 ? 0.55 : 0.85, duration: 0.17, ease: 'exp' });
  }
}

const shaker = [];
const accent = [0.55, 0.26, 0, 0.4];
for (let bar = 2; bar < BARS; bar++) {
  for (let s = 0; s < 16; s++) {
    const a = accent[s % 4];
    if (a === 0) continue; // open hat owns the off-beat 8th
    shaker.push({ t: r(bar * BAR + s * S16), y: 100, size: a, duration: 0.05, ease: 'exp' });
  }
}

// ---------- bass ----------
// Off-kick syncopation with octave pops; rests on the downbeat so the kick owns it.
const BASS_STEPS = [
  { s: 2, o: 0, d: 2.5 },
  { s: 6, o: 12, d: 0.8 },
  { s: 7, o: 0, d: 2 },
  { s: 10, o: 0, d: 2.5 },
  { s: 13, o: 12, d: 0.9 },
  { s: 14, o: 0, d: 1.6 },
];
const bass = [];
for (let bar = 4; bar < BARS; bar++) {
  const root = chordAt(bar).bass;
  for (const st of BASS_STEPS) {
    if (bar === 7 && st.s >= 12) continue;
    bass.push({ t: r(bar * BAR + st.s * S16), y: root + st.o, size: st.o ? 0.55 : 0.72, duration: r(st.d * S16), ease: 'hold' });
  }
}
bass.push({ t: at(BARS), y: 41, size: 0.7, duration: 1.6, ease: 'exp' });

// ---------- chord stabs (4 mono voices) ----------
const STAB_STEPS = [3, 6, 10, 13];
const stabVoices = [[], [], [], []];
for (let bar = 4; bar < BARS; bar++) {
  const ch = chordAt(bar);
  for (const s of STAB_STEPS) {
    if (bar === 7 && s === 13) continue;
    ch.stab.forEach((y, v) => {
      stabVoices[v].push({ t: r(bar * BAR + s * S16), y, size: 0.8, duration: 0.2, ease: 'exp' });
    });
  }
}

// ---------- pad (3 mono voices) ----------
const padVoices = [[], [], []];
for (let bar = 0; bar < BARS; bar++) {
  chordAt(bar).pad.forEach((y, v) => padVoices[v].push({ t: at(bar), y, size: 0.12, duration: r(BAR - 0.01), ease: 'hold' }));
}
CHORDS[0].pad.forEach((y, v) => padVoices[v].push({ t: at(BARS), y, size: 0.12, duration: 2.0, ease: 'exp' }));

// ---------- vocal-ish hook (drop only) ----------
const HOOK = [
  { b: 0.5, y: 75, d: 0.45 },
  { b: 1, y: 77, d: 0.9 },
  { b: 2.5, y: 80, d: 0.45 },
  { b: 3, y: 79, d: 1.4 },
  { b: 5, y: 77, d: 0.45 },
  { b: 5.5, y: 75, d: 0.45 },
  { b: 6, y: 72, d: 1.6 },
];
const HOOK_ALT_END = [
  { b: 5, y: 80, d: 0.45 },
  { b: 5.5, y: 82, d: 0.45 },
  { b: 6, y: 84, d: 1.6 },
];
const lead = [];
for (let phrase = 0; phrase < 4; phrase++) {
  const start = 8 + phrase * 2;
  const notes = phrase === 3 ? [...HOOK.slice(0, 4), ...HOOK_ALT_END] : HOOK;
  for (const n of notes) lead.push({ t: at(start, n.b), y: n.y, size: 0.42, duration: r(n.d * BEAT), ease: 'hold' });
}

// ---------- riser into the drop + crash on the one ----------
const fx = [
  { t: at(6), y: 84, size: 0.42, duration: r(2 * BAR - 0.03), ease: 'hold' },
  { t: at(8), y: 88, size: 0.4, duration: 1.4, ease: 'exp' },
];

// Hold the build back so the drop lands harder.
const BUILD_TO_DROP = [{ t: at(4), v: 0.68 }, { t: r(at(8) - 0.01), v: 0.68 }, { t: at(8), v: 1 }];

// ---------- tracks ----------
const tracks = [
  {
    id: 'kick',
    hue: 0,
    channel: [0, 1],
    lightness: 0.5,
    timbre: { pitchEnvSemis: 26, pitchEnvMs: 35, transient: 0.55, noise: 0.18 },
    eq: { lowCut: 28, peaks: [{ freq: 320, gain: -3, q: 1.2 }, { freq: 3800, gain: 2, q: 1 }] },
    comp: { threshold: -14, ratio: 4, attackMs: 8, releaseMs: 90, makeup: 5 },
    notes: kick,
  },
  {
    id: 'clap',
    hue: 300,
    channel: [0, 1],
    lightness: 0.6,
    space: 0.38,
    eq: { lowCut: 220, peaks: [{ freq: 1500, gain: 2, q: 0.9 }, { freq: 5000, gain: 3, q: 0.8 }] },
    humanize: { timeMs: 3, size: 0.08 },
    notes: clap,
  },
  {
    id: 'open-hat',
    hue: 335,
    channel: [0, 1],
    lightness: 0.78,
    space: 0.18,
    eq: { lowCut: 3500, highShelf: { freq: 9000, gain: 4 } },
    automation: { gain: [{ t: 0, v: 0.6 }, { t: at(2), v: 1 }] },
    notes: openHat,
  },
  {
    id: 'shaker',
    hue: 335,
    channel: [0, 1],
    lightness: 0.62,
    timbre: { transient: 0.2, filterDecayMs: 20 },
    eq: { lowCut: 3000, highShelf: { freq: 8000, gain: 3 } },
    humanize: { timeMs: 4, size: 0.25 },
    lfo: [{ target: 'pan', depth: 0.45, beats: 4 }],
    notes: shaker,
  },
  {
    id: 'bass',
    hue: 30,
    channel: [0, 1],
    lightness: 0.3,
    timbre: { tilt: 1.5, resonance: 0.32, filterEnv: 0.45, filterDecayMs: 160, drive: 0.35 },
    duck: { by: 'kick', amount: 0.72 },
    eq: { lowCut: 32, peaks: [{ freq: 250, gain: -2.5, q: 1 }], highCut: 2500 },
    comp: { threshold: -16, ratio: 3, attackMs: 6, releaseMs: 100, makeup: 2 },
    lfo: [{ target: 'lightness', depth: 0.06, beats: 8 }],
    automation: { gain: BUILD_TO_DROP },
    notes: bass,
  },
  ...stabVoices.map((notes, v) => ({
    id: `stab-${v + 1}`,
    hue: 90,
    channel: [0, 1],
    lightness: 0.42,
    timbre: { inharmonic: 0.14, resonance: 0.35, filterEnv: 0.7, filterDecayMs: 220, transient: 0.22, unison: 2, spread: 0.5 },
    space: 0.32,
    echo: 0.34,
    duck: { by: 'kick', amount: 0.35 },
    eq: { lowCut: 180, peaks: [{ freq: 600, gain: -2, q: 1 }], highShelf: { freq: 4000, gain: 3 } },
    lfo: [{ target: 'lightness', depth: 0.12, beats: 16, phase: v * 0.05 }],
    automation: { lightness: [{ t: at(4), v: -0.12 }, { t: at(8), v: 0.08 }], gain: BUILD_TO_DROP },
    notes,
  })),
  ...padVoices.map((notes, v) => ({
    id: `pad-${v + 1}`,
    hue: 215,
    channel: [0, 1],
    lightness: 0.34,
    space: 0.7,
    duck: { by: 'kick', amount: 0.45 },
    eq: { lowCut: 250, highShelf: { freq: 7000, gain: -3 } },
    lfo: [
      { target: 'lightness', depth: 0.08, beats: 8, phase: v / 3 },
      { target: 'pan', depth: 0.25, beats: 12, phase: v / 3 },
    ],
    automation: {
      lightness: [{ t: 0, v: -0.22 }, { t: at(4), v: -0.05 }, { t: at(8), v: 0.12 }],
      gain: [{ t: 0, v: 0.55 }, { t: at(4), v: 0.85 }, { t: at(8), v: 1 }],
    },
    notes,
  })),
  {
    id: 'hook',
    hue: 258,
    channel: [0, 1],
    lightness: 0.55,
    timbre: { noise: 0.1, attackMs: 18 },
    space: 0.42,
    echo: 0.3,
    eq: { lowCut: 300, peaks: [{ freq: 2800, gain: 4, q: 0.9 }], highShelf: { freq: 7000, gain: 2 } },
    comp: { threshold: -18, ratio: 2.5, attackMs: 5, releaseMs: 120, makeup: 1.5 },
    lfo: [{ target: 'pitch', depth: 0.16, rate: 5.3 }],
    notes: lead,
  },
  {
    id: 'riser',
    hue: 335,
    channel: [0, 1],
    lightness: 0.45,
    space: 0.6,
    timbre: { transient: 0.1, attackMs: 30 },
    eq: { lowCut: 600 },
    lfo: [{ target: 'pan', depth: 0.6, beats: 1 }],
    automation: {
      gain: [{ t: at(6), v: 0.05 }, { t: r(at(8) - 0.05), v: 1 }],
      lightness: [{ t: at(6), v: -0.35 }, { t: r(at(8) - 0.05), v: 0.45 }, { t: at(8), v: 0.4 }],
    },
    notes: fx,
  },
];

const score = {
  sampleRate: 44100,
  duration: r(END + 2.4),
  seed: 5005,
  bpm: BPM,
  swing: 0.42,
  swingGrid: 16,
  master: {
    loudness: -13,
    drive: 0.22,
    reverb: { size: 0.72, decay: 0.55 },
    delay: { beats: 0.75, feedback: 0.36 },
    comp: { threshold: -9, ratio: 2, attackMs: 15, releaseMs: 160, knee: 6, makeup: 0 },
  },
  tracks,
};

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'deep-house-v5.json');
writeFileSync(out, JSON.stringify(score, null, 2) + '\n');
console.log(`wrote ${out} (${tracks.length} tracks, ${score.duration}s)`);
