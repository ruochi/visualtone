/**
 * Score → stereo buffers. Instruments are pluggable: pass `instruments` to
 * replace the built-in lite synths (this is how visualtonestudio plugs in).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { OnePole, dbToGain, gainToDb, rng } from './dsp.js';
import { delay, limit, reverb } from './effects.js';
import { INSTRUMENTS, renderDrumNote, renderSynthNote } from './instruments.js';
import { type Note, type Score, type Track, toMidi } from './schema.js';
import { renderSfx, SFX_DURATION } from './sfx.js';
import { type DecodedWav, decodeWav } from './wav.js';

export type Stereo = [Float32Array, Float32Array];

export interface NoteContext {
  sampleRate: number;
  rand: () => number;
  track: Track;
}

export interface Instrument {
  /** Mono or stereo buffer starting at note-on, including the release tail. */
  renderNote(note: Note, midi: number, ctx: NoteContext): Float32Array | Stereo;
  /** Seconds of sound after note-off, used to size the render. */
  tail?: number;
}

export type InstrumentResolver = (track: Track) => Instrument | undefined;

export interface RenderOptions {
  instruments?: InstrumentResolver;
  /** Base directory for clip paths. */
  baseDir?: string;
  loadClip?: (path: string) => DecodedWav;
  /** Runs on each track after gain/pan/cuts, before ducking and sends. Edit in place. */
  processTrack?: (track: Track, audio: Stereo, sampleRate: number) => void;
  /** Runs on the summed mix (after reverb/delay returns), before loudness match and limiting. */
  processMaster?: (mix: Stereo, sampleRate: number) => void;
}

export interface RenderResult {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  report: { duration: number; peakDb: number; loudnessDb: number; limiterDb: number };
}

/** The built-in lite instrument for a track. */
export function liteInstrument(track: Track): Instrument {
  const preset = INSTRUMENTS[track.instrument];
  if (!preset) throw new Error(`Track ${track.id}: unknown instrument "${track.instrument}". Known: ${Object.keys(INSTRUMENTS).join(', ')}`);
  if (preset.kind === 'drums') return { renderNote: (n, m, c) => renderDrumNote(n, m, { ...c, hue: track.hue, lightness: track.lightness }), tail: 0.5 };
  return { renderNote: (n, m, c) => renderSynthNote(preset, n, m, { ...c, hue: track.hue, lightness: track.lightness }), tail: preset.tail };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Linear resampling, good enough for clips that are already at a common rate. */
function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const n = Math.floor((x.length * to) / from);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = (i * from) / to;
    const j = Math.floor(p);
    const f = p - j;
    out[i] = x[j] * (1 - f) + (x[j + 1] ?? 0) * f;
  }
  return out;
}

/** Equal-power pan of a mono signal, or balance for a stereo one. */
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

function trackEnd(track: Track, inst: Instrument | undefined, clipLen: (src: string) => number): number {
  let end = 0;
  for (const n of track.notes) end = Math.max(end, n.t + n.duration + (inst?.tail ?? 0.5));
  for (const s of track.sfx) end = Math.max(end, s.t + (s.duration ?? SFX_DURATION[s.sfx]));
  for (const c of track.clips) end = Math.max(end, c.at + clipLen(c.src));
  return end;
}

/** Envelope follower, normalized so the source's loud passages read ~1. */
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

/** Gated RMS loudness in dBFS over 400 ms blocks (blocks under -50 dB ignored). */
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

