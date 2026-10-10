#!/usr/bin/env node
// D-minor electro, 122 BPM. Intro, kick, main, break, drop.
// Writes examples/electro.json. Run: node examples/scripts/electro.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BARS = 28;
const CHORDS = [
  { sub: 'D1', off: 'D2', fifth: 'A2', epi: ['D3', 'F3', 'A3', 'C4'], pad: ['D4', 'A4', 'C5'] },
  { sub: 'Bb1', off: 'Bb2', fifth: 'F3', epi: ['Bb2', 'D3', 'F3', 'A3'], pad: ['D4', 'F4', 'Bb4'] },
  { sub: 'F1', off: 'F2', fifth: 'C3', epi: ['F3', 'A3', 'C4', 'E4'], pad: ['C4', 'F4', 'A4'] },
  { sub: 'C1', off: 'C2', fifth: 'G2', epi: ['C3', 'E3', 'G3', 'Bb3'], pad: ['G3', 'C4', 'E4'] },
];
const LEAD = [
  [
    ['D5', 1, '1/8'],
    ['F5', 1.5, '1/8'],
    ['E5', 2, '1/4'],
    ['D5', 3, '1/4'],
    ['C5', 4, '1/4'],
  ],
  [
    ['D5', 1, '1/8'],
    ['F5', 1.5, '1/8'],
    ['G5', 2, '1/4'],
    ['F5', 3, '1/4'],
    ['D5', 4, '1/4'],
  ],
  [
    ['A4', 1, '1/8'],
    ['C5', 1.5, '1/4'],
    ['E5', 2.5, '1/4'],
    ['C5', 3.5, '1/4'],
    ['A4', 4.5, '1/8'],
  ],
  [
    ['G4', 1, '1/4'],
    ['Bb4', 2, '1/8'],
    ['C5', 2.5, '1/4'],
    ['D5', 3.5, '1/4'],
    ['C5', 4.5, '1/8'],
  ],
];

const chord = (bar) => CHORDS[(bar - 1) % 4];
const inMain = (bar) => (bar >= 9 && bar <= 16) || (bar >= 21 && bar <= 28);
const inBeat = (bar) => (bar >= 5 && bar <= 16) || (bar >= 21 && bar <= 28);
const note = (bar, beat, pitch, len, size, ease = 'exp') => ({
  at: `${bar}:${beat}`,
  pitch,
  len,
  size: Math.round(size * 1000) / 1000,
  ease,
});

const kick = [];
const snare = [];
const hat = [];
const openHat = [];
const crash = [];
const sub = [];
const offbeat = [];
const reese = [];
const epi = [];
const pad = [];
const lead = [];

