/**
 * Score → stereo buffers. `instruments` replaces the built-in synths;
 * `processTrack` and `processMaster` are the other two extension points.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { compile, type CompiledScore, type CompiledTrack, type Issue } from './compile.js';
import { dbToGain, gainToDb, OnePole, rng, Svf } from './dsp.js';
import { limit, reverb } from './effects.js';
import { INSTRUMENTS, renderDrumNote, renderSynthNote, type InstrumentInfo } from './instruments.js';
import type { Score, Track } from './schema.js';
import { renderSfx } from './sfx.js';
import { type DecodedWav, decodeWav } from './wav.js';

export type Stereo = [Float32Array, Float32Array];

export interface NoteContext {
  sampleRate: number;
  rand: () => number;
  track: Track;
  brightness: number;
}

export interface Instrument {
  /** Mono or stereo buffer starting at note-on, including the release tail. */
  renderNote(note: CompiledTrack['notes'][number], midi: number, ctx: NoteContext): Float32Array | Stereo;
  tail?: number;
}

export type InstrumentResolver = (track: Track) => Instrument | undefined;

export interface ClipBuffer {
  sampleRate: number;
  channels: Float32Array[];
}

export interface RenderOptions {
  instruments?: InstrumentResolver;
  /** Base directory for clip paths. */
  baseDir?: string;
  /** In-memory clips. Keys match `src` in the score, so nothing is read from disk. */
  clips?: Record<string, ClipBuffer>;
  loadClip?: (path: string) => DecodedWav;
  /** Runs on each track after gain and pan, before ducking and the vocal dip. */
  processTrack?: (track: Track, audio: Stereo, sampleRate: number) => void;
  /** Runs on the summed mix, before loudness match and limiting. */
  processMaster?: (mix: Stereo, sampleRate: number) => void;
}

export interface RenderResult {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  report: {
    /** Length of the returned buffers, seconds. */
    duration: number;
    /** End of the written music, before release tails. */
    contentDuration: number;
    peakDb: number;
    loudnessDb: number;
    /** How many dB the limiter took off the loudest peak. */
    limiterDb: number;
    issues: Issue[];
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The built-in instrument for a track. */
export function liteInstrument(track: Track): Instrument {
  const info: InstrumentInfo | undefined = track.instrument ? INSTRUMENTS[track.instrument] : undefined;
  if (!info) throw new Error(`track ${track.id}: unknown instrument "${track.instrument ?? ''}"`);
  if (info.kind === 'drums') {
    return { tail: info.tail, renderNote: (n, _m, c) => renderDrumNote(n, c) };
  }
  return { tail: info.tail, renderNote: (n, m, c) => renderSynthNote(info, n, m, c) };
}

function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const n = Math.max(0, Math.floor((x.length * to) / from));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = (i * from) / to;
    const j = Math.floor(p);
    out[i] = x[j] * (1 - (p - j)) + (x[j + 1] ?? 0) * (p - j);
  }
  return out;
}

function addPanned(dst: Stereo, src: Float32Array | Stereo, at: number, pan: number, gain = 1): void {
  const a = ((pan + 1) * Math.PI) / 4;
  const gl = Math.cos(a) * Math.SQRT2 * gain;
  const gr = Math.sin(a) * Math.SQRT2 * gain;
  const [l, r] = Array.isArray(src) ? src : [src, src];
  const end = Math.min(dst[0].length - at, l.length);
  for (let i = Math.max(0, -at); i < end; i++) {
    dst[0][at + i] += l[i] * gl;
    dst[1][at + i] += r[i] * gr;
  }
}

/** A few dB out of the vocal band, so a pad doesn't sit on the voice. */
function dipVocal(x: Float32Array, sampleRate: number, amount: number): void {
  if (amount <= 0) return;
  const f = new Svf(sampleRate);
  for (let i = 0; i < x.length; i++) {
    const band = f.process(x[i], 2500, 0.9)[1];
    x[i] -= amount * band;
  }
}

function envelope(x: Stereo, sampleRate: number, releaseSec: number): Float32Array {
  const atk = Math.exp(-1 / (0.005 * sampleRate));
  const rel = Math.exp(-1 / (releaseSec * sampleRate));
  const env = new Float32Array(x[0].length);
  let e = 0;
  let peak = 1e-9;
  for (let i = 0; i < env.length; i++) {
    const v = Math.max(Math.abs(x[0][i]), Math.abs(x[1][i]));
    e = v > e ? atk * e + (1 - atk) * v : rel * e + (1 - rel) * v;
    env[i] = e;
    if (e > peak) peak = e;
  }
  for (let i = 0; i < env.length; i++) env[i] = Math.min(1, env[i] / (peak * 0.5));
  return env;
}

