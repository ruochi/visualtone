import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compile, parseChord, parseKey, parseScore, render, toMidi, voiceChord } from './index.js';
import { decodeWav, encodeWav } from './wav.js';

const rms = (x: Float32Array, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
};

const peakTime = (x: Float32Array, sr: number) => {
  let m = 0;
  let at = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > m) {
    m = Math.abs(x[i]);
    at = i;
  }
  return at / sr;
};

test('note names and chord degrees', () => {
  assert.equal(toMidi('C4'), 60);
  assert.equal(toMidi('A4'), 69);
  assert.equal(toMidi('F#3'), 54);
  assert.equal(toMidi('Bb2'), 46);
  const em7 = parseChord('Em7');
  const score = parseScore({
    tempo: { bpm: 120, meter: '4/4' },
    duration: 2,
    tracks: [
      { id: 'keys', instrument: 'epiano', chords: [{ progression: 'Em7', per: '1bar', register: 'C4' }] },
      { id: 'bass', instrument: 'bass', follow: 'keys', notes: [
        { at: 0, pitch: '1', duration: '1/4' },
        { at: '1:2', pitch: 'b7', duration: '1/8' },
        { at: '1:3', pitch: '8', duration: '1/8' },
      ] },
    ],
  });
  const bass = compile(score).tracks[1].notes;
  assert.equal(bass[0].midi % 12, em7.root);
  assert.equal(bass[1].at, 0.5);
  // b7 is ten semitones above the root, in the bass octave.
  assert.equal((bass[1].midi - bass[0].midi + 120) % 12, 10);
  assert.equal(bass[2].midi, bass[0].midi + 12);
});

test('unknown fields are rejected with a suggestion', () => {
  assert.throws(() => parseScore({ version: 1, tracks: [{ id: 'a', notes: [{ t: 0, pitch: 60 }] }] }), /version 2/);
  assert.throws(
    () => parseScore({ tracks: [{ id: 'a', instrument: 'piano', notes: [{ t: 0, pitch: 'C4', size: 0.5 }] }] }),
    /did you mean "at"[\s\S]*did you mean "velocity"/,
  );
  assert.throws(() => parseScore({ master: {}, tracks: [{ id: 'a', instrument: 'piano', notes: [{ at: 0, pitch: 'C4' }] }] }), /did you mean "mix"/);
  assert.throws(() => parseScore({ tracks: [{ id: 'a', instrument: 'keys', hue: 10, notes: [{ at: 0, pitch: 'C4' }] }] }), /did you mean "brightness"/);
  assert.throws(() => parseScore({ tracks: [{ id: 'a', instrument: 'keys', notes: [{ at: 0, pitch: 'C4' }] }] }), /did you mean "epiano"/);
  assert.throws(() => compile(parseScore({ tracks: [{ id: 'a', instrument: 'drums', notes: [{ at: 0, pitch: 'snar' }] }] })), /did you mean "snare"/);
  assert.throws(() => parseScore({ tracks: [{ id: 'a', instrument: 'piano', notes: [{ at: 0, pitch: 'C4' }], duck: { by: 'nope' } }] }), /duck.by/);
  assert.throws(() => parseScore({ tracks: [{ id: 'a', instrument: 'piano', notes: [{ at: 0, pitch: 'C4' }], duck: { track: 'a' } }] }), /did you mean "by"/);
  assert.throws(() => parseScore({ tracks: [{ id: 'a', role: 'sfx', sfx: [{ type: 'swoosh', at: 0 }] }] }), /did you mean "whoosh"/);
  assert.throws(() => parseScore({ tracks: [{ id: 'a', role: 'sfx', sfx: [{ type: 'ding', at: 0 }] }] }), /did you mean "chime"/);
  assert.throws(() => parseScore({ tracks: [{ id: 'a', instrument: 'piano', notes: [{ at: 0, pitch: 'C4' }], duck: false }] }), /did you mean "off"/);
  assert.throws(() => parseScore({ tracks: [{ id: 'a', instrument: 'piano', notes: [{ at: 0, pitch: 'C4' }], duck: true }] }), /did you mean "auto"/);
});