export function render(score: Score, opts: RenderOptions = {}): RenderResult {
  const sr = score.sampleRate;
  const baseDir = opts.baseDir ?? process.cwd();
  const clipCache = new Map<string, Stereo>();
  const loadClip = (src: string): Stereo => {
    let c = clipCache.get(src);
    if (!c) {
      const wav = (opts.loadClip ?? ((p) => decodeWav(readFileSync(p))))(resolve(baseDir, src));
      const l = resample(wav.channels[0], wav.sampleRate, sr);
      c = [l, wav.channels[1] ? resample(wav.channels[1], wav.sampleRate, sr) : l];
      clipCache.set(src, c);
    }
    return c;
  };

  const instruments = score.tracks.map((t) => (t.notes.length ? (opts.instruments?.(t) ?? liteInstrument(t)) : undefined));
  const usesFx = score.tracks.some((t) => t.reverb > 0 || t.delay > 0);
  const end = Math.max(...score.tracks.map((t, i) => trackEnd(t, instruments[i], (s) => loadClip(s)[0].length / sr)));
  const duration = score.duration ?? end + (usesFx ? 1.5 : 0.1);
  const n = Math.ceil(duration * sr);

  // 1. Render every track to its own stereo buffer (pre-duck).
  const buses = score.tracks.map((track, ti): Stereo => {
    const buf: Stereo = [new Float32Array(n), new Float32Array(n)];
    const rand = rng(score.seed ^ hash(track.id));
    const inst = instruments[ti];
    for (const note of track.notes) {
      const audio = inst!.renderNote(note, toMidi(note.pitch), { sampleRate: sr, rand, track });
      addPanned(buf, audio, Math.round(note.t * sr), 0);
    }
    for (const e of track.sfx) addPanned(buf, renderSfx(e, sr, rand), Math.round(e.t * sr), 0);
    for (const clip of track.clips) {
      const [cl, cr] = loadClip(clip.src);
      const fi = clip.fadeIn * sr;
      const fo = clip.fadeOut * sr;
      const faded: Stereo = [cl.slice(), cr.slice()];
      for (let i = 0; i < cl.length; i++) {
        const g = Math.min(1, fi > 0 ? i / fi : 1, fo > 0 ? (cl.length - i) / fo : 1);
        faded[0][i] *= g;
        faded[1][i] *= g;
      }
      // Clips are already stereo; pan 0 here, track pan is applied below as balance.
      addPanned(buf, faded, Math.round(clip.at * sr), 0, dbToGain(clip.gain) / Math.SQRT2);
    }
    // Track EQ cuts, gain and pan.
    const g = dbToGain(track.gain);
    const a = ((track.pan + 1) * Math.PI) / 4;
    const gains = [Math.cos(a) * Math.SQRT2 * g, Math.sin(a) * Math.SQRT2 * g];
    for (let c = 0; c < 2; c++) {
      const hp = new OnePole(sr);
      const lp = new OnePole(sr);
      const x = buf[c];
      for (let i = 0; i < n; i++) {
        let v = x[i];
        if (track.lowCut) v = hp.high(v, track.lowCut);
        if (track.highCut) v = lp.low(v, track.highCut);
        x[i] = v * gains[c];
      }
    }
    opts.processTrack?.(track, buf, sr);
    return buf;
  });

  // 2. Ducking uses the pre-duck level of the source track.
  const envs = new Map<string, Float32Array>();
  score.tracks.forEach((track) => {
    if (!track.duck) return;
    const srcIndex = score.tracks.findIndex((t) => t.id === track.duck!.by);
    if (srcIndex < 0) return;
    const key = `${track.duck.by}:${track.duck.release}`;
    if (!envs.has(key)) envs.set(key, envelope(buses[srcIndex], sr, track.duck.release));
  });
  score.tracks.forEach((track, ti) => {
    if (!track.duck) return;
    const env = envs.get(`${track.duck.by}:${track.duck.release}`);
    if (!env) return;
    for (let i = 0; i < n; i++) {
      const g = 1 - track.duck.amount * env[i];
      buses[ti][0][i] *= g;
      buses[ti][1][i] *= g;
    }
  });

  // 3. Sum, with post-fader sends to the master reverb and delay.
  const mix: Stereo = [new Float32Array(n), new Float32Array(n)];
  const rvIn: Stereo = [new Float32Array(n), new Float32Array(n)];
  const dlIn: Stereo = [new Float32Array(n), new Float32Array(n)];
  score.tracks.forEach((track, ti) => {
    for (let c = 0; c < 2; c++) {
      const x = buses[ti][c];
      for (let i = 0; i < n; i++) {
        mix[c][i] += x[i];
        if (track.reverb) rvIn[c][i] += x[i] * track.reverb;
        if (track.delay) dlIn[c][i] += x[i] * track.delay;
      }
    }
  });
  const m = score.master;
  if (score.tracks.some((t) => t.delay > 0)) {
    const [dl, dr] = delay(dlIn[0], dlIn[1], m.delay.time, m.delay.feedback, sr);
    for (let i = 0; i < n; i++) {
      mix[0][i] += dl[i];
      mix[1][i] += dr[i];
      // Delay repeats also feed the reverb a little, so they sit in the same space.
      rvIn[0][i] += dl[i] * 0.3;
      rvIn[1][i] += dr[i] * 0.3;
    }
  }
  if (score.tracks.some((t) => t.reverb > 0)) {
    const [wl, wr] = reverb(rvIn[0], rvIn[1], m.reverb.size, m.reverb.damping, sr);
    for (let i = 0; i < n; i++) {
      mix[0][i] += wl[i];
      mix[1][i] += wr[i];
    }
  }

  opts.processMaster?.(mix, sr);

  // 4. Remove DC (asymmetric saturation leaves some), match loudness, then limit.
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
  const g = before > -120 ? dbToGain(m.loudness - before) : 1;
  for (let i = 0; i < n; i++) {
    mix[0][i] *= g;
    mix[1][i] *= g;
  }
  const limiterDb = limit(mix[0], mix[1], m.ceiling, sr);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(mix[0][i]), Math.abs(mix[1][i]));

  return {
    left: mix[0],
    right: mix[1],
    sampleRate: sr,
    report: { duration, peakDb: gainToDb(peak), loudnessDb: loudness(mix[0], mix[1], sr), limiterDb },
  };
}

/** Clip paths in a score file are relative to the file. */
export function baseDirOf(scorePath: string): string {
  return dirname(resolve(scorePath));
}
