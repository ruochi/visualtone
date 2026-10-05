import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { sampleAt, prepareTrackPoints } from './interpolator.js';
import { expandNotes } from './notes.js';
import { hueToTimbre, midiToFrequency } from './synth.js';
import { render } from './renderer.js';
import { ScoreSchema } from './schema.js';

test('sampleAt - linear interpolation with explicit ease', () => {
  const points = [
    { t: 0, y: 60, size: 0.5 },
    { t: 1, y: 72, size: 1.0, ease: 'linear' as const },
  ];

  const result = sampleAt(points, 0.5);
  assert.ok(result !== null);
  assert.equal(result.y, 66);
  assert.equal(result.size, 0.75);
});

test('sampleAt - silence between two zero points', () => {
  const points = [
    { t: 0, y: 60, size: 0.5 },
    { t: 0.1, y: 60, size: 0, ease: 'exp' as const },
    { t: 0.5, y: 60, size: 0 },
    { t: 0.6, y: 60, size: 0.8, ease: 'step' as const },
  ];
  assert.equal(sampleAt(points, 0.3), null);
});

test('sampleAt - step attack holds silence until onset', () => {
  const points = [
    { t: 0, y: 60, size: 0 },
    { t: 0.5, y: 60, size: 0.8, ease: 'step' as const },
  ];
  assert.equal(sampleAt(points, 0.25), null);
  const at = sampleAt(points, 0.5);
  assert.ok(at && at.size > 0.79);
});

test('expandNotes - hold creates sustain and release', () => {
  const pts = expandNotes([{ t: 1, y: 60, size: 0.5, duration: 0.5 }]);
  assert.ok(pts.length >= 3);
  assert.equal(pts[0].t, 1);
  assert.equal(pts[0].ease, 'step');
  const last = pts[pts.length - 1];
  assert.equal(last.size, 0);
});

test('expandNotes - exp creates two-point decay', () => {
  const pts = expandNotes([{ t: 0, y: 36, size: 0.9, duration: 0.15, ease: 'exp' }]);
  assert.equal(pts.length, 2);
  assert.equal(pts[1].ease, 'exp');
  assert.equal(pts[1].t, 0.15);
});

test('hueToTimbre - ring continuity at 0 and 360', () => {
  const a = hueToTimbre(359);
  const b = hueToTimbre(0);
  assert.ok(Math.abs(a.noise - b.noise) < 0.15);
});

test('midiToFrequency - A4 = 440Hz', () => {
  assert.ok(Math.abs(midiToFrequency(69) - 440) < 0.01);
});

function spectralCentroid(buf: Float32Array, sr: number): number {
  const n = Math.min(buf.length, 4096);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const w = buf[i] * buf[i];
    num += (i * sr) / n * w;
    den += w;
  }
  return den > 0 ? num / den : 0;
}

test('timbre - lightness raises spectral centroid', () => {
  const scoreLo = ScoreSchema.parse({
    sampleRate: 44100,
    duration: 0.2,
    seed: 1,
    tracks: [
      {
        id: 't',
        hue: 150,
        channel: 0,
        points: [
          { t: 0, y: 64, size: 0.7, lightness: 0.15, ease: 'step' },
          { t: 0.2, y: 64, size: 0.7, lightness: 0.15 },
        ],
      },
    ],
  });
  const scoreHi = ScoreSchema.parse({
    ...scoreLo,
    tracks: [
      {
        ...scoreLo.tracks[0],
        points: [
          { t: 0, y: 64, size: 0.7, lightness: 0.95, ease: 'step' },
          { t: 0.2, y: 64, size: 0.7, lightness: 0.95 },
        ],
      },
    ],
  });
  const lo = render(scoreLo).buffers[0];
  const hi = render(scoreHi).buffers[0];
  assert.ok(spectralCentroid(hi, 44100) > spectralCentroid(lo, 44100));
});

test('render - exp kick attack louder than tail', () => {
  const score = ScoreSchema.parse({
    sampleRate: 44100,
    duration: 0.3,
    seed: 42,
    tracks: [
      {
        id: 'kick',
        hue: 0,
        channel: 0,
        notes: [{ t: 0, y: 36, size: 0.9, duration: 0.15, ease: 'exp' }],
      },
    ],
  });
  const buf = render(score).buffers[0];
  const sr = 44100;
  const win = Math.floor(0.02 * sr);
  let early = 0;
  let late = 0;
  for (let i = 0; i < win; i++) early += buf[i] ** 2;
  for (let i = Math.floor(0.1 * sr); i < Math.floor(0.1 * sr) + win; i++) late += buf[i] ** 2;
  early = Math.sqrt(early / win);
  late = Math.sqrt(late / win);
  assert.ok(early > late * 3);
});

test('render - deterministic wav hash', () => {
  const score = ScoreSchema.parse({
    sampleRate: 44100,
    duration: 0.05,
    seed: 99,
    tracks: [
      {
        id: 'a',
        hue: 40,
        channel: 0,
        notes: [{ t: 0, y: 60, size: 0.5, duration: 0.05 }],
      },
    ],
  });
  const h1 = createHash('sha256').update(render(score).wav).digest('hex');
  const h2 = createHash('sha256').update(render(score).wav).digest('hex');
  assert.equal(h1, h2);
});

test('render - multi-track and normalization', () => {
  const score = ScoreSchema.parse({
    sampleRate: 44100,
    duration: 0.1,
    tracks: [
      {
        id: 'track-1',
        hue: 120,
        channel: 0,
        points: [{ t: 0, y: 60, size: 0.5, ease: 'step' }, { t: 0.1, y: 60, size: 0.5 }],
      },
      {
        id: 'track-2',
        hue: 240,
        channel: 1,
        points: [{ t: 0, y: 72, size: 0.3, ease: 'step' }, { t: 0.1, y: 72, size: 0.3 }],
      },
    ],
  });
  const result = render(score);
  assert.equal(result.buffers.length, 2);
  const peak = Math.max(...Array.from(result.buffers[0]).map(Math.abs));
  assert.ok(peak <= 1.0);
});

test('prepareTrackPoints merges notes and points', () => {
  const track = ScoreSchema.parse({
    sampleRate: 44100,
    tracks: [
      {
        id: 'x',
        hue: 0,
        channel: 0,
        points: [{ t: 0, y: 60, size: 0.5 }],
        notes: [{ t: 1, y: 62, size: 0.4, duration: 0.2 }],
      },
    ],
  }).tracks[0];
  const pts = prepareTrackPoints(track);
  assert.ok(pts.length > 2);
});