function loudness(l: Float32Array, r: Float32Array, sampleRate: number): number {
  const block = Math.round(0.4 * sampleRate);
  let sum = 0;
  let count = 0;
  for (let s = 0; s + block <= l.length; s += block) {
    let e = 0;
    for (let i = s; i < s + block; i++) e += l[i] * l[i] + r[i] * r[i];
    e /= block * 2;
    if (e > 1e-5) {
      sum += e;
      count++;
    }
  }
  return count ? 10 * Math.log10(sum / count) : -120;
}

function bandEnergy(x: Float32Array, sampleRate: number, hz: number, gate: Float32Array): number {
  const f = new Svf(sampleRate);
  let e = 0;
  let n = 0;
  for (let i = 0; i < x.length; i++) {
    const b = f.process(x[i], hz, 0.8)[1];
    if (gate[i] > 0.2) {
      e += b * b;
      n++;
    }
  }
  return n > sampleRate * 0.15 ? e / n : 0;
}

function takeClip(src: Stereo, clip: CompiledTrack['clips'][number], sampleRate: number): Stereo {
  const offset = Math.round(clip.offset * sampleRate);
  const available = Math.max(0, src[0].length - offset);
  const want = clip.duration !== undefined ? Math.max(0, Math.round(clip.duration * sampleRate)) : available;
  const out: Stereo = [new Float32Array(want), new Float32Array(want)];
  if (!want || !available) return out;
  for (let i = 0; i < want; i++) {
    let j = offset + i;
    if (j >= src[0].length) {
      if (!clip.loop) break;
      j = offset + ((i % available) + available) % available;
    }
    const left = want - i;
    const gIn = clip.fadeIn > 0 ? Math.min(1, i / (clip.fadeIn * sampleRate)) : 1;
    const gOut = clip.fadeOut > 0 ? Math.min(1, left / (clip.fadeOut * sampleRate)) : 1;
    const g = Math.min(gIn, gOut);
    out[0][i] = src[0][j] * g;
    out[1][i] = src[1][j] * g;
  }
  return out;
}

function loadScoreClips(score: Score, opts: RenderOptions): { buffers: Map<string, Stereo>; lengths: Record<string, number> } {
  const sr = score.sampleRate;
  const baseDir = opts.baseDir ?? process.cwd();
  const buffers = new Map<string, Stereo>();
  const lengths: Record<string, number> = {};
  const srcs = [...new Set(score.tracks.flatMap((t) => t.clips.map((c) => c.src)))];
  for (const src of srcs) {
    const given = opts.clips?.[src];
    const wav = given ?? (opts.loadClip ?? ((p: string) => decodeWav(readFileSync(p))))(resolve(baseDir, src));
    const l = resample(wav.channels[0] ?? new Float32Array(), wav.sampleRate, sr);
    const r = wav.channels[1] ? resample(wav.channels[1], wav.sampleRate, sr) : l;
    buffers.set(src, [l, r]);
    lengths[src] = l.length / sr;
  }
  return { buffers, lengths };
}

