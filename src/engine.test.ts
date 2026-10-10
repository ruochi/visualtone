import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { analyzeNote } from './analysis/timbre.js';
import { buildWavetable, clearWavetableCache } from './wavetable.js';
import { hueToTimbreVector } from './timbre.js';
import { createHarmonic, HARMONIC_PRESETS, type HarmonicPreset } from './engines/harmonic.js';
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

test('drum, wind, bow, and piano stay in tune and get brighter', () => {
  const sr = 48000;
  const cases = [
    { engine: 'drum', hue: 80 },
    { engine: 'wind', hue: 40 },
    { engine: 'wind', hue: 220 },
    { engine: 'bow', hue: 40 },
    { engine: 'piano', hue: 30 },
    { engine: 'brass', hue: 40 },
    { engine: 'brass', hue: 140 },
    { engine: 'brass', hue: 210 },
    { engine: 'brass', hue: 270 },
    { engine: 'brass', hue: 300 },
    { engine: 'bass', hue: 40 },
    { engine: 'bass', hue: 220 },
    { engine: 'reed', hue: 40 },
    { engine: 'reed', hue: 220 },
  ] as const;
  const measure = (engine: string, hue: number, midi: number, size: number) => {
    const score = ScoreSchema.parse({
      sampleRate: sr,
      duration: 1.15,
      seed: 3,
      master: { loudness: -18, drive: 0 },
      tracks: [
        {
          id: engine,
          hue,
          engine,
          channel: [0, 1],
          notes: [{ t: 0.05, y: midi, size, duration: 0.7, ease: 'hold' }],
        },
      ],
    });
    const stem = render(score, { stems: true }).stems![0];
    const mono = new Float32Array(stem.l.length);
    for (let i = 0; i < mono.length; i++) mono[i] = (stem.l[i] + stem.r[i]) * 0.5;
    return analyzeNote(mono, sr, { start: 0, stop: 1.15, noteOff: 0.75, midi });
  };
  for (const c of cases) {
    const soft = measure(c.engine, c.hue, 60, 0.3);
    const hard = measure(c.engine, c.hue, 60, 0.9);
    assert.ok(hard.centsOff !== null && Math.abs(hard.centsOff) < 8, `${c.engine}@${c.hue} cents ${hard.centsOff}`);
    assert.equal(hard.artifacts.clicks, 0, `${c.engine}@${c.hue} clicks`);
    assert.equal(soft.artifacts.clicks, 0, `${c.engine}@${c.hue} soft clicks`);
    assert.ok(hard.envelope.peakDb - soft.envelope.peakDb > 3, `${c.engine} level`);
    assert.ok(
      soft.spectrum.centroidHz > 0 && Math.log2(hard.spectrum.centroidHz / soft.spectrum.centroidHz) > 0.1,
      `${c.engine}@${c.hue} centroid ${soft.spectrum.centroidHz.toFixed(0)} -> ${hard.spectrum.centroidHz.toFixed(0)}`,
    );
  }
  const low = measure('piano', 30, 48, 0.6);
  const high = measure('piano', 30, 84, 0.6);
  assert.ok(
    low.envelope.decayDbPerSec !== null &&
      high.envelope.decayDbPerSec !== null &&
      high.envelope.decayDbPerSec > low.envelope.decayDbPerSec,
    `piano decay ${low.envelope.decayDbPerSec} -> ${high.envelope.decayDbPerSec}`,
  );
});

test('cymbal rings, a closed hat dies before a crash, and neither clicks', () => {
  const sr = 48000;
  const hit = (hue: number, size: number) => {
    const score = ScoreSchema.parse({
      sampleRate: sr,
      duration: 1.4,
      seed: 4,
      master: { loudness: -18, drive: 0 },
      tracks: [
        {
          id: 'c',
          hue,
          engine: 'cymbal',
          channel: [0, 1],
          notes: [{ t: 0.05, y: 60, size, duration: 0.9, ease: 'hold' }],
        },
      ],
    });
    const stem = render(score, { stems: true }).stems![0];
    const mono = new Float32Array(stem.l.length);
    for (let i = 0; i < mono.length; i++) mono[i] = (stem.l[i] + stem.r[i]) * 0.5;
    return analyzeNote(mono, sr, { start: 0, stop: 1.4, noteOff: 0.95, midi: 60 });
  };
  const hat = hit(40, 0.7);
  const crash = hit(280, 0.7);
  const soft = hit(280, 0.3);
  assert.equal(hat.artifacts.clicks, 0);
  assert.equal(crash.artifacts.clicks, 0);
  assert.ok(hat.envelope.decayDbPerSec !== null && crash.envelope.decayDbPerSec !== null);
  assert.ok(hat.envelope.decayDbPerSec > crash.envelope.decayDbPerSec + 4, `hat ${hat.envelope.decayDbPerSec} crash ${crash.envelope.decayDbPerSec}`);
  assert.ok(
    soft.spectrum.centroidHz > 0 && Math.log2(crash.spectrum.centroidHz / soft.spectrum.centroidHz) > 0.1,
    `crash centroid ${soft.spectrum.centroidHz.toFixed(0)} -> ${crash.spectrum.centroidHz.toFixed(0)}`,
  );
});

