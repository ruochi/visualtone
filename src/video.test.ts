import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze } from './analysis/index.js';
import { BANDS, spectrogram } from './analysis/stft.js';
import { readWavFile, writeWavFile } from './wav.js';
import { render } from './renderer.js';
import { mix } from './segments.js';
import { expandSfx } from './sfx.js';
import { ScoreSchema } from './schema.js';
import { BandDuck } from './mix.js';
import { chord, parseAt, parsePitch, pattern } from './units.js';
import { resampleBuffer } from './resample.js';
import { hashSeed } from './timbre.js';

test('parsePitch, parseAt and chord', () => {
  assert.equal(parsePitch('C4'), 60);
  assert.equal(parsePitch('A3'), 57);
  assert.equal(parsePitch('Bb4'), 70);
  assert.equal(parseAt('1:1', 120, [4, 4]), 0);
  assert.equal(parseAt('4:2', 120, [4, 4]), 6.5);
  assert.deepEqual(chord('Am7', 'A3'), [57, 60, 64, 67]);
  const hits = pattern('x..x', { bpm: 120, y: 36, bar: 1 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].t, 0);
  assert.ok(Math.abs(hits[1].t - 0.375) < 1e-9);
});

test('bar:beat spelling renders like seconds', () => {
  const spelled = ScoreSchema.parse({
    bpm: 120,
    meter: [4, 4],
    sampleRate: 44100,
    duration: 0.3,
    seed: 3,
    tracks: [{ id: 'n', hue: 70, channel: 0, notes: [{ at: '1:1', pitch: 'C4', size: 0.5, len: '1/8' }] }],
  });
  const plain = ScoreSchema.parse({
    bpm: 120,
    sampleRate: 44100,
    duration: 0.3,
    seed: 3,
    tracks: [{ id: 'n', hue: 70, channel: 0, notes: [{ t: 0, y: 60, size: 0.5, duration: 0.25 }] }],
  });
  assert.equal(spelled.tracks[0].notes![0].t, 0);
  assert.equal(spelled.tracks[0].notes![0].y, 60);
  const a = render(spelled).wav;
  const b = render(plain).wav;
  assert.ok(a.equals(b));
});

test('sugar without bpm is rejected', () => {
  assert.throws(() =>
    ScoreSchema.parse({
      sampleRate: 44100,
      tracks: [{ id: 'n', hue: 0, notes: [{ at: '1:1', pitch: 'C4', size: 0.5, len: '1/4' }] }],
    }),
  );
});

test('default sample rate is 48 kHz', () => {
  const score = ScoreSchema.parse({
    tracks: [{ id: 'n', hue: 0, notes: [{ t: 0, y: 60, size: 0.2, duration: 0.1 }] }],
  });
  assert.equal(score.sampleRate, 48000);
});

test('clip track places a sample, records its hash, and fades', () => {
  const sr = 44100;
  const buf = new Float32Array(sr);
  buf[100] = 1;
  const score = ScoreSchema.parse({
    sampleRate: sr,
    duration: 1,
    tracks: [
      {
        id: 'voice',
        role: 'voice',
        channel: [0, 1],
        clip: { src: 'tts/scene.wav', at: 0.25, gain: 0.5, fadeIn: 0, trim: [0, 0.01] },
      },
    ],
  });
  const rendered = render(score, {
    stems: true,
    clips: { 'tts/scene.wav': { sampleRate: sr, buffers: [buf], sha256: 'abc123' } },
  });
  const stem = rendered.stems!.find((s) => s.id === 'voice')!;
  const at = Math.floor(0.25 * sr) + 100;
  assert.ok(Math.abs(stem.l[at] - 0.5) < 1e-5, `got ${stem.l[at]}`);
  assert.ok(Math.abs(stem.r[at] - 0.5) < 1e-5);
  assert.equal(rendered.inputs?.[0].sha256, 'abc123');
  assert.equal(rendered.inputs?.[0].frames, sr);

  const faded = render(
    ScoreSchema.parse({
      sampleRate: sr,
      duration: 0.2,
      tracks: [{ id: 'voice', role: 'voice', channel: [0, 1], clip: { src: 'a.wav', at: 0, gain: 1, fadeIn: 0.1 } }],
    }),
    { stems: true, clips: { 'a.wav': { sampleRate: sr, buffers: [new Float32Array(sr).fill(0.5)] } } },
  ).stems![0];
  assert.ok(Math.abs(faded.l[0]) < 1e-6);
  assert.ok(faded.l[Math.floor(0.05 * sr)] > 0.1);
  assert.ok(faded.l[Math.floor(0.05 * sr)] < 0.45);
});

