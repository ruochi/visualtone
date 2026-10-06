import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeWavFile } from './wav.js';
import { Biquad, Compressor, StereoEq, lfoValue, keyframeAt } from './mix.js';
import { swingTime, applyGroove } from './groove.js';
import { FdnReverb, lookaheadLimit, spectralCentroid } from './fx.js';
import { lightnessToCutoff } from './timbre.js';
import { measureLoudness } from './analysis/loudness.js';
import { render } from './renderer.js';
import { ScoreSchema } from './schema.js';

const SR = 44100;

function sine(freq: number, seconds: number, amp = 0.5): Float32Array {
  const b = new Float32Array(Math.floor(SR * seconds));
  for (let i = 0; i < b.length; i++) b[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return b;
}

function rms(b: ArrayLike<number>, from = 0, to = b.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += b[i] ** 2;
  return Math.sqrt(s / Math.max(1, to - from));
}

test('lookahead limiter holds the ceiling without scaling the whole buffer', () => {
  const l = sine(220, 1, 0.3);
  const r = sine(220, 1, 0.3);
  const spike = 22050;
  l[spike] = 1.6;
  r[spike] = -1.2;
  const reduction = lookaheadLimit([l, r], SR, { ceiling: -1, lookaheadMs: 5, releaseMs: 50 });
  const ceiling = Math.pow(10, -1 / 20);
  for (let i = 0; i < l.length; i++) {
    assert.ok(Math.abs(l[i]) <= ceiling + 1e-6 && Math.abs(r[i]) <= ceiling + 1e-6, `over at ${i}`);
  }
  assert.ok(reduction > 4.5 && reduction < 6, `reduction ${reduction}`);
  // Quiet material far from the spike is untouched.
  assert.ok(Math.abs(rms(l, 0, 11025) - 0.3 / Math.SQRT2) < 1e-3);
  // Gain starts dropping inside the lookahead window, before the spike.
  const before = sine(220, 1, 0.3);
  const i = spike - 110;
  assert.ok(Math.abs(l[i]) < Math.abs(before[i]) || Math.abs(before[i]) < 1e-3);
});

test('lookahead limiter also holds inter-sample peaks under the ceiling', () => {
  // fs/4 sine at phase pi/4: samples sit at 0.707 of the true crest.
  const amp = 1.2;
  const make = () => {
    const b = new Float32Array(SR / 2);
    for (let i = 0; i < b.length; i++) b[i] = amp * Math.sin((Math.PI / 2) * i + Math.PI / 4);
    return b;
  };
  const l = make();
  const r = make();
  lookaheadLimit([l, r], SR, { ceiling: -1 });
  const measured = measureLoudness([l, r], SR);
  assert.ok(measured.truePeakDbtp < -0.8, `true peak ${measured.truePeakDbtp}`);
});

test('lightness opens the cutoff into the presence band', () => {
  const c4 = 261.63;
  assert.ok(lightnessToCutoff(0.5, c4) > 2000 && lightnessToCutoff(0.5, c4) < 2500);
  assert.ok(lightnessToCutoff(0.8, c4) > 6000);
  assert.equal(lightnessToCutoff(1, 2000), 18000);
});

test('fdn tail darkens, decorrelates, and stays silent through the pre-delay', () => {
  const rev = new FdnReverb(SR, 'hall');
  rev.setParams({ size: 0.85, decay: 0.85, preDelayMs: 30, damping: 0.75, width: 1 });
  const n = SR * 2;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i === 0 ? 1 : 0;
    const [a, b] = rev.processStereo(x, x * 0.25);
    l[i] = a;
    r[i] = b;
  }
  let leak = 0;
  for (let i = 0; i < Math.round(0.02 * SR); i++) leak = Math.max(leak, Math.abs(l[i]), Math.abs(r[i]));
  assert.ok(leak < 1e-8, `pre-delay leak ${leak}`);

  const ratio = (buf: Float32Array, from: number, to: number) => {
    const hp = new Biquad('highpass', SR, 2500);
    const lp = new Biquad('lowpass', SR, 800);
    let hi = 0;
    let lo = 0;
    for (let i = from; i < to; i++) {
      const h = hp.process(buf[i]);
      const o = lp.process(buf[i]);
      hi += h * h;
      lo += o * o;
    }
    return hi / (lo + 1e-12);
  };
  const early = ratio(l, Math.round(0.05 * SR), Math.round(0.18 * SR));
  const late = ratio(l, Math.round(0.7 * SR), Math.round(1.3 * SR));
  assert.ok(late < early * 0.75, `highs should die: early ${early.toFixed(3)} late ${late.toFixed(3)}`);

  let lr = 0;
  let l2 = 0;
  let r2 = 0;
  for (let i = Math.round(0.05 * SR); i < Math.round(1.2 * SR); i++) {
    lr += l[i] * r[i];
    l2 += l[i] * l[i];
    r2 += r[i] * r[i];
  }
  const corr = lr / Math.sqrt(l2 * r2);
  assert.ok(corr < 0.5, `stereo correlation ${corr}`);
});