function holdNote(engine: string, hue: number, midi: number, size: number, hold: number) {
  const sr = 48000;
  const score = ScoreSchema.parse({
    sampleRate: sr,
    duration: hold + 0.4,
    seed: 3,
    master: { loudness: -18, drive: 0 },
    tracks: [{ id: 'n', hue, engine, channel: [0, 1], notes: [{ t: 0.05, y: midi, size, duration: hold, ease: 'hold' }] }],
  });
  const stem = render(score, { stems: true }).stems![0];
  const mono = new Float32Array(stem.l.length);
  for (let i = 0; i < mono.length; i++) mono[i] = (stem.l[i] + stem.r[i]) * 0.5;
  return { mono, sr };
}

test('a held high flute keeps sounding and carries no DC', () => {
  for (const midi of [72, 84]) {
    const { mono, sr } = holdNote('wind', 30, midi, 0.7, 2.4);
    const rmsDb = (a: number, b: number) => {
      let s = 0;
      for (let i = Math.round(a * sr); i < Math.round(b * sr); i++) s += mono[i] * mono[i];
      return 10 * Math.log10(s / ((b - a) * sr) + 1e-20);
    };
    const early = rmsDb(0.3, 0.6);
    const late = rmsDb(2.0, 2.4);
    assert.ok(late > early - 3, `C${midi / 12 - 1} fell from ${early.toFixed(1)} to ${late.toFixed(1)} dB`);
    let mean = 0;
    for (let i = Math.round(0.3 * sr); i < Math.round(2.4 * sr); i++) mean += mono[i];
    mean /= 2.1 * sr;
    assert.ok(Math.abs(mean) < 0.01 * Math.pow(10, early / 20), `DC ${mean}`);
  }
});

test('held notes carry irregular loudness motion near the recordings', () => {
  const cases = [
    { engine: 'bow', hue: 40, midi: 69, lo: -34, hi: -20 },
    { engine: 'wind', hue: 30, midi: 72, lo: -38, hi: -24 },
    { engine: 'brass', hue: 20, midi: 70, lo: -38, hi: -24 },
    { engine: 'reed', hue: 40, midi: 70, lo: -40, hi: -24 },
  ];
  for (const c of cases) {
    const { mono, sr } = holdNote(c.engine, c.hue, c.midi, 0.6, 2.2);
    const note = analyzeNote(mono, sr, { start: 0, stop: 2.6, noteOff: 2.25, midi: c.midi });
    const shimmer = note.envelope.shimmerDb;
    assert.ok(shimmer !== null && shimmer > c.lo && shimmer < c.hi, `${c.engine} shimmer ${shimmer}`);
    assert.equal(note.artifacts.clicks, 0);
    assert.ok(Math.abs(note.centsOff ?? 99) < 8, `${c.engine} cents ${note.centsOff}`);
  }
});

test('electronic bass stays in tune, and the offbeat voice falls while held', () => {
  const rms = (mono: Float32Array, sr: number, a: number, b: number) => {
    let s = 0;
    const i0 = Math.round(a * sr);
    const i1 = Math.round(b * sr);
    for (let i = i0; i < i1; i++) s += mono[i] * mono[i];
    return 10 * Math.log10(s / (i1 - i0) + 1e-20);
  };
  for (const hue of [40, 160, 300]) {
    const soft = (() => {
      const { mono, sr } = holdNote('sub', hue, 40, 0.3, 0.8);
      return analyzeNote(mono, sr, { start: 0, stop: 1.2, noteOff: 0.85, midi: 40 });
    })();
    const { mono, sr } = holdNote('sub', hue, 40, 0.85, 0.8);
    const hard = analyzeNote(mono, sr, { start: 0, stop: 1.2, noteOff: 0.85, midi: 40 });
    assert.ok(hard.centsOff !== null && Math.abs(hard.centsOff) < 8, `hue ${hue} cents ${hard.centsOff}`);
    assert.equal(hard.artifacts.clicks, 0, `hue ${hue} clicks`);
    assert.equal(soft.artifacts.clicks, 0, `hue ${hue} soft clicks`);
    assert.ok(hard.envelope.peakDb - soft.envelope.peakDb > 3, `hue ${hue} level`);
    assert.ok(
      soft.spectrum.centroidHz > 0 && Math.log2(hard.spectrum.centroidHz / soft.spectrum.centroidHz) > 0.1,
      `hue ${hue} centroid ${soft.spectrum.centroidHz.toFixed(0)} -> ${hard.spectrum.centroidHz.toFixed(0)}`,
    );
    const early = rms(mono, sr, 0.08, 0.16);
    const late = rms(mono, sr, 0.5, 0.7);
    if (hue >= 240) assert.ok(late < early - 6, `pluck fell ${early.toFixed(1)} -> ${late.toFixed(1)}`);
    else assert.ok(late > early - 3, `sustain fell ${early.toFixed(1)} -> ${late.toFixed(1)}`);
  }
});

