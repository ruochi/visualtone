#!/usr/bin/env node
// Generates examples/deep-house-v7.json — v6 arrangement, thicker, wetter, less mechanical.
// intro 0-3 | build 4-7 | drop A 8-15 | breakdown 16-19 | drop B 20-27 | outro 28-31
// Run: node examples/scripts/deep-house-v7.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BPM = 122;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const S16 = BEAT / 4;
const BARS = 32;
const END = BARS * BAR;
const r = (x) => Math.round(x * 10000) / 10000;
const at = (bar, beat = 0) => r(bar * BAR + beat * BEAT);

const BREAK = [16, 20];
const DROP_B = [20, 28];
const inside = (bar, [a, b]) => bar >= a && bar < b;
// Fills are not 4 or 8 bars apart, so a lag-4/8 comparison cannot pair two fills.
const FILL = new Set([6, 10, 12, 15, 21, 24, 26, 29]);
const fill = (bar) => FILL.has(bar) && !inside(bar, BREAK);

// Fm9 | Dbmaj9 | Bbm9 | Cm7(sus) — the bass lands on F at every phrase start.
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
  if (inside(bar, BREAK)) continue;
  const beats = bar === BARS ? [0] : [0, 1, 2, 3];
  for (const b of beats) {
    if ((bar === 7 || bar === 27) && b === 3) continue; // one-beat gap before each drop
    if (bar % 8 === 3 && b === 3) continue; // a hole every eight bars
    if (fill(bar) && (b === 1 || b === 2)) continue; // two-beat hole on fill bars
    const size = b === 0 ? 0.95 : b === 2 ? 0.84 : 0.74;
    kick.push({ t: at(bar, b), y: 28, size, duration: bar === BARS ? 0.6 : 0.3, ease: 'exp' });
  }
}

const clap = [];
for (let bar = 4; bar < 30; bar++) {
  if (inside(bar, BREAK)) continue;
  for (const b of [1, 3]) clap.push({ t: at(bar, b), y: 62, size: 0.9, duration: 0.16, ease: 'exp' });
  if (bar % 4 === 3) clap.push({ t: at(bar, 3.75), y: 64, size: 0.45, duration: 0.08, ease: 'exp' });
}
// Clap roll at the end of the breakdown.
for (let s = 0; s < 16; s++) {
  if (s % 2 && s < 8) continue;
  clap.push({ t: r(19 * BAR + s * S16), y: 62 + s * 0.25, size: r(0.25 + 0.04 * s), duration: 0.07, ease: 'exp' });
}

const openHat = [];
for (let bar = 0; bar < 31; bar++) {
  if (inside(bar, BREAK) && bar < 18) continue;
  if (fill(bar)) {
    for (let s = 0; s < 16; s++) {
      openHat.push({ t: r(bar * BAR + s * S16), y: 94, size: s % 4 === 0 ? 0.7 : 0.42, duration: 0.06, ease: 'exp' });
    }
    continue;
  }
  for (const b of [0.5, 1.5, 2.5, 3.5]) {
    openHat.push({ t: at(bar, b), y: 92, size: bar < 2 || inside(bar, BREAK) ? 0.55 : 0.9, duration: 0.17, ease: 'exp' });
  }
}

const shaker = [];
const accent = [0.55, 0.26, 0, 0.4];
for (let bar = 2; bar < 31; bar++) {
  if (inside(bar, BREAK)) continue;
  for (let s = 0; s < 16; s++) {
    const a = accent[s % 4];
    if (a === 0) continue;
    shaker.push({ t: r(bar * BAR + s * S16), y: 100, size: a, duration: 0.05, ease: 'exp' });
  }
}

// Ride on every 8th in drop B for extra air and drive.
const ride = [];
for (let bar = DROP_B[0]; bar < DROP_B[1]; bar++) {
  for (let e = 0; e < 8; e++) {
    ride.push({ t: r(bar * BAR + e * 2 * S16), y: 104, size: e % 2 ? 0.7 : 0.45, duration: 0.32, ease: 'exp' });
  }
}