test('resample keeps length ratio and a constant level', () => {
  const input = new Float32Array(1000).fill(0.25);
  const up = resampleBuffer(input, 24000, 48000);
  assert.equal(up.length, 2000);
  let sum = 0;
  for (let i = 200; i < 1800; i++) sum += up[i];
  const mean = sum / 1600;
  assert.ok(Math.abs(mean - 0.25) < 0.02, `mean ${mean}`);
  assert.equal(resampleBuffer(input, 44100, 44100), input);
});

test('wav roundtrip of 24-bit and extensible 32-bit pcm', () => {
  const buf = new Float32Array([0.1, -0.2, 0.3]);
  const wav = writeWavFile([buf], 48000, { bitDepth: 24, dither: false });
  const back = readWavFile(wav);
  assert.equal(back.sampleRate, 48000);
  assert.ok(Math.abs(back.buffers[0][1] + 0.2) < 1 / 100000);

  // Minimal WAVE_FORMAT_EXTENSIBLE, one 32-bit integer sample at half scale.
  const ext = Buffer.alloc(72);
  ext.write('RIFF', 0);
  ext.writeUInt32LE(ext.length - 8, 4);
  ext.write('WAVE', 8);
  ext.write('fmt ', 12);
  ext.writeUInt32LE(40, 16);
  ext.writeUInt16LE(0xfffe, 20);
  ext.writeUInt16LE(1, 22);
  ext.writeUInt32LE(48000, 24);
  ext.writeUInt32LE(48000 * 4, 28);
  ext.writeUInt16LE(4, 32);
  ext.writeUInt16LE(32, 34);
  ext.writeUInt16LE(22, 36);
  ext.writeUInt16LE(32, 38);
  ext.writeUInt32LE(4, 40);
  ext.writeUInt16LE(1, 44); // sub-format PCM, so the 32-bit sample is an integer
  ext.write('data', 60);
  ext.writeUInt32LE(4, 64);
  ext.writeInt32LE(Math.round(0.5 * 2147483647), 68);
  const decoded = readWavFile(ext);
  assert.ok(Math.abs(decoded.buffers[0][0] - 0.5) < 1e-6, `got ${decoded.buffers[0][0]}`);
});

test('envelopes follow fps and clip onsets', () => {
  const sr = 8000;
  const buf = new Float32Array(sr).fill(0.2);
  const score = ScoreSchema.parse({
    sampleRate: sr,
    duration: 1,
    tracks: [{ id: 'voice', role: 'voice', channel: 0, clip: { src: 'v.wav', at: 0.5, gain: 1 } }],
  });
  const result = render(score, {
    envelopes: { fps: 30 },
    clips: { 'v.wav': { sampleRate: sr, buffers: [buf] } },
  });
  const env = result.envelopes!;
  assert.equal(env.tracks.voice.level.length, Math.ceil(1 * 30));
  assert.equal(env.master.level.length, Math.ceil(1 * 30));
  assert.ok(Math.abs(env.tracks.voice.onsets[0] - 0.5) < 1e-6);
  assert.ok(env.tracks.voice.level[0] < 1e-6);
  assert.ok(env.tracks.voice.level[20] > 0.05);
});

