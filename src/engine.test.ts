import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildWavetable, clearWavetableCache } from './wavetable.js';
import { hueToTimbreVector } from './timbre.js';
import { spectralCentroid, stereoCorrelation, measureRmsDb } from './fx.js';
import { render } from './renderer.js';
import { ScoreSchema } from './schema.js';
import { getJsonSchema } from './json-schema.js';
import { vectorHash } from './timbre.js';

test('wavetable cache hit', () => {
  clearWavetableCache();
  const v = hueToTimbreVector(160);
  const a = buildWavetable(v);
  const b = buildWavetable(v);
  assert.equal(a, b);
});

test('hue ring continuity 359 vs 0', () => {
  const a = hueToTimbreVector(359.9);
  const b = hueToTimbreVector(0);
  assert.ok(Math.abs(a.noise - b.noise) < 0.2);
  assert.ok(Math.abs(a.tilt - b.tilt) < 0.5);
});

test('anchor noiseColor hat > kick', () => {
  const kick = hueToTimbreVector(0);
  const snare = hueToTimbreVector(300);
  const hat = hueToTimbreVector(335);
  assert.ok(hat.noiseColor > kick.noiseColor);
  assert.ok(snare.noise > kick.noise * 0.5);
});

test('kick pitch envelope - early ZCR higher', () => {
  const score = ScoreSchema.parse({
    sampleRate: 44100,
    duration: 0.2,
    tracks: [{ id: 'k', hue: 0, channel: 0, notes: [{ t: 0, y: 36, size: 0.9, duration: 0.15, ease: 'exp' }] }],
  });
  const buf = render(score).buffers[0];
  const zcr = (start: number, len: number) => {
    let z = 0;
    for (let i = start + 1; i < start + len; i++) if ((buf[i - 1] >= 0) !== (buf[i] >= 0)) z++;
    return z / len;
  };
  assert.ok(zcr(0, 441) > zcr(2205, 441));
});

test('kick pitch envelope sweeps down onto the note (after transient)', () => {
  const score = ScoreSchema.parse({
    sampleRate: 44100,
    duration: 0.2,
    tracks: [
      {
        id: 'k',
        hue: 0,
        channel: 0,
        timbre: { transient: 0, noise: 0 },
        notes: [{ t: 0, y: 36, size: 0.9, duration: 0.18, ease: 'hold' }],
      },
    ],
  });
  const buf = render(score).buffers[0];
  const crossings = (a: number, b: number) => {
    let z = 0;
    for (let i = a + 1; i < b; i++) if ((buf[i - 1] >= 0) !== (buf[i] >= 0)) z++;
    return z / (b - a);
  };
  const early = crossings(Math.floor(0.01 * 44100), Math.floor(0.035 * 44100));
  const late = crossings(Math.floor(0.1 * 44100), Math.floor(0.15 * 44100));
  assert.ok(early > late * 1.3, `early ${early} late ${late}`);
});

test('unison stereo correlation', () => {
  const score = ScoreSchema.parse({
    sampleRate: 44100,
    duration: 0.3,
    seed: 5,
    tracks: [
      {
        id: 'lead',
        hue: 160,
        channel: [0, 1],
        lightness: 0.7,
        timbre: { spread: 1, detuneCents: 22, unison: 5 },
        notes: [{ t: 0, y: 64, size: 0.65, duration: 0.45 }],
      },
    ],
  });
  const { buffers } = render(score);
  assert.equal(buffers.length, 2);
  let diff = 0;
  for (let i = 0; i < buffers[0].length; i++) {
    if (Math.abs(buffers[0][i] - buffers[1][i]) > 1e-5) diff++;
  }
  assert.ok(diff > 100);
});

test('reverb tail when space > 0', () => {
  const base = {
    sampleRate: 44100,
    duration: 0.5,
    tracks: [
      {
        id: 'p',
        hue: 210,
        channel: 0,
        notes: [{ t: 0, y: 60, size: 0.5, duration: 0.1 }],
      },
    ],
  };
  const dry = render(ScoreSchema.parse({ ...base, tracks: [{ ...base.tracks[0], space: 0 }] }));
  const wet = render(ScoreSchema.parse({ ...base, tracks: [{ ...base.tracks[0], space: 0.7 }] }));
  let wetEnergy = 0;
  let dryEnergy = 0;
  for (let i = Math.floor(0.2 * 44100); i < Math.floor(0.45 * 44100); i++) {
    wetEnergy += wet.buffers[0][i] ** 2;
    dryEnergy += dry.buffers[0][i] ** 2;
  }
  assert.ok(wetEnergy > dryEnergy * 1.2);
});