for (let bar = 1; bar <= BARS; bar++) {
  const c = chord(bar);
  const drop = bar >= 21;

  if (inBeat(bar)) {
    for (const beat of [1, 2, 3, 4]) {
      if (bar === 16 && beat === 4) continue;
      kick.push(note(bar, beat, 'C1', '1/16', beat === 1 ? 0.94 : beat === 3 ? 0.86 : 0.78));
    }
  }

  if (inMain(bar)) {
    snare.push(note(bar, 2, 'A3', '1/16', 0.84));
    snare.push(note(bar, 4, 'A3', '1/16', bar % 4 === 0 ? 0.76 : 0.86));
    if (bar % 4 === 0) snare.push(note(bar, 4.75, 'C4', '1/16', 0.38));
  }
  if (bar === 20) {
    for (let i = 0; i < 8; i++) {
      const beat = 3 + i * 0.25;
      snare.push(note(bar, beat, i % 2 ? 'C4' : 'A3', '1/16', 0.28 + i * 0.07));
    }
  }

  const hatGrid = inMain(bar) ? 16 : 8;
  const hatStep = hatGrid === 16 ? 0.25 : 0.5;
  if (bar <= 16 || bar >= 21 || (bar >= 18 && bar <= 20)) {
    for (let i = 0; i < hatGrid; i++) {
      const beat = 1 + i * hatStep;
      const down = hatGrid === 8 || i % 2 === 0;
      if (hatGrid === 16 && i % 4 === 3 && bar % 2 === 0) continue;
      const quiet = bar <= 4 ? 0.55 : bar >= 17 && bar <= 20 ? 0.7 : 1;
      hat.push(note(bar, beat, 'G6', '1/16', (down ? 0.46 : 0.22) * quiet));
    }
  }
  if (inMain(bar)) openHat.push(note(bar, 2.5, 'E6', '1/8', drop ? 0.4 : 0.32));
  if (bar === 9 || bar === 21) crash.push(note(bar, 1, 'G4', '1/2', 0.7));

  const subSize = bar <= 4 ? 0.2 : bar >= 17 && bar <= 20 ? 0.26 : 0.76;
  if (bar >= 17 && bar <= 20) {
    sub.push(note(bar, 1, c.sub, '1/2', subSize, 'hold'));
    sub.push(note(bar, 3, c.sub, '1/2', subSize * 0.85, 'hold'));
  } else {
    sub.push(note(bar, 1, c.sub, '1/1', subSize, 'hold'));
  }

  if (inMain(bar)) {
    for (const beat of [1.5, 2.5, 3.5, 4.5]) {
      const up = beat === 2.5 || beat === 4.5;
      offbeat.push(note(bar, beat, up ? c.fifth : c.off, '1/16', up ? 0.7 : 0.86));
    }
  }
  if (drop) reese.push(note(bar, 1, c.off, '1/1', 0.34, 'hold'));

  const stab = (beat, len, size) => {
    for (const pitch of c.epi) epi.push(note(bar, beat, pitch, len, size, 'exp'));
  };
  if (bar >= 5 && bar <= 8) stab(1, '1/8', 0.42);
  if (inMain(bar)) {
    stab(1, '1/4', drop ? 0.46 : 0.4);
    stab(2.5, '1/8', 0.28);
  }
  if (bar >= 17 && bar <= 20) stab(1, '1/1', 0.4);

  const padSize = bar <= 4 ? 0.16 : bar >= 17 && bar <= 20 ? 0.34 : 0.22;
  for (const pitch of c.pad) pad.push(note(bar, 1, pitch, '1/1', padSize, 'hold'));

  if (inMain(bar)) {
    const phrase = LEAD[(bar - 1) % 4];
    for (const [pitch, beat, len] of phrase) {
      lead.push(note(bar, beat, pitch, len, drop ? 0.72 : 0.64, 'exp'));
    }
  }
}

sub.push(note(29, 1, 'D1', '1/1', 0.7, 'hold'));
for (const pitch of ['D3', 'F3', 'A3', 'C4']) epi.push(note(29, 1, pitch, '1/2', 0.5));
for (const pitch of ['D4', 'A4', 'C5']) pad.push(note(29, 1, pitch, '1/1', 0.48, 'hold'));
lead.push(note(29, 1, 'D5', '1/2', 0.6));
kick.push(note(29, 1, 'C1', '1/8', 0.9));
crash.push(note(29, 1, 'G4', '1/2', 0.55));

