import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { inflateSync } from 'node:zlib';
import { analyze } from './index.js';
import { measureLoudness } from './loudness.js';
import { render } from '../renderer.js';
import { ScoreSchema } from '../schema.js';
import { readWavFile, writeWavFile } from '../wav.js';
import { Canvas } from '../report/canvas.js';
import { encodePng } from '../report/png.js';

const SR = 44100;

function sine(freq: number, seconds: number, amp = 1, phase = 0, sr = SR): Float32Array {
  const b = new Float32Array(Math.floor(sr * seconds));
  for (let i = 0; i < b.length; i++) b[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr + phase);
  return b;
}

test('LUFS consistency: full-scale 997 Hz mono is about -3.01, -20 dBFS is -23', () => {
  const full = measureLoudness([sine(997, 3)], SR);
  const quiet = measureLoudness([sine(997, 3, 0.1)], SR);
  assert.ok(Math.abs(full.integratedLufs - -3.01) < 0.1, `got ${full.integratedLufs}`);
  assert.ok(Math.abs(quiet.integratedLufs - -23) < 0.1, `got ${quiet.integratedLufs}`);
});

test('true peak exceeds the sample peak of an inter-sample sine', () => {
  const buf = sine(SR / 4, 1, 1, Math.PI / 4);
  let samplePeak = 0;
  for (let i = 0; i < buf.length; i++) samplePeak = Math.max(samplePeak, Math.abs(buf[i]));
  const measured = measureLoudness([buf], SR);
  assert.ok(samplePeak < 0.75, `sample peak ${samplePeak} should miss the crest`);
  assert.ok(measured.truePeakDbtp > 20 * Math.log10(samplePeak) + 2, `true peak ${measured.truePeakDbtp}`);
});

test('tempo of a 120 BPM click track', () => {
  const buf = new Float32Array(SR * 4);
  for (let t = 0; t < 4; t += 0.5) {
    const at = Math.floor(t * SR);
    for (let i = 0; i < 40; i++) buf[at + i] = (1 - i / 40) * (i % 2 === 0 ? 1 : -1);
  }
  const tempo = analyze({ buffers: [buf], sampleRate: SR }).report.rhythm.tempo;
  assert.ok(tempo !== null && Math.abs(tempo - 120) < 0.5, `tempo ${tempo}`);
});

test('swing of a 16th-hat score is recovered', () => {
  const notes = Array.from({ length: 32 }, (_, i) => ({
    t: i * 0.125,
    y: 90,
    size: 0.5,
    duration: 0.04,
    ease: 'exp' as const,
  }));
  const score = ScoreSchema.parse({
    sampleRate: SR,
    bpm: 120,
    swing: 0.42,
    duration: 4.2,
    tracks: [{ id: 'hat', hue: 335, channel: 0, notes }],
  });
  const rendered = render(score);
  const swing = analyze({ buffers: rendered.buffers, sampleRate: SR, score }).report.rhythm.swing;
  assert.ok(swing !== null && Math.abs(swing - 0.42) < 0.03, `swing ${swing}`);
});

test('F minor progression from the v5 chords', () => {
  const bpm = 122;
  const bar = (240 / bpm);
  const chords = [
    { bass: 41, stab: [56, 60, 63, 67] },
    { bass: 37, stab: [56, 60, 63, 65] },
    { bass: 34, stab: [56, 60, 61, 65] },
    { bass: 36, stab: [55, 58, 60, 63] },
  ];
  const bass = [];
  const stabs: { t: number; y: number; size: number; duration: number }[][] = [[], [], [], []];
  for (let i = 0; i < 4; i++) {
    const ch = chords[i];
    bass.push({ t: i * bar, y: ch.bass, size: 0.7, duration: bar * 0.95 });
    ch.stab.forEach((y, v) => stabs[v].push({ t: i * bar, y, size: 0.35, duration: bar * 0.95 }));
  }
  const score = ScoreSchema.parse({
    sampleRate: 22050,
    bpm,
    duration: 4 * bar,
    tracks: [
      { id: 'bass', hue: 30, channel: 0, notes: bass },
      ...stabs.map((notes, v) => ({ id: `stab-${v + 1}`, hue: 90, channel: 0, notes })),
    ],
  });
  const rendered = render(score);
  const key = analyze({ buffers: rendered.buffers, sampleRate: 22050, score }).report.harmony.key;
  assert.equal(key, 'F minor');
});

test('C major chord reads as C major', () => {
  const score = ScoreSchema.parse({
    sampleRate: SR,
    duration: 2,
    tracks: [60, 64, 67].map((y, i) => ({
      id: `c-${i}`,
      hue: 110,
      channel: 0,
      notes: [{ t: 0, y, size: 0.4, duration: 2 }],
    })),
  });
  const rendered = render(score);
  const key = analyze({ buffers: rendered.buffers, sampleRate: SR }).report.harmony.key;
  assert.equal(key, 'C major');
});

