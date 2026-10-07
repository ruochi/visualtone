import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { analyzeNote } from './analysis/timbre.js';
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

test('held wavetable note does not step to zero', () => {
  const sr = 48000;
  const score = ScoreSchema.parse({
    sampleRate: sr,
    duration: 0.45,
    seed: 1,
    master: { loudness: -18, drive: 0 },
    tracks: [{ id: 'p', hue: 110, channel: [0, 1], notes: [{ t: 0.05, y: 60, size: 0.7, duration: 0.25, ease: 'hold' }] }],
  });
  const stem = render(score, { stems: true }).stems![0].l;
  const off = Math.round(0.3 * sr);
  const step = Math.abs(stem[off] - stem[off - 1]);
  let body = 0;
  const mid = Math.round(0.16 * sr);
  for (let i = mid; i < mid + sr / 50; i++) body = Math.max(body, Math.abs(stem[i] - stem[i - 1]));
  assert.ok(step < body * 1.5, `note-off step ${step.toFixed(4)} vs body ${body.toFixed(4)}`);
  const features = analyzeNote(stem, sr, { start: 0, stop: 0.45, noteOff: 0.3, midi: 60 });
  assert.equal(features.artifacts.clicks, 0);
});

test('organ stays in tune, gets louder and brighter with size, and does not click', () => {
  const sr = 48000;
  const one = (size: number) => {
    const score = ScoreSchema.parse({
      sampleRate: sr,
      duration: 1.1,
      seed: 2,
      master: { loudness: -18, drive: 0 },
      tracks: [
        {
          id: 'organ',
          hue: 40,
          engine: 'organ',
          channel: [0, 1],
          notes: [{ t: 0.05, y: 60, size, duration: 0.7, ease: 'hold' }],
        },
      ],
    });
    const stem = render(score, { stems: true }).stems![0];
    const mono = new Float32Array(stem.l.length);
    for (let i = 0; i < mono.length; i++) mono[i] = (stem.l[i] + stem.r[i]) * 0.5;
    return analyzeNote(mono, sr, { start: 0, stop: 1.1, noteOff: 0.75, midi: 60 });
  };
  const soft = one(0.3);
  const hard = one(0.9);
  assert.ok(hard.centsOff !== null && Math.abs(hard.centsOff) < 5, `cents ${hard.centsOff}`);
  assert.equal(hard.artifacts.clicks, 0);
  assert.equal(soft.artifacts.clicks, 0);
  assert.ok(hard.envelope.peakDb - soft.envelope.peakDb > 3, `level span ${hard.envelope.peakDb - soft.envelope.peakDb}`);
  assert.ok(
    soft.spectrum.centroidHz > 0 && Math.log2(hard.spectrum.centroidHz / soft.spectrum.centroidHz) > 0.1,
    `centroid ${soft.spectrum.centroidHz.toFixed(0)} -> ${hard.spectrum.centroidHz.toFixed(0)}`,
  );
});

test('pluck stays in tune at C6', () => {
  const sr = 48000;
  const score = ScoreSchema.parse({
    sampleRate: sr,
    duration: 0.8,
    seed: 1,
    master: { loudness: -18, drive: 0 },
    tracks: [
      {
        id: 'p',
        hue: 70,
        engine: 'pluck',
        channel: [0, 1],
        notes: [{ t: 0.05, y: 84, size: 0.7, duration: 0.45, ease: 'hold' }],
      },
    ],
  });
  const stem = render(score, { stems: true }).stems![0];
  const mono = new Float32Array(stem.l.length);
  for (let i = 0; i < mono.length; i++) mono[i] = (stem.l[i] + stem.r[i]) * 0.5;
  const features = analyzeNote(mono, sr, { start: 0, stop: 0.8, noteOff: 0.5, midi: 84 });
  assert.ok(features.centsOff !== null && Math.abs(features.centsOff) < 5, `cents ${features.centsOff}`);
  assert.equal(features.artifacts.clicks, 0);
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