test('release 0 stays cut off, release 200 ms keeps a tail', () => {
  const note = [{ t: 0, y: 60, size: 0.6, duration: 0.12, ease: 'hold' as const }];
  const cut = render(ScoreSchema.parse({
    sampleRate: SR, duration: 0.5, master: { loudness: -20, drive: 0 },
    tracks: [{ id: 'p', hue: 210, channel: [0, 1], release: 0, notes: note }],
  })).buffers[0];
  const tail = render(ScoreSchema.parse({
    sampleRate: SR, duration: 0.5, master: { loudness: -20, drive: 0 },
    tracks: [{ id: 'p', hue: 210, channel: [0, 1], release: 200, notes: note }],
  })).buffers[0];
  const after = Math.round(0.2 * SR);
  assert.ok(rms(cut, after, after + 2000) < rms(tail, after, after + 2000) * 0.25);
});

test('velocity makes a louder note brighter', () => {
  const one = (size: number) => {
    const buf = render(ScoreSchema.parse({
      sampleRate: SR, duration: 0.3, seed: 3, master: { loudness: -20, drive: 0 },
      tracks: [{ id: 'p', hue: 90, channel: 0, timbre: { velocity: 1 }, notes: [{ t: 0, y: 64, size, duration: 0.2 }] }],
    })).buffers[0];
    return spectralCentroid(buf.slice(0, Math.round(0.08 * SR)), SR);
  };
  const loud = one(0.95);
  const soft = one(0.25);
  assert.ok(loud > soft * 1.15, `loud ${loud.toFixed(0)} soft ${soft.toFixed(0)}`);
});

test('drift is deterministic and moves the centroid between hits', () => {
  const score = ScoreSchema.parse({
    sampleRate: SR, duration: 0.8, seed: 9, master: { loudness: -20, drive: 0 },
    tracks: [{
      id: 'p', hue: 160, channel: 0, timbre: { drift: 1, unison: 3 },
      notes: [0, 0.4].map((t) => ({ t, y: 64, size: 0.5, duration: 0.25 })),
    }],
  });
  const a = render(score);
  const b = render(score);
  assert.equal(a.wav.equals(b.wav), true);
  const c1 = spectralCentroid(a.buffers[0].slice(Math.round(0.02 * SR), Math.round(0.12 * SR)), SR);
  const c2 = spectralCentroid(a.buffers[0].slice(Math.round(0.42 * SR), Math.round(0.52 * SR)), SR);
  assert.ok(Math.abs(c1 - c2) > 20, `centroids ${c1.toFixed(0)} ${c2.toFixed(0)}`);
});

test('wav 24-bit PCM header and size', () => {
  const buf = writeWavFile([sine(440, 0.1), sine(440, 0.1)], SR, { bitDepth: 24 });
  assert.equal(buf.readUInt16LE(20), 1);
  assert.equal(buf.readUInt16LE(34), 24);
  assert.equal(buf.readUInt16LE(32), 6);
  assert.equal(buf.length, 44 + 4410 * 6);
});

