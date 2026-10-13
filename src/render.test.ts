import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeWav, encodeWav, parseScore, render, toMidi } from './index.js';

const rms = (x: Float32Array, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
};

test('note names', () => {
  assert.equal(toMidi('C4'), 60);
  assert.equal(toMidi('A4'), 69);
  assert.equal(toMidi('F#3'), 54);
  assert.equal(toMidi('Bb2'), 46);
  assert.equal(toMidi(36), 36);
});

test('schema rejects bad input', () => {
  assert.throws(() => parseScore({ tracks: [] }));
  assert.throws(() => parseScore({ tracks: [{ id: 'a' }] }), /notes, sfx or clips/);
  assert.throws(() => parseScore({ tracks: [{ id: 'a', instrument: 'lead', notes: [{ t: 0 }], duck: { by: 'nope' } }] }), /duck.by/);
});

test('every instrument and sfx renders finite, non-silent audio', () => {
  const instruments = ['lead', 'bass', 'sub', 'pluck', 'pad', 'keys', 'drums'];
  const score = parseScore({
    tracks: [
      ...instruments.map((id) => ({ id, instrument: id, notes: [{ t: 0, pitch: id === 'drums' ? 36 : 'A3', duration: 0.5 }] })),
      { id: 'fx', sfx: ['whoosh', 'riser', 'impact', 'pop', 'tick'].map((sfx, i) => ({ sfx, t: i * 0.5 })) },
    ],
  });
  const { left, right } = render(score);
  for (const x of [left, right]) {
    assert.ok(x.every(Number.isFinite), 'no NaN/Infinity');
    assert.ok(rms(x) > 0.01, 'audible');
    assert.ok(x.reduce((m, v) => Math.max(m, Math.abs(v)), 0) <= 0.9, 'under the -1 dBFS ceiling');
  }
});

test('same score and seed render identically', () => {
  const s = parseScore({ seed: 3, tracks: [{ id: 'd', instrument: 'drums', notes: [{ t: 0, pitch: 38 }, { t: 0.2, pitch: 42 }] }] });
  assert.deepEqual(render(s).left, render(s).left);
});

test('ducking lowers the music while the voice plays', () => {
  const sr = 48000;
  const voice = new Float32Array(sr); // 1 s of tone, then silence in the score
  for (let i = 0; i < sr; i++) voice[i] = 0.5 * Math.sin((2 * Math.PI * 300 * i) / sr);
  const base = { sampleRate: sr, duration: 3, master: { loudness: -20 } };
  const pad = { id: 'pad', instrument: 'pad', notes: [{ t: 0, pitch: 'C4', duration: 3 }] };
  const opts = { loadClip: () => ({ sampleRate: sr, channels: [voice] }) };
  const voiceTrack = { id: 'vo', role: 'voice', clips: [{ src: 'vo.wav', at: 1 }], gain: -60 };
  const ducked = render(parseScore({ ...base, tracks: [voiceTrack, { ...pad, duck: { by: 'vo', amount: 0.8 } }] }), opts).left;
  const plain = render(parseScore({ ...base, tracks: [voiceTrack, pad] }), opts).left;
  // Compare the pad around 1.5 s (voice on) against 2.7 s (voice off), relative to the unducked render.
  const ratio = (x: Float32Array, a: number) => rms(x, a * sr, (a + 0.2) * sr);
  const during = ratio(ducked, 1.4) / ratio(plain, 1.4);
  const after = ratio(ducked, 2.6) / ratio(plain, 2.6);
  assert.ok(during < 0.5 * after, `ducked ${during.toFixed(2)} vs ${after.toFixed(2)}`);
});

test('WAV round trip', () => {
  const l = Float32Array.from({ length: 100 }, (_, i) => Math.sin(i / 5) * 0.5);
  const wav = decodeWav(encodeWav(l, l, 44100));
  assert.equal(wav.sampleRate, 44100);
  assert.equal(wav.channels.length, 2);
  assert.ok(Math.abs(wav.channels[0][37] - l[37]) < 1e-4);
});