export function render(score: Score, opts: RenderOptions = {}): RenderResult {
  const { buffers: clipBuffers, lengths } = loadScoreClips(score, opts);
  const compiled: CompiledScore = compile(score, { clipLengths: lengths });
  const sr = compiled.sampleRate;
  const tail = compiled.fixedDuration !== undefined
    ? 0
    : Math.max(0.05, ...compiled.tracks.map((t) => t.tail), compiled.tracks.some((t) => t.space > 0.01) ? 1.1 : 0);
  const duration = (compiled.fixedDuration ?? compiled.contentEnd) + tail;
  const n = Math.max(1, Math.ceil(duration * sr));
  const issues: Issue[] = [...compiled.issues];

  const buses = compiled.tracks.map((track): Stereo => {
    const buf: Stereo = [new Float32Array(n), new Float32Array(n)];
    const rand = rng(compiled.seed ^ hash(track.id));
    const plays = track.notes.length > 0;
    const inst = plays ? (opts.instruments?.(track.source) ?? liteInstrument(track.source)) : undefined;
    const ctx: NoteContext = { sampleRate: sr, rand, track: track.source, brightness: track.brightness };
    for (const note of track.notes) {
      const audio = inst!.renderNote(note, note.midi, ctx);
      addPanned(buf, audio, Math.round(note.at * sr), 0);
    }
    for (const e of track.sfx) {
      addPanned(buf, renderSfx(e, sr, rand), Math.round(e.start * sr), e.pan);
    }
    for (const clip of track.clips) {
      const src = clipBuffers.get(clip.src);
      if (!src) throw new Error(`track ${track.id}: missing clip "${clip.src}"`);
      const slice = takeClip(src, clip, sr);
      addPanned(buf, slice, Math.round(clip.at * sr), 0, dbToGain(clip.gain) / Math.SQRT2);
    }
    const g = dbToGain(track.gain);
    const angle = ((track.pan + 1) * Math.PI) / 4;
    const gains = [Math.cos(angle) * Math.SQRT2 * g, Math.sin(angle) * Math.SQRT2 * g];
    for (let c = 0; c < 2; c++) {
      const hp = new OnePole(sr);
      const x = buf[c];
      for (let i = 0; i < n; i++) x[i] = (track.lowCut ? hp.high(x[i], track.lowCut) : x[i]) * gains[c];
    }
    opts.processTrack?.(track.source, buf, sr);
    if (track.vocalDip) {
      dipVocal(buf[0], sr, track.vocalDip);
      dipVocal(buf[1], sr, track.vocalDip);
    }
    return buf;
  });

  const voiceMix: Stereo = [new Float32Array(n), new Float32Array(n)];
  compiled.tracks.forEach((track, ti) => {
    if (track.role !== 'voice') return;
    for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) voiceMix[c][i] += buses[ti][c][i];
  });
  const voiceEnv = compiled.tracks.some((t) => t.duck?.auto) ? envelope(voiceMix, sr, 0.28) : undefined;
  const envs = new Map<string, Float32Array>();
  compiled.tracks.forEach((track, ti) => {
    const duck = track.duck;
    if (!duck) return;
    let env: Float32Array | undefined;
    if (duck.auto) env = voiceEnv;
    else {
      const key = `${duck.by}:${duck.release}`;
      env = envs.get(key);
      if (!env) {
        const src = compiled.tracks.findIndex((t) => t.id === duck.by);
        if (src < 0) return;
        env = envelope(buses[src], sr, duck.release);
        envs.set(key, env);
      }
    }
    if (!env) return;
    for (let i = 0; i < n; i++) {
      const g = 1 - duck.amount * env[i];
      buses[ti][0][i] *= g;
      buses[ti][1][i] *= g;
    }
  });

  if (compiled.tracks.some((t) => t.role === 'voice')) {
    const music: Stereo = [new Float32Array(n), new Float32Array(n)];
    compiled.tracks.forEach((track, ti) => {
      if (track.role !== 'music') return;
      for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) music[c][i] += buses[ti][c][i];
    });
    const gate = envelope(voiceMix, sr, 0.2);
    const voiceBand = bandEnergy(voiceMix[0], sr, 2500, gate);
    const musicBand = bandEnergy(music[0], sr, 2500, gate);
    // bandEnergy is mean square, so a power ratio uses 10 log10. 4× is about 6 dB.
    if (voiceBand > 1e-8 && musicBand > voiceBand * 4) {
      const db = 10 * Math.log10(musicBand / voiceBand);
      issues.push({
        code: 'voice-masked',
        message: `voice is covered: while the voice is speaking, music is ${db.toFixed(1)} dB louder around 2.5 kHz`,
      });
    }
  }

  const mix: Stereo = [new Float32Array(n), new Float32Array(n)];
  const rvIn: Stereo = [new Float32Array(n), new Float32Array(n)];
  compiled.tracks.forEach((track, ti) => {
    for (let c = 0; c < 2; c++) {
      const x = buses[ti][c];
      for (let i = 0; i < n; i++) {
        mix[c][i] += x[i];
        if (track.space) rvIn[c][i] += x[i] * track.space;
      }
    }
  });
  if (compiled.tracks.some((t) => t.space > 0)) {
    const [wl, wr] = reverb(rvIn[0], rvIn[1], 0.55, 0.48, sr);
    for (let i = 0; i < n; i++) {
      mix[0][i] += wl[i];
      mix[1][i] += wr[i];
    }
  }
  opts.processMaster?.(mix, sr);

  for (let c = 0; c < 2; c++) {
    let xPrev = 0;
    let yPrev = 0;
    const x = mix[c];
    for (let i = 0; i < n; i++) {
      const y = x[i] - xPrev + 0.9995 * yPrev;
      xPrev = x[i];
      yPrev = y;
      x[i] = y;
    }
  }
  const before = loudness(mix[0], mix[1], sr);
  const matched = before > -120 ? dbToGain(compiled.mix.loudness - before) : 1;
  for (let i = 0; i < n; i++) {
    mix[0][i] *= matched;
    mix[1][i] *= matched;
  }
  const limiterDb = limit(mix[0], mix[1], compiled.mix.ceiling, sr);
  if (limiterDb > 8) {
    issues.push({
      code: 'deep-limiting',
      message: `limiter reduced the mix by ${limiterDb.toFixed(1)} dB. Lower a track gain, or the loud notes will pump`,
    });
  }
  const fade = Math.min(n, Math.round(0.012 * sr));
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    mix[0][n - 1 - i] *= g;
    mix[1][n - 1 - i] *= g;
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(mix[0][i]), Math.abs(mix[1][i]));

  return {
    left: mix[0],
    right: mix[1],
    sampleRate: sr,
    report: {
      duration: n / sr,
      contentDuration: compiled.contentEnd,
      peakDb: gainToDb(peak),
      loudnessDb: loudness(mix[0], mix[1], sr),
      limiterDb,
      issues,
    },
  };
}

export function baseDirOf(scorePath: string): string {
  return dirname(resolve(scorePath));
}