test('wav 32-bit float round-trips samples', () => {
  const src = sine(1000, 0.05);
  const buf = writeWavFile([src], SR, { bitDepth: 32 });
  assert.equal(buf.readUInt16LE(20), 3);
  assert.equal(buf.toString('ascii', 38, 42), 'fact');
  const dataStart = 58;
  for (const i of [0, 7, 100, 2000]) {
    assert.ok(Math.abs(buf.readFloatLE(dataStart + i * 4) - src[i]) < 1e-7);
  }
});

test('16-bit dither: deterministic, silence stays silent, LSB noise on signal', () => {
  const src = new Float32Array(4000);
  for (let i = 2000; i < 4000; i++) src[i] = 1e-5 * Math.sin(i * 0.05);
  const a = writeWavFile([src], SR, { seed: 1 });
  const b = writeWavFile([src], SR, { seed: 1 });
  const plain = writeWavFile([src], SR, { dither: false });
  assert.ok(a.equals(b));
  for (let i = 0; i < 2000; i++) assert.equal(a.readInt16LE(44 + i * 2), 0);
  let nonzeroDither = 0;
  let nonzeroPlain = 0;
  for (let i = 2000; i < 4000; i++) {
    if (a.readInt16LE(44 + i * 2) !== 0) nonzeroDither++;
    if (plain.readInt16LE(44 + i * 2) !== 0) nonzeroPlain++;
  }
  assert.equal(nonzeroPlain, 0, 'signal below 1 LSB truncates to zero without dither');
  assert.ok(nonzeroDither > 200, 'dither keeps sub-LSB detail as noise-shaped signal');
});

test('biquad highpass removes rumble, peak boosts centre', () => {
  const run = (f: Biquad, x: Float32Array) => x.map((v) => f.process(v));
  const low = run(new Biquad('highpass', SR, 200), sine(30, 0.5));
  const mid = run(new Biquad('highpass', SR, 200), sine(2000, 0.5));
  assert.ok(rms(low, 4410) < rms(mid, 4410) * 0.1);
  const boosted = run(new Biquad('peak', SR, 1000, 1, 6), sine(1000, 0.5));
  const ratio = rms(boosted, 4410) / rms(sine(1000, 0.5), 4410);
  assert.ok(Math.abs(ratio - 2) < 0.05, `peak +6dB ratio ${ratio}`);
});

test('stereo eq keeps channels independent', () => {
  const eq = new StereoEq(SR, { lowCut: 100, peaks: [{ freq: 800, gain: 4, q: 1 }] });
  let maxR = 0;
  for (let i = 0; i < 2000; i++) {
    const [, r] = eq.process(Math.sin(i * 0.1), 0);
    maxR = Math.max(maxR, Math.abs(r));
  }
  assert.equal(maxR, 0);
});

test('compressor reduces loud, leaves quiet untouched', () => {
  const cfg = { threshold: -20, ratio: 4, attackMs: 1, releaseMs: 50, knee: 0, makeup: 0 };
  const loud = new Compressor(SR, cfg);
  const quiet = new Compressor(SR, cfg);
  const lIn = sine(200, 0.3, 0.9);
  const qIn = sine(200, 0.3, 0.02);
  const lOut = lIn.map((v) => loud.process(v, v)[0]);
  const qOut = qIn.map((v) => quiet.process(v, v)[0]);
  assert.ok(rms(lOut, 4410) < rms(lIn, 4410) * 0.4);
  assert.ok(Math.abs(rms(qOut, 4410) - rms(qIn, 4410)) < 1e-6);
  assert.ok(loud.maxReductionDb > 8);
});

test('lfo shapes and keyframes', () => {
  assert.equal(lfoValue('square', 0.1), 1);
  assert.equal(lfoValue('square', 0.6), -1);
  assert.ok(Math.abs(lfoValue('triangle', 0.25)) < 1e-9);
  assert.equal(lfoValue('saw', 0), -1);
  const kf = [
    { t: 1, v: 0 },
    { t: 3, v: 1 },
  ];
  assert.equal(keyframeAt(kf, 0), 0);
  assert.equal(keyframeAt(kf, 2), 0.5);
  assert.equal(keyframeAt(kf, 9), 1);
});