// ---------- bass ----------
const BASS_STEPS = [
  { s: 2, o: 0, d: 2.5 },
  { s: 6, o: 12, d: 0.8 },
  { s: 7, o: 0, d: 2 },
  { s: 10, o: 0, d: 2.5 },
  { s: 13, o: 12, d: 0.9 },
  { s: 14, o: 0, d: 1.6 },
];
// Drop B pushes one extra note into the gap for more motion.
const BASS_STEPS_B = [...BASS_STEPS.slice(0, 4), { s: 12, o: 7, d: 0.8 }, ...BASS_STEPS.slice(4)];
const bass = [];
for (let bar = 4; bar < 30; bar++) {
  const root = chordAt(bar).bass;
  if (inside(bar, BREAK)) {
    // Long sub notes under the breakdown, two per bar.
    bass.push({ t: at(bar), y: root, size: 0.32, duration: r(BAR / 2 - 0.02), ease: 'hold' });
    continue;
  }
  const steps = inside(bar, DROP_B) ? BASS_STEPS_B : BASS_STEPS;
  for (const st of steps) {
    if ((bar === 7 || bar === 27) && st.s >= 12) continue;
    const oct = fill(bar) ? 0 : st.o;
    bass.push({ t: r(bar * BAR + st.s * S16), y: root + oct, size: oct ? 0.4 : 0.78, duration: r(st.d * S16), ease: 'hold' });
  }
}
bass.push({ t: at(BARS), y: 41, size: 0.62, duration: 1.6, ease: 'exp' });
const bassMid = bass.map((n) => ({ ...n, y: n.y + 12, size: r(n.size * 0.38) }));
const keys = [];
for (let bar = 0; bar < BARS; bar++) {
  const pad = chordAt(bar).pad;
  const y = fill(bar) ? pad[0] - 12 : bar % 7 === 3 ? pad[2] - 12 : pad[1] - 12;
  keys.push({ t: at(bar), y, size: inside(bar, BREAK) ? 0.26 : 0.18, duration: r(BAR - 0.02), ease: 'hold' });
}

// ---------- chord stabs (4 mono voices) ----------
const STAB_STEPS = [3, 6, 10, 13];
const STAB_STEPS_B = [0, 3, 6, 10, 13, 15];
const stabVoices = [[], [], [], []];
for (let bar = 4; bar < 30; bar++) {
  const ch = chordAt(bar);
  let steps = inside(bar, DROP_B) ? STAB_STEPS_B : STAB_STEPS;
  if (inside(bar, BREAK)) steps = [0];
  if (fill(bar)) steps = [2, 6, 9, 14];
  const pitches = fill(bar) ? [ch.stab[0] + 12, ch.stab[1] + 3, ch.stab[2] + 7, ch.stab[3] + 12] : ch.stab;
  for (const s of steps) {
    if ((bar === 7 || bar === 27) && s >= 13) continue;
    if (s === 0 && bar % 2) continue;
    pitches.forEach((y, v) => {
      const size = fill(bar) ? 0.42 : inside(bar, BREAK) ? 0.42 : s === 15 ? 0.4 : 0.55;
      stabVoices[v].push({ t: r(bar * BAR + s * S16), y, size, duration: inside(bar, BREAK) ? 0.6 : 0.18, ease: 'exp' });
    });
  }
}

// ---------- pad (3 mono voices) ----------
const padVoices = [[], [], []];
for (let bar = 0; bar < BARS; bar++) {
  chordAt(bar).pad.forEach((y, v) => padVoices[v].push({ t: at(bar), y, size: 0.18, duration: r(BAR - 0.01), ease: 'hold' }));
}
CHORDS[0].pad.forEach((y, v) => padVoices[v].push({ t: at(BARS), y, size: 0.18, duration: 2.0, ease: 'exp' }));