test('bars, sections and swing', () => {
  const score = parseScore({
    tempo: { bpm: 120, meter: '4/4', swing: 0.5 },
    duration: 3,
    sections: [{ id: 'intro', at: 0 }, { id: 'verse', at: 0.5 }],
    tracks: [{
      id: 'lead',
      instrument: 'lead',
      notes: [
        { at: '2:1', pitch: 'C4' },
        { at: '1:3', pitch: 'D4' },
        { at: 'verse', pitch: 'E4' },
        { at: 'verse@2:1', pitch: 'F4' },
      ],
      patterns: [{ in: ['intro'], grid: '1/16', notes: 'C4 C4 C4 C4' }],
    }],
  });
  const notes = compile(score).tracks[0].notes;
  const at = (p: string) => notes.find((n) => n.midi === toMidi(p) && n.source === 'note')!.at;
  assert.equal(at('C4'), 2);
  assert.equal(at('D4'), 1);
  assert.equal(at('E4'), 0.5);
  assert.equal(at('F4'), 2.5);
  const pattern = notes.filter((n) => n.source === 'pattern').map((n) => n.at);
  // Odd 16ths are delayed by half a 16th (0.0625s at 120 bpm).
  assert.deepEqual(pattern.map((t) => Math.round(t * 1000) / 1000), [0, 0.188, 0.25, 0.438]);
});

test('patterns restart at each section and stop at the boundary', () => {
  const compiled = compile(parseScore({
    tempo: { bpm: 120, meter: '4/4' },
    duration: 1.5,
    sections: [{ id: 'a', at: 0 }, { id: 'b', at: 1 }],
    tracks: [{ id: 'd', instrument: 'drums', patterns: [{ in: ['a', 'b'], grid: '1/16', steps: { kick: 'x.x.' } }] }],
  }));
  const hits = compiled.tracks[0].notes.map((n) => n.at);
  assert.deepEqual(hits, [0, 0.25, 0.5, 0.75, 1, 1.25]);
});

test('pitched pattern follows the chord, and ties hold', () => {
  const compiled = compile(parseScore({
    tempo: { bpm: 120, meter: '4/4' },
    key: 'C major',
    duration: 4,
    tracks: [
      { id: 'keys', instrument: 'epiano', chords: [{ progression: 'C Dm', per: '1bar', style: 'pad', register: 'C4' }] },
      { id: 'bass', instrument: 'bass', follow: 'keys', patterns: [{ grid: '1bar', notes: '1' }] },
      { id: 'lead', instrument: 'lead', follow: 'keys', patterns: [{ grid: '1/4', notes: '1 - 5 .' }] },
    ],
  }));
  const bass = compiled.tracks[1].notes;
  assert.equal(bass.length, 2);
  assert.equal(bass[0].midi % 12, 0);
  assert.equal(bass[1].midi % 12, 2);
  const lead = compiled.tracks[2].notes.filter((n) => n.at < 2);
  assert.equal(lead.length, 2);
  assert.equal(lead[0].duration, 1);
  assert.equal(lead[0].midi % 12, 0);
  assert.equal(lead[1].midi % 12, 7);
  assert.equal(compiled.issues.some((i) => i.code === 'out-of-key'), false);
});

test('voice leading stays close on the funk progression', () => {
  let prev: number[] | null = null;
  for (const symbol of ['Em7', 'A7', 'Dmaj7', 'Bm7']) {
    const chord = parseChord(symbol);
    const voices = voiceChord(chord, 60, 'close', prev, [48, 79]);
    assert.ok(voices.every((m) => m >= 48 && m <= 79), `${symbol} ${voices}`);
    assert.ok(voices.some((m) => ((m % 12) + 12) % 12 === chord.root), symbol);
    if (prev) {
      const move = Math.max(...voices.map((m, i) => Math.abs(m - (prev![i] ?? m))));
      assert.ok(move <= 7, `${symbol} moved ${move}`);
    }
    prev = voices;
  }
});