test('mix of two halves matches the original render', () => {
  const parsed = ScoreSchema.parse({
    sampleRate: 44100,
    duration: 0.25,
    seed: 11,
    tracks: [
      { id: 'a', hue: 40, channel: 0, notes: [{ t: 0, y: 60, size: 0.45, duration: 0.2 }] },
      { id: 'b', hue: 210, channel: 0, notes: [{ t: 0.04, y: 67, size: 0.3, duration: 0.18 }] },
    ],
  });
  // Pin the noise seed before the split. After a merge the segment-local index would otherwise change it.
  const score = {
    ...parsed,
    tracks: parsed.tracks.map((t, i) => ({ ...t, seed: t.seed ?? hashSeed(parsed.seed, i) })),
  };
  const whole = render(score).wav;
  const mixed = mix(
    [
      { score: { ...score, tracks: [score.tracks[0]] }, at: 0 },
      { score: { ...score, tracks: [score.tracks[1]] }, at: 0 },
    ],
    score.master,
  );
  assert.equal(mixed.warnings.length, 0);
  const again = render(mixed.score).wav;
  assert.ok(whole.equals(again));
});

test('mix warns when a segment carries its own master and shifts local time', () => {
  const scene = ScoreSchema.parse({
    sampleRate: 44100,
    duration: 0.2,
    seed: 1,
    master: { loudness: -20, drive: 0 },
    tracks: [{ id: 'n', hue: 70, channel: 0, notes: [{ t: 0, y: 64, size: 0.4, duration: 0.1 }] }],
  });
  const mixed = mix([{ score: scene, at: 1.5, prefix: 's2/' }], { loudness: -16, drive: 0.1 });
  assert.ok(mixed.warnings.length >= 1);
  assert.equal(mixed.score.tracks[0].id, 's2/n');
  assert.ok(Math.abs(mixed.score.tracks[0].notes![0].t - 1.5) < 1e-9);
  assert.equal(mixed.score.master?.loudness, -16);
});

test('duck hold keeps the bed down between words', () => {
  const bed = {
    id: 'bed',
    hue: 210,
    role: 'music' as const,
    channel: 0 as const,
    notes: [{ t: 0, y: 60, size: 0.5, duration: 0.4, ease: 'hold' as const }],
  };
  const voice = {
    id: 'voice',
    hue: 260,
    role: 'voice' as const,
    channel: 0 as const,
    notes: [{ t: 0.05, y: 72, size: 0.9, duration: 0.03, ease: 'exp' as const }],
  };
  const opts = { sampleRate: 44100, duration: 0.4, seed: 2, master: { loudness: -14, drive: 0 } };
  const held = render(
    ScoreSchema.parse({
      ...opts,
      tracks: [{ ...bed, duck: { by: 'voice', amount: 1, holdMs: 150, releaseMs: 40 } }, voice],
    }),
    { stems: true },
  );
  const open = render(
    ScoreSchema.parse({
      ...opts,
      tracks: [{ ...bed, duck: { by: 'voice', amount: 1, holdMs: 0, releaseMs: 40 } }, voice],
    }),
    { stems: true },
  );
  const at = Math.floor(0.2 * 44100);
  const heldLevel = Math.abs(held.stems!.find((s) => s.id === 'bed')!.l[at]);
  const openLevel = Math.abs(open.stems!.find((s) => s.id === 'bed')!.l[at]);
  assert.ok(heldLevel < openLevel * 0.75, `held ${heldLevel} open ${openLevel}`);
});

test('sfx names expand to sounding tracks', () => {
  const score = expandSfx(
    ScoreSchema.parse({
      sampleRate: 44100,
      duration: 0.5,
      seed: 4,
      tracks: [
        {
          id: 'fx',
          sfx: [
            { sfx: 'whoosh', t: 0.05, duration: 0.3, size: 0.7, direction: 0.8 },
            { sfx: 'tick', t: 0.4, size: 0.8 },
          ],
        },
      ],
    }),
  );
  assert.equal(score.tracks[0].role, 'sfx');
  assert.ok(score.tracks[0].id.includes('whoosh'));
  const rendered = render(score, { stems: true });
  for (const stem of rendered.stems!.filter((s) => !s.id.startsWith('bus:'))) {
    let peak = 0;
    for (let i = 0; i < stem.l.length; i++) peak = Math.max(peak, Math.abs(stem.l[i]), Math.abs(stem.r[i]));
    assert.ok(peak > 0.01, `${stem.id} was silent`);
  }
});