// ---------- vocal-ish hook ----------
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
// Drop B answer phrase climbs to the 9th (G) instead of resolving down.
const HOOK_B = [
  { b: 0.5, y: 80, d: 0.45 },
  { b: 1, y: 82, d: 0.9 },
  { b: 2.5, y: 84, d: 0.45 },
  { b: 3, y: 82, d: 1.4 },
  { b: 5, y: 80, d: 0.45 },
  { b: 5.5, y: 84, d: 0.45 },
  { b: 6, y: 79, d: 1.6 },
];
const lead = [];
const phrases = [
  ...[0, 1, 2, 3].map((p) => ({ start: 8 + p * 2, notes: p === 3 ? [...HOOK.slice(0, 4), ...HOOK_ALT_END] : HOOK, size: 0.4 })),
  { start: 16, notes: HOOK, size: 0.15 },
  { start: 18, notes: HOOK.slice(0, 4), size: 0.2 },
  ...[0, 1, 2, 3].map((p) => ({
    start: 20 + p * 2,
    notes: p === 0 ? HOOK : p === 1 ? HOOK_B : p === 2 ? [...HOOK.slice(0, 4), ...HOOK_ALT_END] : HOOK_B.map((n, i) => (i === 6 ? { ...n, y: 87 } : n)),
    size: 0.4,
  })),
];
for (const ph of phrases) {
  for (const n of ph.notes) lead.push({ t: at(ph.start, n.b), y: n.y, size: ph.size, duration: r(n.d * BEAT), ease: 'hold' });
}

// ---------- risers into each drop + crash on the one ----------
const fx = [
  { t: at(6), y: 84, size: 0.42, duration: r(2 * BAR - 0.03), ease: 'hold' },
  { t: at(8), y: 88, size: 0.4, duration: 1.4, ease: 'exp' },
  { t: at(18), y: 84, size: 0.42, duration: r(2 * BAR - 0.03), ease: 'hold' },
  { t: at(20), y: 88, size: 0.42, duration: 1.6, ease: 'exp' },
];

// Section gain: build held back, breakdown pulled down, outro fades.
const SECTION_GAIN = [
  { t: 0, v: 0.68 },
  { t: r(at(8) - 0.01), v: 0.68 },
  { t: at(8), v: 1 },
  { t: r(at(16) - 0.01), v: 1 },
  { t: at(16), v: 0.45 },
  { t: r(at(20) - 0.01), v: 0.62 },
  { t: at(20), v: 1 },
  { t: at(28), v: 1 },
  { t: at(32), v: 0.55 },
];
const riserAuto = (bar) => [
  { t: at(bar), v: 0.05 },
  { t: r(at(bar + 2) - 0.05), v: 1 },
];