test('minor key allows the raised 6th, and reports a real outside note', () => {
  const ok = compile(parseScore({
    key: 'E minor',
    tracks: [{ id: 'p', instrument: 'piano', notes: [{ at: 0, pitch: 'C#4' }] }],
  }));
  assert.equal(ok.issues.some((i) => i.code === 'out-of-key'), false);
  const bad = compile(parseScore({
    key: 'E minor',
    tracks: [{ id: 'p', instrument: 'piano', notes: [{ at: 0, pitch: 'F4' }] }],
  }));
  assert.equal(bad.issues.some((i) => i.code === 'out-of-key' && i.track === 'p'), true);
});

test('reports range, flat velocity, crowded sfx and a clipped whoosh', () => {
  const compiled = compile(parseScore({
    tempo: { bpm: 120 },
    duration: 4,
    tracks: [
      { id: 'bass', instrument: 'bass', notes: [{ at: 0, pitch: 'C6' }] },
      { id: 'lead', instrument: 'lead', notes: Array.from({ length: 8 }, (_, i) => ({ at: i * 0.2, pitch: 'C4', velocity: 0.8 })) },
      { id: 'drums', instrument: 'drums', patterns: [{ grid: '1/8', steps: { kick: 'x...X...' } }] },
      { id: 'fx', role: 'sfx', sfx: [{ type: 'pop', at: [0, 0.02] }, { type: 'whoosh', at: 0.05, duration: 0.8 }] },
    ],
  }));
  const codes = compiled.issues.map((i) => i.code);
  assert.ok(codes.includes('out-of-range'));
  assert.ok(codes.includes('flat-velocity'));
  assert.ok(codes.includes('dense-sfx'));
  assert.ok(codes.includes('sfx-clipped'));
  assert.equal(compiled.issues.some((i) => i.track === 'drums' && i.code === 'flat-velocity'), false);
});

test('sfx anchors: whoosh peaks at `at`, riser arrives at `at`, impact starts at `at`', () => {
  const sr = 16000;
  const score = parseScore({
    sampleRate: sr,
    duration: 3,
    tracks: [{
      id: 'fx',
      role: 'sfx',
      space: 0,
      sfx: [
        { type: 'whoosh', at: 1, duration: 0.6, size: 0.9 },
        { type: 'riser', at: 2.2, duration: 0.8, size: 0.8 },
        { type: 'impact', at: 0.4, size: 0.9 },
      ],
    }],
  });
  const { left } = render(score);
  const window = (center: number, half: number) => {
    const a = Math.max(0, Math.floor((center - half) * sr));
    const b = Math.min(left.length, Math.floor((center + half) * sr));
    return peakTime(left.subarray(a, b), sr) + a / sr;
  };
  assert.ok(Math.abs(window(1, 0.35) - 1) < 0.06, 'whoosh peak');
  assert.ok(Math.abs(window(2.2, 0.5) - 2.2) < 0.08, 'riser arrival');
  assert.ok(window(0.4, 0.2) - 0.4 < 0.05 && window(0.4, 0.2) >= 0.4 - 0.005, 'impact attack');
});

test('every instrument and sfx renders finite audio under the ceiling', () => {
  const instruments = ['drums', 'bass', 'sub', 'synth-bass', 'piano', 'epiano', 'organ', 'pad', 'strings', 'pluck', 'lead', 'bell', 'marimba'];
  const sfx = ['whoosh', 'riser', 'downlifter', 'swell', 'impact', 'boom', 'hit', 'pop', 'click', 'tick', 'type', 'glitch', 'shimmer', 'chime'];
  const score = parseScore({
    duration: 2.4,
    tracks: [
      ...instruments.map((id) => ({
        id,
        instrument: id,
        notes: [{ at: 0.1, pitch: id === 'drums' ? 'kick' : 'A3', duration: 0.4 }],
      })),
      { id: 'fx', role: 'sfx', space: 0, sfx: sfx.map((type, i) => ({ type, at: 0.2 + (i % 7) * 0.25, duration: 0.3 })) },
    ],
  });
  const { left, right } = render(score);
  for (const x of [left, right]) {
    assert.ok(x.every(Number.isFinite));
    assert.ok(rms(x) > 0.01);
    assert.ok(x.reduce((m, v) => Math.max(m, Math.abs(v)), 0) <= 0.9);
  }
});