test('electric bass decays while held, and higher partials die first', () => {
  const play = (midi: number, size: number) => {
    const { mono, sr } = holdNote('bass', 270, midi, size, 1.6);
    return analyzeNote(mono, sr, { midi, start: 0, stop: 2, noteOff: 1.65 });
  };
  const soft = play(40, 0.35);
  const hard = play(40, 0.9);
  assert.ok(Math.abs(hard.centsOff ?? 99) < 8, `cents ${hard.centsOff}`);
  assert.equal(hard.artifacts.clicks, 0);
  assert.equal(soft.artifacts.clicks, 0);
  assert.ok(hard.envelope.peakDb - soft.envelope.peakDb > 3, `level ${soft.envelope.peakDb} -> ${hard.envelope.peakDb}`);
  assert.ok(
    soft.spectrum.centroidHz > 0 && Math.log2(hard.spectrum.centroidHz / soft.spectrum.centroidHz) > 0.1,
    `centroid ${soft.spectrum.centroidHz} -> ${hard.spectrum.centroidHz}`,
  );
  assert.ok((hard.envelope.decayDbPerSec ?? 0) > 3, `decay ${hard.envelope.decayDbPerSec}`);
  const partials = hard.harmonics.decayDbPerSec;
  assert.ok(partials[0] !== null && partials[3] !== null && partials[3] > partials[0] + 2, `partials ${partials[0]} ${partials[3]}`);
  const low = play(33, 0.7);
  const high = play(57, 0.7);
  assert.ok(
    (high.envelope.decayDbPerSec ?? 0) > (low.envelope.decayDbPerSec ?? 0) + 2,
    `pitch decay ${low.envelope.decayDbPerSec} -> ${high.envelope.decayDbPerSec}`,
  );
});

function playHarmonic(preset: HarmonicPreset, seconds: number, midi: number) {
  const sr = 48000;
  const engine = createHarmonic(sr, preset, 3);
  const n = Math.round(seconds * sr);
  const buf = new Float32Array(n);
  const off = Math.round((seconds - 0.2) * sr);
  for (let i = 0; i < n; i++) {
    const [l, r] = engine.processSample(midi, i < off ? 0.6 : 0, 0.5);
    buf[i] = (l + r) * 0.5;
  }
  return { buf, sr };
}

function windowRms(buf: Float32Array, sr: number, t: number) {
  const a = Math.round(t * sr);
  const b = a + Math.round(0.08 * sr);
  let s = 0;
  for (let i = a; i < b; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / (b - a));
}