const score = {
  sampleRate: 48000,
  duration: 59,
  bpm: 122,
  meter: [4, 4],
  swing: 0.22,
  swingGrid: 16,
  seed: 122,
  master: {
    lufs: -14,
    saturation: 0.16,
    drive: 0.08,
    room: { size: 0.28, decay: 0.18, preDelayMs: 6, damping: 0.4, width: 0.6 },
    reverb: { size: 0.55, decay: 0.42, preDelayMs: 18, damping: 0.48, width: 0.86 },
    delay: { beats: 0.75, feedback: 0.28 },
    eq: {
      lowCut: 28,
      peaks: [
        { freq: 55, gain: 1.5, q: 0.9 },
        { freq: 320, gain: -1.5, q: 0.8 },
      ],
      highShelf: { freq: 8000, gain: 1.6 },
    },
    comp: { threshold: -12, ratio: 2, attackMs: 12, releaseMs: 140, knee: 6, makeup: 0 },
    limiter: { ceiling: -1, lookaheadMs: 4, releaseMs: 50 },
  },
  tracks: [
    {
      id: 'kick',
      instrument: 'kick',
      channel: [0, 1],
      pan: 0,
      swing: 0,
      seed: 3,
      room: 0.06,
      humanize: { timeMs: 2, size: 0.02 },
      notes: kick,
    },
    {
      id: 'snare',
      instrument: 'snare',
      channel: [0, 1],
      pan: 0.06,
      swing: 0,
      seed: 5,
      room: 0.12,
      humanize: { timeMs: 4, size: 0.03 },
      notes: snare,
    },
    {
      id: 'hat',
      instrument: 'hihat-closed',
      channel: [0, 1],
      pan: -0.28,
      seed: 9,
      room: 0.04,
      space: 0.06,
      humanize: { timeMs: 5, size: 0.04 },
      notes: hat,
    },
    {
      id: 'open-hat',
      instrument: 'hihat-open',
      channel: [0, 1],
      pan: 0.32,
      automation: { gain: [{ t: 0, v: 0.45 }] },
      seed: 11,
      room: 0.08,
      space: 0.1,
      notes: openHat,
    },
    {
      id: 'crash',
      instrument: 'crash',
      channel: [0, 1],
      pan: 0,
      swing: 0,
      seed: 13,
      space: 0.2,
      notes: crash,
    },
    {
      id: 'sub',
      instrument: 'sub-bass',
      channel: [0, 1],
      pan: 0,
      swing: 0,
      seed: 17,
      duck: { by: 'kick', amount: 0.72, holdMs: 20, releaseMs: 160 },
      notes: sub,
    },
    {
      id: 'offbeat',
      instrument: 'offbeat-bass',
      channel: [0, 1],
      pan: -0.06,
      seed: 19,
      duck: { by: 'kick', amount: 0.45, holdMs: 10, releaseMs: 90, band: [40, 280] },
      notes: offbeat,
    },
    {
      id: 'reese',
      instrument: 'reese-bass',
      channel: [0, 1],
      pan: 0.04,
      swing: 0,
      seed: 23,
      room: 0.08,
      duck: { by: 'kick', amount: 0.55, holdMs: 16, releaseMs: 140, band: [50, 400] },
      notes: reese,
    },
    {
      id: 'epiano',
      instrument: 'electric-piano',
      channel: [0, 1],
      pan: 0.18,
      swing: 0,
      seed: 29,
      room: 0.14,
      echo: 0.18,
      release: 80,
      notes: epi,
    },
    {
      id: 'pad',
      instrument: 'synth-pad',
      channel: [0, 1],
      pan: -0.22,
      swing: 0,
      seed: 31,
      space: 0.42,
      room: 0.16,
      echo: 0.12,
      release: 400,
      lfo: [{ target: 'lightness', depth: 0.06, beats: 2, shape: 'sine' }],
      notes: pad,
    },
    {
      id: 'lead',
      instrument: 'synth-lead',
      channel: [0, 1],
      pan: 0.08,
      swing: 0,
      seed: 37,
      space: 0.22,
      echo: 0.32,
      release: 90,
      timbre: { unison: 2, detuneCents: 7, attackMs: 8 },
      notes: lead,
    },
    {
      id: 'fx',
      channel: [0, 1],
      role: 'sfx',
      seed: 41,
      sfx: [
        { sfx: 'whoosh', at: '17:1', len: '1/2', size: 0.4, direction: -0.5, brightness: 0.55 },
        { sfx: 'riser', at: '20:1', len: '1/1', size: 0.5, brightness: 0.72 },
        { sfx: 'impact', at: '21:1', size: 0.62, low: 0.55, tail: 0.7 },
      ],
    },
  ],
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'electro.json');
writeFileSync(dest, JSON.stringify(score, null, 2) + '\n');
const counts = Object.fromEntries(
  score.tracks.map((t) => [t.id, (t.notes ?? t.sfx).length]),
);
console.log('wrote', dest, counts);