test('same score and seed render identically, and repeated sfx are not identical', () => {
  const score = parseScore({
    seed: 3,
    tempo: { bpm: 120 },
    duration: 1,
    tracks: [
      { id: 'd', instrument: 'drums', patterns: [{ grid: '1/16', steps: { hat: 'xxxx', snare: '..X.' } }] },
      { id: 'fx', role: 'sfx', space: 0, sfx: [{ type: 'whoosh', at: [0.2, 0.7], duration: 0.3 }] },
    ],
  });
  const a = render(score);
  const b = render(score);
  assert.deepEqual(a.left, b.left);
  // The two whooshes share a length but not a waveform, so the mix at 0.2s and 0.7s differs.
  const sr = a.sampleRate;
  let same = 0;
  const n = Math.floor(0.15 * sr);
  for (let i = 0; i < n; i++) if (a.left[Math.floor(0.25 * sr) + i] === a.left[Math.floor(0.75 * sr) + i]) same++;
  assert.ok(same < n * 0.9, 'repeated whooshes should vary');
});

test('a voice track ducks the music and a covered voice is reported', () => {
  const sr = 16000;
  const voice = new Float32Array(sr);
  for (let i = 0; i < voice.length; i++) voice[i] = 0.5 * Math.sin((2 * Math.PI * 180 * i) / sr);
  const base = { sampleRate: sr, duration: 2 };
  const pad = { id: 'pad', instrument: 'pad', space: 0, notes: [{ at: 0, pitch: 'C4', duration: 2 }] };
  // Quiet in the mix, but the ducking envelope is normalized, so the pad still yields.
  const voiceTrack = { id: 'vo', role: 'voice', space: 0, clips: [{ src: 'vo.wav', at: 0, gain: -36 }] };
  const opts = { clips: { 'vo.wav': { sampleRate: sr, channels: [voice] } } };
  const ducked = render(parseScore({ ...base, tracks: [voiceTrack, pad] }), opts).left;
  const open = render(parseScore({ ...base, tracks: [voiceTrack, { ...pad, duck: 'off' }] }), opts).left;
  const ratio = (x: Float32Array, a: number) => rms(x, a * sr, (a + 0.2) * sr);
  const during = ratio(ducked, 0.4) / ratio(open, 0.4);
  const after = ratio(ducked, 1.5) / ratio(open, 1.5);
  assert.ok(during < 0.75 * after, `ducked ${during.toFixed(2)} vs recovered ${after.toFixed(2)}`);

  const tone = (freq: number, amp: number) => {
    const x = new Float32Array(sr);
    for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
    return x;
  };
  const covered = render(parseScore({
    ...base,
    tracks: [
      { id: 'vo', role: 'voice', space: 0, clips: [{ src: 'v.wav', at: 0 }] },
      { id: 'bed', role: 'music', space: 0, duck: 'off', clips: [{ src: 'm.wav', at: 0, gain: 12 }] },
    ],
  }), { clips: { 'v.wav': { sampleRate: sr, channels: [tone(2500, 0.2)] }, 'm.wav': { sampleRate: sr, channels: [tone(2500, 0.2)] } } });
  assert.ok(covered.report.issues.some((i) => i.code === 'voice-masked'), covered.report.issues.map((i) => i.message).join('; '));
});

test('deep limiting is reported when the ceiling sits far under the loudness', () => {
  const result = render(parseScore({
    sampleRate: 16000,
    duration: 1,
    mix: { loudness: -12, ceiling: -20 },
    tracks: [{ id: 'd', instrument: 'drums', space: 0, notes: [{ at: 0.1, pitch: 'kick', velocity: 1 }] }],
  }));
  assert.ok(result.report.limiterDb > 8);
  assert.ok(result.report.issues.some((i) => i.code === 'deep-limiting'));
});