test('swing pushes off-16ths late, leaves downbeats', () => {
  assert.equal(swingTime(0.5, 120, 1), 0.5);
  assert.ok(Math.abs(swingTime(0.125, 120, 1) - 0.25 * (2 / 3)) < 1e-9);
  assert.ok(Math.abs(swingTime(0.125, 120, 0.5) - 0.25 * (0.5 + 1 / 12)) < 1e-9);
  assert.equal(swingTime(0.125, 120, 0), 0.125);
});

test('groove keeps notes monophonic and humanize is deterministic', () => {
  const score = ScoreSchema.parse({
    bpm: 120,
    swing: 1,
    seed: 3,
    tracks: [
      {
        id: 'h',
        hue: 335,
        humanize: { timeMs: 8, size: 0.2 },
        notes: Array.from({ length: 16 }, (_, i) => ({ t: i * 0.125, y: 90, size: 0.5, duration: 0.125 })),
      },
    ],
  });
  const a = applyGroove(score, score.tracks[0], 0).notes!;
  const b = applyGroove(score, score.tracks[0], 0).notes!;
  assert.deepEqual(a, b);
  for (let i = 0; i < a.length - 1; i++) assert.ok(a[i].t + a[i].duration <= a[i + 1].t + 1e-12);
  assert.ok(a.some((n) => n.size !== 0.5));
});

test('gain lfo tremolo does not retrigger onsets; pan lfo moves energy', () => {
  const score = ScoreSchema.parse({
    sampleRate: SR,
    duration: 1,
    bpm: 120,
    tracks: [
      {
        id: 'pad',
        hue: 210,
        channel: [0, 1],
        timbre: { unison: 1, spread: 0 },
        lfo: [
          { target: 'gain', depth: 1, rate: 8 },
          { target: 'pan', depth: 1, beats: 2, shape: 'square' },
        ],
        notes: [{ t: 0, y: 60, size: 0.6, duration: 1 }],
      },
    ],
  });
  const r = render(score);
  assert.equal(r.eventReport[0].onsets, 1);
  const [l, rr] = r.buffers;
  const half = Math.floor(SR * 0.5);
  assert.ok(rms(rr, 2000, half) > rms(l, 2000, half) * 5, 'pan +1 = right');
  assert.ok(rms(l, half + 2000, SR) > rms(rr, half + 2000, SR) * 5, 'pan -1 = left');
});

test('lightness automation brightens the sound over time', () => {
  const score = ScoreSchema.parse({
    sampleRate: SR,
    duration: 2,
    tracks: [
      {
        id: 'saw',
        hue: 160,
        lightness: 0.15,
        automation: { lightness: [{ t: 0, v: 0 }, { t: 2, v: 0.8 }] },
        notes: [{ t: 0, y: 48, size: 0.6, duration: 2 }],
      },
    ],
  });
  const buf = render(score).buffers[0];
  const early = spectralCentroid(buf.subarray(4410, 4410 + 16384), SR);
  const late = spectralCentroid(buf.subarray(SR + 30000, SR + 30000 + 16384), SR);
  assert.ok(late > early * 1.5, `early ${early} late ${late}`);
});

test('track and master comp report gain reduction', () => {
  const score = ScoreSchema.parse({
    sampleRate: SR,
    duration: 0.5,
    master: { comp: { threshold: -16, ratio: 3 } },
    tracks: [
      {
        id: 'k',
        hue: 0,
        comp: { threshold: -30, ratio: 6, attackMs: 2 },
        notes: [{ t: 0, y: 36, size: 0.9, duration: 0.3, ease: 'exp' }],
      },
    ],
  });
  const r = render(score);
  assert.ok(r.eventReport[0].gainReductionDb > 3);
  assert.ok(r.master.gainReductionDb > 0);
  assert.ok(r.master.peak <= Math.pow(10, -1 / 20) + 1e-6);
});