test('ducking reduces bass under kick', () => {
  const score = ScoreSchema.parse({
    sampleRate: 44100,
    duration: 1.0,
    tracks: [
      { id: 'kick-drum', hue: 0, channel: 0, notes: [{ t: 0, y: 36, size: 0.9, duration: 0.12, ease: 'exp' }] },
      {
        id: 'bass',
        hue: 30,
        channel: 1,
        duck: { by: 'kick-drum', amount: 0.75 },
        notes: [{ t: 0, y: 45, size: 0.65, duration: 0.9 }],
      },
    ],
  });
  const buf = render(score).buffers[1];
  const rms = (a: number, b: number) => {
    let s = 0;
    for (let i = a; i < b; i++) s += buf[i] ** 2;
    return Math.sqrt(s / (b - a));
  };
  const under = rms(0, 2000);
  const between = rms(8000, 20000);
  assert.ok(under < between * 0.65);
});

test('master peak and loudness', () => {
  const score = ScoreSchema.parse({
    sampleRate: 44100,
    duration: 0.2,
    master: { loudness: -14 },
    tracks: [{ id: 'a', hue: 160, channel: 0, notes: [{ t: 0, y: 64, size: 0.5, duration: 0.15 }] }],
  });
  const r = render(score);
  assert.ok(r.master.peak <= Math.pow(10, -1 / 20) + 1e-6);
  assert.ok(Math.abs(r.master.loudnessDb - -14) < 2);
});

test('deterministic render hash', () => {
  const score = ScoreSchema.parse({
    sampleRate: 44100,
    duration: 0.08,
    seed: 77,
    tracks: [{ id: 'a', hue: 40, channel: 0, notes: [{ t: 0, y: 60, size: 0.5, duration: 0.06 }] }],
  });
  const h1 = createHash('sha256').update(render(score).wav).digest('hex');
  const h2 = createHash('sha256').update(render(score).wav).digest('hex');
  assert.equal(h1, h2);
});

test('json schema has bpm and master', () => {
  const raw = JSON.stringify(getJsonSchema());
  assert.ok(raw.includes('bpm'));
  assert.ok(raw.includes('master'));
});

test('spectralCentroid tracks a pure sine frequency', () => {
  const sr = 44100;
  for (const f of [440, 1000, 4000]) {
    const buf = new Float32Array(sr);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.sin((2 * Math.PI * f * i) / sr);
    const c = spectralCentroid(buf, sr);
    assert.ok(Math.abs(c - f) < f * 0.05, `centroid ${c} for ${f}Hz`);
  }
  assert.equal(spectralCentroid(new Float32Array(1000), sr), 0);
});

test('stereo filter state is independent per channel', () => {
  const score = ScoreSchema.parse({
    sampleRate: 44100,
    duration: 0.3,
    master: { drive: 0 },
    tracks: [
      {
        id: 'mono-in-stereo',
        hue: 70,
        channel: [0, 1],
        timbre: { unison: 1, spread: 0, resonance: 0.8 },
        notes: [{ t: 0, y: 57, size: 0.6, duration: 0.25 }],
      },
    ],
  });
  const [l, r] = render(score).buffers;
  let maxDiff = 0;
  for (let i = 0; i < l.length; i++) maxDiff = Math.max(maxDiff, Math.abs(l[i] - r[i]));
  assert.ok(maxDiff < 1e-6, `L/R diverged by ${maxDiff}`);
});

test('reverb tail does not bleed across tracks', () => {
  const late = { t: 0.85, y: 60, size: 0.8, duration: 0.15 };
  const score = ScoreSchema.parse({
    sampleRate: 44100,
    duration: 1.0,
    tracks: [
      { id: 'a', hue: 210, channel: 0, space: 0.9, echo: 0.6, notes: [late] },
      { id: 'b', hue: 160, channel: 0, space: 0.9, echo: 0.6, notes: [late] },
    ],
  });
  const buf = render(score).buffers[0];
  let maxEarly = 0;
  for (let i = 0; i < Math.floor(0.8 * 44100); i++) maxEarly = Math.max(maxEarly, Math.abs(buf[i]));
  assert.ok(maxEarly < 1e-6, `early leak ${maxEarly}`);
});

test('demo-groove renders under 30s', () => {
  const t0 = Date.now();
  const score = ScoreSchema.parse(JSON.parse(readFileSync('examples/demo-groove.json', 'utf8')));
  render(score);
  assert.ok(Date.now() - t0 < 30000);
});