test('acoustic engines overlap instead of cutting the previous note', () => {
  for (const engine of ['pluck', 'marimba', 'epiano', 'organ', 'drum', 'wind', 'bow', 'piano', 'brass'] as const) {
    const score = ScoreSchema.parse({
      sampleRate: 22050,
      duration: 0.5,
      seed: 5,
      master: { loudness: -18, drive: 0 },
      tracks: [
        {
          id: engine,
          hue: 30,
          engine,
          channel: 0,
          notes: [
            { t: 0, y: 60, size: 0.7, duration: 0.45 },
            { t: 0.15, y: 67, size: 0.7, duration: 0.3 },
          ],
        },
      ],
    });
    assert.equal(score.tracks[0].notes![0].duration, 0.45);
    const result = render(score, { envelopes: { fps: 20 }, stems: true });
    const onsets = result.envelopes!.tracks[engine].onsets;
    assert.ok(onsets.some((t) => Math.abs(t) < 1e-6));
    assert.ok(onsets.some((t) => Math.abs(t - 0.15) < 1e-6));
    let peak = 0;
    const stem = result.stems![0];
    for (let i = 0; i < stem.l.length; i++) peak = Math.max(peak, Math.abs(stem.l[i]));
    assert.ok(peak > 0.01, engine);
  }
});

test('voiceover-bed flags a bed with no voice role', () => {
  const score = ScoreSchema.parse({
    sampleRate: 22050,
    duration: 0.25,
    seed: 1,
    tracks: [{ id: 'bed', hue: 210, role: 'music', channel: [0, 1], notes: [{ t: 0, y: 60, size: 0.4, duration: 0.2 }] }],
  });
  const rendered = render(score, { stems: true });
  const report = analyze({
    buffers: rendered.buffers,
    sampleRate: rendered.sampleRate,
    stems: rendered.stems,
    score,
    profile: 'voiceover-bed',
  }).report;
  assert.ok(report.findings.some((f) => f.id === 'voiceover.presence'));
});

test('master.lufs lands near the target', () => {
  const score = ScoreSchema.parse({
    sampleRate: 22050,
    duration: 0.4,
    seed: 1,
    master: { lufs: -20, drive: 0, loudness: -40 },
    tracks: [{ id: 'n', hue: 110, channel: [0, 1], notes: [{ t: 0, y: 69, size: 0.4, duration: 0.35, ease: 'hold' }] }],
  });
  const rendered = render(score);
  const lufs = analyze({ buffers: rendered.buffers, sampleRate: rendered.sampleRate }).report.loudness.integratedLufs;
  assert.ok(Math.abs(lufs + 20) < 1.5, `lufs ${lufs}`);
  assert.ok(Math.abs(rendered.master.loudnessDb - lufs) < 0.05, `reported ${rendered.master.loudnessDb} measured ${lufs}`);
});

/** Steady-state amplitude ratio of a sine through BandDuck. */
function steadyGain(freq: number, g: number, sr = 48000): number {
  const duck = new BandDuck(sr, [1000, 4000]);
  const n = sr;
  const skip = Math.floor(0.2 * sr);
  let inSum = 0;
  let outSum = 0;
  for (let i = 0; i < n; i++) {
    const x = Math.sin((2 * Math.PI * freq * i) / sr);
    const [y] = duck.process(x, x, g);
    if (i >= skip) {
      inSum += x * x;
      outSum += y * y;
    }
  }
  return Math.sqrt(outSum / inSum);
}

test('band duck center gain equals g and deeper duck cuts more', () => {
  const open = steadyGain(2000, 1);
  const mid = steadyGain(2000, 0.6);
  const shallow = steadyGain(2000, 0.4);
  const full = steadyGain(2000, 0);
  assert.ok(Math.abs(open - 1) < 0.02, `g=1 ${open}`);
  assert.ok(Math.abs(mid - 0.6) < 0.05, `g=0.6 ${mid}`);
  assert.ok(full < 0.02, `g=0 ${full}`);
  assert.ok(full < shallow && shallow < mid && mid < open, `gains ${full} ${shallow} ${mid} ${open}`);
  assert.ok(steadyGain(100, 0) > 0.7, `100 Hz ${steadyGain(100, 0)}`);
});