test('clips honor offset, duration and an in-memory buffer', () => {
  const sr = 8000;
  const data = new Float32Array(sr);
  data[100] = 1;
  let first = -1;
  render(parseScore({
    sampleRate: sr,
    duration: 0.5,
    mix: { loudness: 0, ceiling: 0 },
    tracks: [{ id: 'vo', role: 'voice', space: 0, gain: 0, clips: [{ src: 'v.wav', at: 0, offset: 100 / sr, duration: 0.2 }] }],
  }), {
    clips: { 'v.wav': { sampleRate: sr, channels: [data] } },
    processTrack(_track, audio) {
      for (let i = 0; i < audio[0].length; i++) if (Math.abs(audio[0][i]) > 0.2) {
        first = i;
        break;
      }
    },
  });
  assert.equal(first, 0);
});

test('funk example is in key, in range, and much shorter than a note list', () => {
  const score = parseScore(JSON.parse(readFileSync(new URL('../examples/funk.json', import.meta.url), 'utf8')));
  const compiled = compile(score);
  assert.deepEqual(compiled.issues.map((i) => i.code), []);
  assert.equal(compiled.tracks.find((t) => t.id === 'bass')!.notes[0].midi % 12, 2); // D, bar 3 of Em7 A7 Dmaj7 Bm7
  assert.ok(compiled.contentEnd > 34 && compiled.contentEnd < 34.3);
  assert.ok(readFileSync(new URL('../examples/funk.json', import.meta.url), 'utf8').length < 8000);
});

test('empty tracks render silence, and a missing clip names its src', () => {
  const empty = parseScore({ duration: 0.25, sampleRate: 8000, tracks: [{ id: 'a', instrument: 'piano' }] });
  const none = parseScore({ duration: 0.25, sampleRate: 8000, tracks: [] });
  const silent = render(empty, { envelopes: true });
  assert.ok(silent.left.every((v) => v === 0));
  assert.equal(silent.envelopes?.length, 1);
  assert.ok(silent.envelopes![0].level.every((v) => v === 0));
  assert.equal(render(none).left.length, silent.left.length);
  assert.equal(render(none).envelopes, undefined);
  assert.throws(
    () => render(parseScore({ tracks: [{ id: 'v', role: 'voice', clips: [{ src: 'voice/missing.wav', at: 0 }] }] })),
    /voice\/missing\.wav/,
  );
});

test('a drum row of x is accented, and short keys and extended chords parse', () => {
  const drums = compile(parseScore({
    tempo: { bpm: 120 },
    duration: 2,
    tracks: [{ id: 'd', instrument: 'drums', patterns: [{ grid: '1/16', steps: { hat: 'xxxxxxxxxxxxxxxx' } }] }],
  }));
  assert.equal(drums.issues.some((i) => i.code === 'flat-velocity'), false);
  const velocities = drums.tracks[0].notes.map((n) => n.velocity);
  assert.ok(Math.max(...velocities) - Math.min(...velocities) > 0.05);

  const ext = parseChord('Dmaj13#11');
  assert.equal(ext.root, 2);
  assert.ok(ext.voicing.includes(18));
  assert.ok(ext.voicing.map((i) => (ext.root + i) % 12).includes((ext.root + 6) % 12));
  const six = parseChord('C6/9');
  assert.equal(six.bass, undefined);
  assert.ok(six.voicing.includes(9) && six.voicing.includes(14));
  assert.equal(six.members[7], 11);
  assert.equal(parseChord('C/E').bass, 4);
  assert.equal(parseChord('Em7').members[3], 3);

  const em = parseKey('Em');
  const full = parseKey('E minor');
  assert.equal(em.root, full.root);
  assert.deepEqual([...em.pitchClasses].sort(), [...full.pitchClasses].sort());
  const bb = parseKey('Bb');
  assert.equal(bb.root, 10);
  assert.equal(bb.pitchClasses.has(2), true);
  assert.equal(bb.pitchClasses.has(1), false);
  assert.equal(parseKey('F#m').root, 6);
});