test('masking: identical pads overlap, kick and hat do not', () => {
  const note = [{ t: 0, y: 60, size: 0.5, duration: 1.2 }];
  const pads = ScoreSchema.parse({
    sampleRate: SR,
    duration: 1.2,
    tracks: [
      { id: 'pad-1', hue: 210, channel: [0, 1], notes: note },
      { id: 'pad-2', hue: 210, channel: [0, 1], notes: note },
    ],
  });
  const padRender = render(pads, { stems: true });
  const padMask = analyze({
    buffers: padRender.buffers,
    sampleRate: SR,
    stems: padRender.stems,
  }).report.masking!;
  assert.ok(padMask.overlap[0][1] > 0.6, `pad overlap ${padMask.overlap[0][1]}`);

  const drums = ScoreSchema.parse({
    sampleRate: SR,
    duration: 1,
    tracks: [
      {
        id: 'kick',
        hue: 0,
        channel: [0, 1],
        timbre: { transient: 0.2, noise: 0.05 },
        notes: [{ t: 0, y: 36, size: 0.9, duration: 0.4, ease: 'exp' }],
      },
      {
        id: 'hat',
        hue: 335,
        channel: [0, 1],
        notes: [0, 0.25, 0.5, 0.75].map((t) => ({ t, y: 96, size: 0.4, duration: 0.05, ease: 'exp' as const })),
      },
    ],
  });
  const drumRender = render(drums, { stems: true });
  const drumMask = analyze({
    buffers: drumRender.buffers,
    sampleRate: SR,
    stems: drumRender.stems,
  }).report.masking!;
  assert.ok(drumMask.overlap[0][1] < 0.1, `kick/hat overlap ${drumMask.overlap[0][1]}`);
});

test('a loud sustained pad covering a short stab is flagged', () => {
  const score = ScoreSchema.parse({
    sampleRate: SR,
    duration: 2,
    tracks: [
      {
        id: 'pad-1',
        hue: 210,
        channel: [0, 1],
        notes: [{ t: 0, y: 60, size: 0.45, duration: 2, ease: 'hold' }],
      },
      {
        id: 'stab-1',
        hue: 90,
        channel: [0, 1],
        notes: [{ t: 0.4, y: 64, size: 0.2, duration: 0.25, ease: 'exp' }],
      },
    ],
  });
  const rendered = render(score, { stems: true });
  const report = analyze({
    buffers: rendered.buffers,
    sampleRate: SR,
    stems: rendered.stems,
    score,
    profile: 'deep-house',
  }).report;
  const hit = report.findings.find((f) => /pad/.test(f.id) && /stab/.test(f.message));
  assert.ok(hit, report.findings.map((f) => `${f.id} ${f.message}`).join(' | '));
});

test('kick routed to channel 0 in a stereo mix is flagged', () => {
  const score = ScoreSchema.parse({
    sampleRate: SR,
    duration: 0.6,
    tracks: [
      { id: 'kick', hue: 0, channel: 0, notes: [{ t: 0, y: 36, size: 0.9, duration: 0.3, ease: 'exp' }] },
      {
        id: 'hat',
        hue: 335,
        channel: [0, 1],
        notes: [{ t: 0, y: 96, size: 0.3, duration: 0.05, ease: 'exp' }],
      },
    ],
  });
  const rendered = render(score, { stems: true });
  const report = analyze({
    buffers: rendered.buffers,
    sampleRate: SR,
    stems: rendered.stems,
    score,
  }).report;
  const finding = report.findings.find((f) => f.id === 'stereo.lowBalance');
  assert.ok(finding, `low balance ${report.stereo.lowBalanceDb}, no finding`);
  assert.ok(finding!.message.includes('低频左右不平衡'));
  assert.ok(Math.abs(report.stereo.lowBalanceDb) > 3);
});

test('render stems follow score order and are omitted by default', () => {
  const score = ScoreSchema.parse({
    sampleRate: SR,
    duration: 0.2,
    tracks: [
      { id: 'b', hue: 30, channel: 0, notes: [{ t: 0, y: 40, size: 0.4, duration: 0.2 }] },
      { id: 'a', hue: 160, channel: 0, notes: [{ t: 0, y: 64, size: 0.4, duration: 0.2 }] },
    ],
  });
  assert.equal(render(score).stems, undefined);
  assert.deepEqual(render(score, { stems: true }).stems!.map((s) => s.id), ['b', 'a']);
});

test('wav round-trip for 16, 24 and 32-bit float', () => {
  const src = sine(440, 0.05, 0.5);
  for (const bitDepth of [16, 24, 32] as const) {
    const wav = writeWavFile([src, src], SR, { bitDepth, dither: false });
    const back = readWavFile(wav);
    assert.equal(back.bitDepth, bitDepth);
    assert.equal(back.channels, 2);
    assert.equal(back.sampleRate, SR);
    const tol = bitDepth === 16 ? 1 / 32768 : bitDepth === 24 ? 1 / 8388608 : 1e-6;
    for (const i of [0, 10, 100, 1000]) {
      assert.ok(Math.abs(back.buffers[0][i] - src[i]) <= tol + 1e-7, `${bitDepth} @ ${i}`);
    }
  }
});

test('png signature, size and uncompressed length', () => {
  const canvas = new Canvas(5, 3, [1, 2, 3]);
  canvas.set(4, 2, [9, 8, 7]);
  const png = encodePng(canvas.px, 5, 3);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const len = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[9], 6);
    }
    if (type === 'IDAT') idat.push(data);
    offset += 12 + len;
  }
  assert.equal(width, 5);
  assert.equal(height, 3);
  const raw = inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, height * (width * 4 + 1));
  const at = 2 * (width * 4 + 1) + 1 + 4 * 4;
  assert.equal(raw[at], 9);
  assert.equal(raw[at + 1], 8);
  assert.equal(raw[at + 2], 7);
});