test('rendered band duck at 2 kHz follows the sidechain amount', () => {
  const sr = 48000;
  const n = Math.floor(0.5 * sr);
  const bed = new Float32Array(n);
  for (let i = 0; i < n; i++) bed[i] = Math.sin((2 * Math.PI * 2000 * i) / sr);
  const voice = new Float32Array(n).fill(0.5);
  const rms = (buf: Float32Array) => {
    const a = Math.floor(0.2 * sr);
    let s = 0;
    for (let i = a; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / (buf.length - a));
  };
  const renderBed = (amount: number) => {
    const score = ScoreSchema.parse({
      sampleRate: sr,
      duration: 0.5,
      seed: 1,
      master: { loudness: -20, drive: 0 },
      tracks: [
        {
          id: 'bed',
          role: 'music',
          channel: 0,
          duck: { by: 'voice', amount, band: [1000, 4000] },
          clip: { src: 'bed.wav', at: 0, gain: 1 },
        },
        { id: 'voice', role: 'voice', channel: 0, clip: { src: 'voice.wav', at: 0, gain: 1 } },
      ],
    });
    const stem = render(score, {
      stems: true,
      clips: {
        'bed.wav': { sampleRate: sr, buffers: [bed] },
        'voice.wav': { sampleRate: sr, buffers: [voice] },
      },
    }).stems!.find((s) => s.id === 'bed')!;
    return rms(stem.l);
  };
  const dry = rms(bed);
  const full = renderBed(1);
  const partial = renderBed(0.6);
  assert.ok(full / dry < 0.05, `amount 1 ratio ${full / dry}`);
  assert.ok(Math.abs(partial / dry - 0.4) < 0.08, `amount 0.6 ratio ${partial / dry}`);
  assert.ok(full < partial, `full ${full} partial ${partial}`);
});

test('voiceover-bed band shares count music only and name real tracks', () => {
  const sr = 22050;
  const n = Math.floor(sr * 1.2);
  const voice = new Float32Array(n);
  const bed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    voice[i] = Math.sin((2 * Math.PI * 3000 * i) / sr);
    bed[i] = Math.sin((2 * Math.PI * 100 * i) / sr);
  }
  const mixL = new Float32Array(n);
  for (let i = 0; i < n; i++) mixL[i] = voice[i] + bed[i];
  const share = (buf: Float32Array, name: string) => {
    const spec = spectrogram(buf, sr, 4096, 512, 64);
    const total = spec.bandPower.reduce((s, v) => s + v, 0) || 1;
    const i = BANDS.findIndex((b) => b.name === name);
    return spec.bandPower[i] / total;
  };
  const score = ScoreSchema.parse({
    sampleRate: sr,
    duration: n / sr,
    tracks: [
      { id: 'voice', role: 'voice', hue: 260, channel: 0, notes: [{ t: 0, y: 72, size: 0.4, duration: 0.2 }] },
      { id: 'bed', role: 'music', hue: 210, channel: 0, notes: [{ t: 0, y: 43, size: 0.4, duration: 0.2 }] },
    ],
  });
  const report = analyze({
    buffers: [mixL],
    sampleRate: sr,
    stems: [
      { id: 'voice', l: voice, r: voice },
      { id: 'bed', l: bed, r: bed },
    ],
    score,
    profile: 'voiceover-bed',
  }).report;
  const bass = report.bands.find((b) => b.name === 'bass')!.share;
  const musicBass = share(bed, 'bass');
  const mixBass = share(mixL, 'bass');
  assert.ok(Math.abs(bass - musicBass) < 0.02, `reported ${bass} music ${musicBass}`);
  assert.ok(mixBass < musicBass - 0.15, `mix ${mixBass} music ${musicBass}`);
  const bandFindings = report.findings.filter((f) => f.id.startsWith('band.'));
  assert.ok(bandFindings.length > 0);
  for (const f of bandFindings) {
    assert.match(f.suggestion, /bed/);
    assert.doesNotMatch(f.suggestion, /stab|hat|hook/);
  }
  const presence = bandFindings.find((f) => f.id === 'band.presence');
  assert.ok(presence);
  assert.match(presence.suggestion, /不要加 highShelf/);
});