test('envelopes are post-duck levels, and the vocal dip follows the voice', () => {
  const sr = 16000;
  const n = sr * 2;
  const voice = new Float32Array(n);
  for (let i = 0; i < sr; i++) voice[i] = 0.5 * Math.sin((2 * Math.PI * 180 * i) / sr);
  const tone = new Float32Array(n);
  for (let i = 0; i < n; i++) tone[i] = 0.25 * Math.sin((2 * Math.PI * 2500 * i) / sr);
  const clips = { 'v.wav': { sampleRate: sr, channels: [voice] }, 'm.wav': { sampleRate: sr, channels: [tone] } };
  const tracks = [
    { id: 'vo', role: 'voice' as const, space: 0, clips: [{ src: 'v.wav', at: 0 }] },
    { id: 'bed', role: 'music' as const, instrument: 'pad', space: 0, clips: [{ src: 'm.wav', at: 0 }] },
    { id: 'bassbed', role: 'music' as const, instrument: 'bass', space: 0, clips: [{ src: 'm.wav', at: 0 }] },
    { id: 'empty', instrument: 'piano' },
  ];
  const score = parseScore({ sampleRate: sr, duration: 2, tracks });
  const rendered = render(score, { clips, envelopes: true });
  assert.equal(rendered.envelopes?.length, 4);
  assert.equal(rendered.envelopes![1].level.length, rendered.left.length);
  assert.ok(rendered.envelopes!.find((e) => e.id === 'empty')!.level.every((v) => v === 0));
  assert.equal(render(score, { clips }).envelopes, undefined);

  const mean = (x: Float32Array, a: number, b: number) => {
    let s = 0;
    const i0 = Math.floor(a * sr);
    const i1 = Math.floor(b * sr);
    for (let i = i0; i < i1; i++) s += x[i];
    return s / Math.max(1, i1 - i0);
  };
  const pad = rendered.envelopes!.find((e) => e.id === 'bed')!.level;
  const bass = rendered.envelopes!.find((e) => e.id === 'bassbed')!.level;
  const padRatio = mean(pad, 0.35, 0.7) / mean(pad, 1.6, 1.9);
  const bassRatio = mean(bass, 0.35, 0.7) / mean(bass, 1.6, 1.9);
  assert.ok(bassRatio < 0.7 && bassRatio > 0.25, `duck ratio ${bassRatio.toFixed(2)}`);
  assert.ok(padRatio < bassRatio * 0.75, `pad ${padRatio.toFixed(2)} bass ${bassRatio.toFixed(2)}`);
});

test('a 1 kHz sine lands on the K-weighted loudness target', () => {
  const sr = 48000;
  const result = render(parseScore({
    sampleRate: sr,
    duration: 1.2,
    mix: { loudness: -16, ceiling: 0 },
    tracks: [{ id: 't', role: 'sfx', space: 0, sfx: [{ type: 'tick', at: 0.1 }] }],
  }), {
    processMaster(mix) {
      for (let i = 0; i < mix[0].length; i++) {
        mix[0][i] = Math.sin((2 * Math.PI * 1000 * i) / sr);
        mix[1][i] = 0;
      }
    },
  });
  assert.ok(Math.abs(result.report.loudnessDb + 16) < 0.5, `report ${result.report.loudnessDb}`);
  const mid = rms(result.left, Math.floor(0.4 * sr), Math.floor(0.8 * sr));
  const approx = 20 * Math.log10(mid);
  assert.ok(Math.abs(approx + 16) < 0.5, `rms ${approx}`);
});

test('WAV round trip', () => {
  const l = Float32Array.from({ length: 100 }, (_, i) => Math.sin(i / 5) * 0.5);
  const wav = decodeWav(encodeWav(l, l, 44100));
  assert.equal(wav.sampleRate, 44100);
  assert.equal(wav.channels.length, 2);
  assert.ok(Math.abs(wav.channels[0][37] - l[37]) < 1e-4);
});