// ---------- tracks ----------
const tracks = [
  {
    id: 'kick',
    hue: 0,
    channel: [0, 1],
    lightness: 0.46,
    room: 0.18,
    humanize: { timeMs: 4, size: 0.28 },
    timbre: { pitchEnvSemis: 26, pitchEnvMs: 35, transient: 0.55, noise: 0.18, velocity: 0.45 },
    eq: { lowCut: 28, peaks: [{ freq: 300, gain: -1.5, q: 1.1 }, { freq: 3800, gain: 2.5, q: 1 }] },
    comp: { threshold: -14, ratio: 4, attackMs: 8, releaseMs: 90, makeup: 4 },
    notes: kick,
  },
  {
    id: 'clap',
    hue: 300,
    channel: [0, 1],
    lightness: 0.66,
    space: 0.2,
    room: 0.45,
    eq: { lowCut: 250, peaks: [{ freq: 1500, gain: 2, q: 0.9 }, { freq: 5000, gain: 3, q: 0.8 }] },
    humanize: { timeMs: 6, size: 0.14 },
    notes: clap,
  },
  {
    id: 'open-hat',
    hue: 335,
    channel: [0, 1],
    lightness: 0.8,
    room: 0.28,
    humanize: { timeMs: 6, size: 0.24 },
    eq: { lowCut: 1400, highShelf: { freq: 8000, gain: 3 } },
    automation: { gain: [{ t: 0, v: 0.6 }, { t: at(2), v: 1 }] },
    notes: openHat,
  },
  {
    id: 'shaker',
    hue: 335,
    channel: [0, 1],
    lightness: 0.7,
    timbre: { transient: 0.2, filterDecayMs: 20 },
    eq: { lowCut: 2500, highShelf: { freq: 8000, gain: 3 } },
    humanize: { timeMs: 8, size: 0.3 },
    lfo: [{ target: 'pan', depth: 0.45, beats: 4 }],
    notes: shaker,
  },
  {
    id: 'ride',
    hue: 340,
    channel: [0, 1],
    lightness: 0.85,
    saturation: 0.7,
    space: 0.25,
    timbre: { inharmonic: 0.55, transient: 0.3 },
    eq: { lowCut: 3000, highShelf: { freq: 10000, gain: 2 } },
    lfo: [{ target: 'pan', depth: 0.3, beats: 8, phase: 0.5 }],
    notes: ride,
  },
  {
    id: 'bass',
    hue: 30,
    channel: [0, 1],
    lightness: 0.32,
    timbre: { tilt: 1.5, resonance: 0.32, filterEnv: 0.45, filterDecayMs: 160, drive: 0.35, velocity: 0.35, drift: 0.25 },
    humanize: { timeMs: 5, size: 0.1 },
    duck: { by: 'kick', amount: 0.72 },
    eq: { lowCut: 32, peaks: [{ freq: 220, gain: -1.5, q: 1 }], highCut: 160 },
    comp: { threshold: -16, ratio: 3, attackMs: 6, releaseMs: 100, makeup: 1.5 },
    lfo: [{ target: 'lightness', depth: 0.06, beats: 8 }],
    automation: { gain: SECTION_GAIN },
    notes: bass,
  },
  {
    id: 'bass-mid',
    hue: 40,
    channel: [0, 1],
    lightness: 0.42,
    timbre: { drive: 0.6, velocity: 0.4, drift: 0.3, filterEnv: 0.4, filterDecayMs: 140 },
    humanize: { timeMs: 8, size: 0.12 },
    duck: { by: 'kick', amount: 0.55 },
    eq: { lowCut: 140, highCut: 1100, peaks: [{ freq: 800, gain: -3, q: 1 }] },
    release: 80,
    automation: { gain: SECTION_GAIN },
    notes: bassMid,
  },
  {
    id: 'keys',
    hue: 110,
    channel: [0, 1],
    lightness: 0.48,
    release: 400,
    space: 0.75,
    room: 0.2,
    chorus: { depth: 0.45, rateHz: 0.35, mix: 0.4 },
    timbre: { velocity: 0.4, drift: 0.35, attackMs: 25 },
    humanize: { timeMs: 10, size: 0.18 },
    duck: { by: 'kick', amount: 0.3 },
    eq: { lowCut: 140, peaks: [{ freq: 350, gain: 1.5, q: 0.8 }] },
    automation: { gain: [{ t: 0, v: 0.7 }, { t: at(8), v: 1 }, { t: at(16), v: 1.2 }, { t: at(20), v: 1 }, { t: at(30), v: 0.7 }] },
    notes: keys,
  },
  ...stabVoices.map((notes, v) => ({
    id: `stab-${v + 1}`,
    hue: 90,
    channel: [0, 1],
    lightness: 0.74,
    timbre: { inharmonic: 0.14, resonance: 0.35, filterEnv: 0.7, filterDecayMs: 220, transient: 0.22, unison: 2, spread: 0.5, velocity: 0.6, drift: 0.4 },
    humanize: { timeMs: 7, size: 0.12 },
    space: 0.4,
    room: 0.35,
    echo: 0.34,
    release: 250,
    duck: { by: 'kick', amount: 0.35 },
    eq: { lowCut: 380, peaks: [{ freq: 900, gain: -3, q: 0.9 }], highShelf: { freq: 5500, gain: 5 } },
    lfo: [{ target: 'lightness', depth: 0.1, beats: 16, phase: v * 0.05 }],
    automation: {
      lightness: [
        { t: at(4), v: -0.2 },
        { t: at(8), v: 0 },
        { t: at(16), v: -0.12 },
        { t: at(20), v: 0.06 },
        { t: at(28), v: 0.06 },
        { t: at(30), v: -0.2 },
      ],
      gain: SECTION_GAIN,
    },
    notes,
  })),
  ...padVoices.map((notes, v) => ({
    id: `pad-${v + 1}`,
    hue: 215,
    channel: [0, 1],
    lightness: 0.36,
    space: 0.85,
    room: 0.15,
    humanize: { timeMs: 8, size: 0.2 },
    duck: { by: 'kick', amount: 0.45 },
    eq: { lowCut: 160, peaks: [{ freq: 900, gain: -3.5, q: 0.8 }] },
    lfo: [
      { target: 'lightness', depth: 0.08, beats: 8, phase: v / 3 },
      { target: 'pan', depth: 0.3, beats: 12, phase: v / 3 },
    ],
    automation: {
      lightness: [
        { t: 0, v: -0.22 },
        { t: at(4), v: -0.05 },
        { t: at(8), v: 0.1 },
        { t: at(16), v: 0.2 },
        { t: at(20), v: 0.08 },
        { t: at(32), v: -0.15 },
      ],
      gain: [
        { t: 0, v: 0.55 },
        { t: at(4), v: 0.85 },
        { t: at(8), v: 1 },
        { t: at(16), v: 0.9 },
        { t: r(at(20) - 0.01), v: 1 },
        { t: at(20), v: 1 },
      ],
    },
    notes,
  })),
  {
    id: 'hook',
    hue: 258,
    channel: [0, 1],
    lightness: 0.68,
    timbre: { noise: 0.1, attackMs: 18, velocity: 0.6, drift: 0.4 },
    humanize: { timeMs: 8, size: 0.1 },
    space: 0.62,
    room: 0.2,
    echo: 0.32,
    release: 180,
    eq: { lowCut: 480, peaks: [{ freq: 3500, gain: 3.5, q: 0.9 }], highShelf: { freq: 6000, gain: 3.5 } },
    comp: { threshold: -18, ratio: 2.5, attackMs: 5, releaseMs: 120, makeup: 1.5 },
    lfo: [{ target: 'pitch', depth: 0.16, rate: 5.3 }],
    automation: {
      lightness: [
        { t: at(8), v: 0 },
        { t: at(16), v: -0.25 },
        { t: r(at(20) - 0.01), v: -0.05 },
        { t: at(20), v: 0.05 },
      ],
    },
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
      gain: [...riserAuto(6), { t: at(8), v: 0.9 }, { t: r(at(18) - 0.01), v: 0.9 }, ...riserAuto(18), { t: at(20), v: 0.95 }],
      lightness: [
        { t: at(6), v: -0.35 },
        { t: r(at(8) - 0.05), v: 0.4 },
        { t: at(8), v: 0.35 },
        { t: at(18), v: -0.35 },
        { t: r(at(20) - 0.05), v: 0.45 },
        { t: at(20), v: 0.4 },
      ],
    },
    notes: fx,
  },
];

