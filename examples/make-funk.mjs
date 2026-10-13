// Writes examples/funk.json: 16 bars of electro-funk at 112 BPM in E minor.
// Usage: node examples/make-funk.mjs
import { writeFileSync } from 'node:fs';

const bpm = 112;
const beat = 60 / bpm;
const s16 = beat / 4;
const bars = 16;
const swing = 0.12; // push every second 16th later, by this fraction of a 16th
const at = (bar, step) => bar * 16 * s16 + step * s16 + (step % 2 ? swing * s16 : 0);

const drums = [];
const bass = [];
const keys = [];
const lead = [];
const fx = [];

// Em7 - A7 - Dmaj7 - Bm7, one chord per bar (voicings around middle C).
const chords = [
  { root: 'E', bass: 28, voicing: [55, 59, 62, 64] },
  { root: 'A', bass: 33, voicing: [55, 57, 61, 64] },
  { root: 'D', bass: 26, voicing: [54, 57, 61, 62] },
  { root: 'B', bass: 35, voicing: [54, 57, 59, 62] },
];

// Syncopated bass: [step, semitones above root, length in 16ths, accent]
const bassRiff = [
  [0, 0, 2, 1], [3, 12, 1, 0.6], [4, 0, 1, 0.8], [6, 10, 1, 0.7],
  [7, 12, 1, 0.9], [10, 7, 2, 0.8], [12, 0, 1, 0.7], [14, 3, 1, 0.8], [15, 5, 1, 0.6],
];

for (let bar = 0; bar < bars; bar++) {
  const ch = chords[bar % 4];
  const section = bar < 4 ? 'intro' : bar < 12 ? 'groove' : 'break';
  const last = bar === bars - 1;

  // Drums: four-on-the-floor kick with a ghost, backbeat snare + clap, 16th hats.
  for (const step of [0, 4, 8, 12]) drums.push({ t: at(bar, step), pitch: 36, size: 0.95, duration: 0.3 });
  if (section !== 'intro') drums.push({ t: at(bar, 10), pitch: 36, size: 0.5, duration: 0.2 });
  for (const step of [4, 12]) {
    if (section === 'intro' && bar < 2) continue;
    drums.push({ t: at(bar, step), pitch: 38, size: 0.85, duration: 0.2 });
    if (section !== 'intro') drums.push({ t: at(bar, step), pitch: 39, size: 0.5, duration: 0.2 });
  }
  if (section !== 'intro') drums.push({ t: at(bar, 15), pitch: 38, size: 0.25, duration: 0.1 }); // ghost
  for (let step = 0; step < 16; step++) {
    const open = step % 4 === 2;
    drums.push({ t: at(bar, step), pitch: open ? 46 : 42, size: open ? 0.45 : step % 2 ? 0.3 : 0.5, duration: 0.1 });
  }
  if (bar % 4 === 3 && !last) {
    // Tom fill on the last beat of every 4th bar.
    [12, 13, 14, 15].forEach((s, i) => drums.push({ t: at(bar, s), pitch: [50, 47, 45, 45][i], size: 0.7, duration: 0.2 }));
  }

  // Bass enters after 2 bars.
  if (bar >= 2) {
    for (const [step, semi, len, acc] of bassRiff) {
      bass.push({ t: at(bar, step), pitch: ch.bass + semi, size: acc, duration: len * s16 * 0.85 });
    }
  }

  // Keys: short chord stabs on the off-beats.
  if (bar >= 4) {
    for (const step of [2, 7, 10, 14]) {
      for (const p of ch.voicing) keys.push({ t: at(bar, step), pitch: p, size: 0.6, duration: s16 * 1.2 });
    }
  }

  // Lead hook in the groove section: E minor pentatonic call and answer.
  if (section === 'groove') {
    const hook = bar % 2 === 0
      ? [[0, 76, 2], [3, 79, 1], [4, 81, 2], [7, 79, 1], [8, 76, 3], [12, 74, 2], [14, 76, 2]]
      : [[0, 79, 1], [2, 81, 1], [4, 83, 3], [8, 81, 1], [10, 79, 1], [12, 76, 4]];
    for (const [step, p, len] of hook) lead.push({ t: at(bar, step), pitch: p, size: 0.75, duration: len * s16 * 0.9 });
  }
}

// Riser into the groove and into the break, impact on the downbeats.
fx.push({ sfx: 'riser', t: at(2, 0), duration: 2 * 16 * s16, size: 0.4 });
fx.push({ sfx: 'impact', t: at(4, 0), size: 0.6 });
fx.push({ sfx: 'whoosh', t: at(11, 8), duration: 8 * s16, size: 0.5 });
fx.push({ sfx: 'impact', t: at(12, 0), size: 0.5 });

const score = {
  version: 1,
  sampleRate: 48000,
  seed: 7,
  tracks: [
    { id: 'drums', instrument: 'drums', gain: -2, lowCut: 30, notes: drums, reverb: 0.08 },
    { id: 'bass', instrument: 'bass', gain: -5, lightness: 0.5, lowCut: 35, notes: bass, duck: { by: 'drums', amount: 0.25, release: 0.12 } },
    { id: 'keys', instrument: 'keys', gain: -7, pan: -0.25, lowCut: 200, notes: keys, reverb: 0.25, delay: 0.15 },
    { id: 'lead', instrument: 'lead', gain: -6, pan: 0.2, lightness: 0.55, notes: lead, reverb: 0.3, delay: 0.25 },
    { id: 'fx', role: 'sfx', gain: -10, sfx: fx, reverb: 0.4 },
  ],
  master: { loudness: -16, ceiling: -1, reverb: { size: 0.5, damping: 0.5 }, delay: { time: beat * 0.75, feedback: 0.35 } },
};

writeFileSync(new URL('./funk.json', import.meta.url), JSON.stringify(score, null, 2));
console.log(`examples/funk.json: ${score.tracks.map((t) => `${t.id} ${(t.notes ?? t.sfx).length}`).join(', ')}`);