test('a bow arc fades and darkens a held note', () => {
  const life = {
    ...HARMONIC_PRESETS.violin.life,
    vibratoCents: 0,
    vibratoHighCents: 0,
    wanderCents: 0,
    shimmerRms: 0,
    vibratoDepthJitter: 0,
    vibratoRateJitter: 0,
  };
  const withArc = playHarmonic(
    { ...HARMONIC_PRESETS.violin, life, bowArc: { swellFrom: 0.5, swellSec: 0.2, dbPerSec: 6, tiltPerSec: 0.2 } },
    2.4,
    74,
  );
  const early = windowRms(withArc.buf, withArc.sr, 0.5);
  const late = windowRms(withArc.buf, withArc.sr, 2);
  assert.ok(late < early * 0.5, `level ${early.toFixed(4)} -> ${late.toFixed(4)}`);
  const centroid = (t: number) =>
    spectralCentroid(withArc.buf.subarray(Math.round(t * withArc.sr), Math.round((t + 0.25) * withArc.sr)), withArc.sr, 1024);
  const bright = centroid(0.45);
  const dark = centroid(1.85);
  assert.ok(dark < bright, `centroid ${bright.toFixed(0)} -> ${dark.toFixed(0)}`);

  const steady = playHarmonic({ ...HARMONIC_PRESETS.violin, life, bowArc: undefined }, 2.4, 74);
  const again = playHarmonic({ ...HARMONIC_PRESETS.violin, life, bowArc: undefined }, 2.4, 74);
  assert.equal(steady.buf.length, again.buf.length);
  for (let i = 0; i < steady.buf.length; i++) {
    if (steady.buf[i] !== again.buf[i]) assert.fail(`sample ${i} changed without bowArc`);
  }
  const heldEarly = windowRms(steady.buf, steady.sr, 0.5);
  const heldLate = windowRms(steady.buf, steady.sr, 2);
  assert.ok(heldLate > heldEarly * 0.9, `unset arc fell ${heldEarly.toFixed(4)} -> ${heldLate.toFixed(4)}`);

  const breath = playHarmonic(
    {
      ...HARMONIC_PRESETS.trumpet,
      life: { ...HARMONIC_PRESETS.trumpet.life, wanderCents: 0, shimmerRms: 0 },
      bowArc: undefined,
      noteArc: { swellFrom: 0.5, swellSec: 0.2, dbPerSec: 6, tiltPerSec: 0.2 },
    },
    2.4,
    62,
  );
  const breathEarly = windowRms(breath.buf, breath.sr, 0.5);
  const breathLate = windowRms(breath.buf, breath.sr, 2);
  assert.ok(breathLate < breathEarly * 0.5, `note arc ${breathEarly.toFixed(4)} -> ${breathLate.toFixed(4)}`);
});

test('instruments without a bow arc keep their samples', () => {
  const expected: Record<string, string> = {
    trumpet: 'f11620eaa49dd83ce163c3cefa5da9db044f0bafa6288259cc7ef48091351b43',
    horn: '723e097728770e265b7944c7562cfc0bc6220c4b0d37297ef03f3df6fd045ea9',
    trombone: '339d2756e5ffa8f3e36d688051531497fc6290e8d1477ffe8628658d099c19a0',
    tuba: '43fdb1236e87845385ceefd1d13fb20049437feb1d4bb4e1e442069e4d6ea441',
    saxophone: 'fee2b9ad5364f801f427bd7961494871aac41ee706a7bbac401c0b86f55a2f6b',
    oboe: 'ac1bbf9bd47bc832dd5dd4f4c6d87877a83df9d0ed367b55e6bbf6bde04548b9',
    bassoon: '59862eb88f532c5fb8dde3a8320a99a06562e6522cfeeb32ecd499d438a42459',
    'electric-bass': '10e71521f25e2d867c2d0419176f67bbd91871f7d8399e64a2266e2d68c4464d',
    piano: '97bf30bad3f18bb86c1d2fce0fbd8f9547c7b8019ebe756d11b4d258d0856650',
    flute: '20b051cb3fe970a8cc031999384f93eb7c127910ccf4c87103f9ab222464d5a8',
  };
  for (const [instrument, hash] of Object.entries(expected)) {
    const score = ScoreSchema.parse({
      sampleRate: 48000,
      duration: 1.2,
      seed: 3,
      master: { loudness: -18, drive: 0 },
      tracks: [{ id: 'n', instrument, notes: [{ t: 0.05, y: 62, size: 0.6, duration: 0.9, ease: 'hold' }] }],
    });
    const got = createHash('sha256').update(render(score).wav).digest('hex');
    assert.equal(got, hash, instrument);
  }
});

test('bowed strings lean into vibrato near 5.5 Hz', () => {
  for (const hue of [40, 160, 300]) {
    const { mono, sr } = holdNote('bow', hue, 62, 0.6, 2);
    const note = analyzeNote(mono, sr, { start: 0, stop: 2.4, noteOff: 2.05, midi: 62 });
    assert.ok(note.pitch.vibratoRateHz !== null && Math.abs(note.pitch.vibratoRateHz - 5.4) < 0.6, `hue ${hue} rate ${note.pitch.vibratoRateHz}`);
    assert.ok((note.pitch.vibratoDepthCents ?? 0) > 5, `hue ${hue} depth ${note.pitch.vibratoDepthCents}`);
    assert.ok(Math.abs(note.centsOff ?? 99) < 6, `hue ${hue} cents ${note.centsOff}`);
    assert.equal(note.artifacts.clicks, 0);
  }
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