const score = {
  sampleRate: 44100,
  duration: r(END + 2.4),
  seed: 7007,
  bpm: BPM,
  swing: 0.42,
  swingGrid: 16,
  master: {
    loudness: -12,
    drive: 0.16,
    saturation: 0.3,
    reverb: { size: 0.78, decay: 0.62, preDelayMs: 25, damping: 0.45, width: 0.9 },
    room: { size: 0.45, decay: 0.35, preDelayMs: 8, damping: 0.3, width: 0.55 },
    delay: { beats: 0.75, feedback: 0.36 },
    eq: { lowCut: 22, peaks: [{ freq: 48, gain: 2.5, q: 1.1 }, { freq: 950, gain: -3.5, q: 0.8 }, { freq: 4800, gain: 3.6, q: 0.8 }], highShelf: { freq: 9000, gain: 2.4 } },
    comp: { threshold: -9, ratio: 2.2, attackMs: 15, releaseMs: 160, knee: 6, makeup: 0 },
    limiter: { ceiling: -1, lookaheadMs: 5, releaseMs: 60 },
  },
  tracks,
};

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'deep-house-v7.json');
writeFileSync(out, JSON.stringify(score, null, 2) + '\n');
console.log(`wrote ${out} (${tracks.length} tracks, ${score.duration}s)`);
