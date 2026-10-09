import { measureLoudness } from './analysis/loudness.js';
import { acousticTailSec, createEngine, isAcousticEngine, type Engine } from './engines/acoustic.js';
import {
  Ducker,
  FdnReverb,
  StereoDelay,
  softClip,
  saturate,
  lookaheadLimit,
  applyLoudnessMatch,
  measureRmsDb,
  spectralCentroid,
} from './fx.js';
import { applyGroove } from './groove.js';
import { createTrackSampler, getTrackDuration, prepareTrackPoints } from './interpolator.js';
import { BandDuck, Biquad, Chorus, Compressor, StereoEq, keyframeAt, lfoValue } from './mix.js';
import { expandNotes } from './notes.js';
import { resampleChannels } from './resample.js';
import { type Score, type Track, getChannelIndices, trackClips, type Clip } from './schema.js';
import { expandSfx } from './sfx.js';
import { Voice, hashSeed } from './synth.js';
import { expandUnits } from './units.js';
import { writeWavFile, type WavOptions } from './wav.js';

export interface ClipAudio {
  sampleRate: number;
  buffers: Float32Array[];
  /** sha256 of the file bytes. Recorded on the render so a later render can be checked. */
  sha256?: string;
}

export interface RenderResult {
  buffers: Float32Array[];
  sampleRate: number;
  duration: number;
  eventReport: {
    trackId: string;
    channels: number[];
    samplesRendered: number;
    peakGain: number;
    rmsGain: number;
    onsets: number;
    spectralCentroid: number;
    /** Deepest compressor gain reduction (dB, positive); 0 without comp. */
    gainReductionDb: number;
  }[];
  master: {
    peak: number;
    /** RMS dBFS of the left bus. When `master.lufs` is set, this is the measured integrated LUFS. */
    loudnessDb: number;
    gainReductionDb: number;
    /** Deepest lookahead-limiter gain reduction (dB, positive). */
    limiterReductionDb: number;
  };
  wav: Buffer;
  /**
   * Per-track audio after EQ, compression, modulation and ducking,
   * before reverb and delay sends. Present only when `stems: true`.
   * Arrays are the renderer's own buffers; do not mutate them.
   */
  stems?: { id: string; l: Float32Array; r: Float32Array }[];
  /** External audio that was mixed in. */
  inputs?: { src: string; sha256: string; sampleRate: number; channels: number; frames: number }[];
  /**
   * Frame 0 covers [0, 1/fps). `level` is RMS after the channel strip and ducking,
   * before reverb sends. `master.level` is after the limiter.
   */
  envelopes?: {
    fps: number;
    tracks: Record<string, { onsets: number[]; level: Float32Array }>;
    master: { level: Float32Array };
  };
}

interface TrackRender {
  id: string;
  l: Float32Array;
  r: Float32Array;
  envelope: Float32Array;
  track: Track;
  onsets: number;
  onsetTimes: number[];
  samplesRendered: number;
  gainReductionDb: number;
}

export interface RenderOptions {
  wav?: WavOptions;
  /** Keep per-track buffers (post channel-strip, pre send) for analysis. */
  stems?: boolean;
  /** Decoded audio keyed by the `src` string written in the score. */
  clips?: Record<string, ClipAudio>;
  envelopes?: { fps: number };
}

function sortTracksForDuck(tracks: Track[]): Track[] {
  const sorted: Track[] = [];
  const done = new Set<string>();
  const visit = (t: Track) => {
    if (done.has(t.id)) return;
    if (t.duck?.by) {
      const src = tracks.find((x) => x.id === t.duck!.by);
      if (src) visit(src);
    }
    done.add(t.id);
    sorted.push(t);
  };
  for (const t of tracks) visit(t);
  return sorted;
}

function shiftTrack(track: Track, dt: number): Track {
  if (!dt) return track;
  const shiftKeys = (keys?: { t: number; v: number }[]) => keys?.map((k) => ({ ...k, t: k.t + dt }));
  return {
    ...track,
    offset: undefined,
    points: track.points?.map((p) => ({ ...p, t: p.t + dt })),
    notes: track.notes?.map((n) => ({ ...n, t: n.t + dt })),
    clips: track.clips?.map((c) => ({ ...c, at: c.at + dt })),
    clip: track.clip ? { ...track.clip, at: track.clip.at + dt } : undefined,
    automation: track.automation
      ? {
          lightness: shiftKeys(track.automation.lightness),
          gain: shiftKeys(track.automation.gain),
          pan: shiftKeys(track.automation.pan),
        }
      : undefined,
  };
}

function prepareScore(score: Score): Score {
  return expandSfx(expandUnits(score));
}

function clipLengthSec(clip: Clip, audio: ClipAudio | undefined): number {
  const srcDur = audio ? audio.buffers[0].length / audio.sampleRate : 0;
  const t0 = clip.trim?.[0] ?? 0;
  const t1 = clip.trim?.[1] ?? (srcDur > 0 ? srcDur : t0);
  return Math.max(0, t1 - t0);
}

function inferDuration(score: Score, clips: RenderOptions['clips']): number {
  if (score.duration && score.duration > 0) return score.duration;
  let duration = 0;
  score.tracks.forEach((track, i) => {
    const grooved = applyGroove(score, track, i);
    const off = track.offset ?? 0;
    duration = Math.max(duration, getTrackDuration(grooved) + off);
    for (const c of trackClips(grooved)) {
      duration = Math.max(duration, c.at + off + clipLengthSec(c, clips?.[c.src]));
    }
  });
  return duration;
}

function placeClips(
  clips: Clip[],
  audioOf: (src: string) => ClipAudio,
  sampleRate: number,
  numSamples: number,
): { l: Float32Array; r: Float32Array; onsets: number[] } {
  const l = new Float32Array(numSamples);
  const r = new Float32Array(numSamples);
  const onsets: number[] = [];
  for (const clip of clips) {
    const audio = audioOf(clip.src);
    const channels = resampleChannels(audio.buffers, audio.sampleRate, sampleRate);
    const srcDur = audio.buffers[0].length / audio.sampleRate;
    const t0 = clip.trim?.[0] ?? 0;
    const t1 = clip.trim?.[1] ?? srcDur;
    const i0 = Math.max(0, Math.floor(t0 * sampleRate));
    const i1 = Math.min(channels[0].length, Math.ceil(t1 * sampleRate));
    const start = Math.floor(clip.at * sampleRate);
    const span = Math.max(0, i1 - i0);
    const fadeInN = Math.floor((clip.fadeIn ?? 0) * sampleRate);
    const fadeOutN = Math.floor((clip.fadeOut ?? 0) * sampleRate);
    const gain = clip.gain ?? 1;
    if (gain > 0 && span > 0) onsets.push(clip.at);
    for (let s = 0; s < span; s++) {
      const dest = start + s;
      if (dest < 0 || dest >= numSamples) continue;
      let g = gain;
      if (fadeInN > 0 && s < fadeInN) g *= s / fadeInN;
      if (fadeOutN > 0 && span - s < fadeOutN) g *= Math.max(0, (span - s) / fadeOutN);
      const sl = channels[0][i0 + s] * g;
      const sr = (channels[1] ? channels[1][i0 + s] : channels[0][i0 + s]) * g;
      l[dest] += sl;
      r[dest] += sr;
    }
  }
  return { l, r, onsets };
}

function activityBounds(
  track: Track,
  points: { t: number; size: number }[],
  sampleRate: number,
  numSamples: number,
  clips: Clip[],
  clipAudio: RenderOptions['clips'],
): [number, number] {
  if (track.chorus) return [0, numSamples];
  let t0 = Infinity;
  let t1 = 0;
  let any = false;
  for (const p of points) {
    any = true;
    t0 = Math.min(t0, p.t);
    t1 = Math.max(t1, p.t);
  }
  for (const n of track.notes ?? []) {
    any = true;
    t0 = Math.min(t0, n.t);
    t1 = Math.max(t1, n.t + n.duration);
  }
  for (const c of clips) {
    any = true;
    t0 = Math.min(t0, c.at);
    t1 = Math.max(t1, c.at + clipLengthSec(c, clipAudio?.[c.src]));
  }
  if (!any || !Number.isFinite(t0)) return [0, 0];
  // The window has to include the tail, or a held note is cut while it is still loud.
  // A release shape follows pitch and loudness, so the window uses that preset's longest tail.
  const releaseSec = acousticTailSec(track.engine, track.hue, track.notes, track.release);
  const start = Math.max(0, Math.floor(t0 * sampleRate) - 1);
  const end = Math.min(numSamples, Math.ceil((t1 + releaseSec + 0.05) * sampleRate));
  return [start, Math.max(start, end)];
}

function renderTrackDry(
  score: Score,
  track: Track,
  trackIndex: number,
  numSamples: number,
  sampleRate: number,
  clipAudio: RenderOptions['clips'],
): TrackRender {
  const offset = track.offset ?? 0;
  const grooved = applyGroove(score, track, trackIndex);
  const placed = shiftTrack(grooved, offset);
  const points = prepareTrackPoints(placed);
  const clips = trackClips(placed);
  const defaultLightness = placed.lightness ?? 0.5;
  const [start, end] = activityBounds(placed, points, sampleRate, numSamples, clips, clipAudio);

  const eq = placed.eq ? new StereoEq(sampleRate, placed.eq) : null;
  const comp = placed.comp ? new Compressor(sampleRate, placed.comp) : null;
  const beatSec = 60 / (score.bpm ?? 120);
  const lfos = (placed.lfo ?? []).map((l) => ({
    ...l,
    hz: l.rate ?? 1 / ((l.beats ?? 1) * beatSec),
  }));
  const lfoSum = (target: string, time: number) => {
    let v = 0;
    for (const l of lfos) if (l.target === target) v += l.depth * lfoValue(l.shape, (l.phase ?? 0) + l.hz * time);
    return v;
  };
  const hasLfo = (target: string) => lfos.some((l) => l.target === target);
  const lfoPitch = hasLfo('pitch');
  const lfoLight = hasLfo('lightness');
  const lfoGain = lfos.filter((l) => l.target === 'gain');
  const lfoPan = hasLfo('pan');
  const autoLight = placed.automation?.lightness ? [...placed.automation.lightness].sort((a, b) => a.t - b.t) : null;
  const autoGain = placed.automation?.gain ? [...placed.automation.gain].sort((a, b) => a.t - b.t) : null;
  const autoPan = placed.automation?.pan ? [...placed.automation.pan].sort((a, b) => a.t - b.t) : null;
  const chorus = placed.chorus ? new Chorus(sampleRate, placed.chorus) : null;
  const staticPan = placed.pan ?? 0;
  const wantPan = staticPan !== 0 || lfoPan || !!autoPan;

  const voiceSeed = placed.seed ?? hashSeed(score.seed, trackIndex);
  const sampler = createTrackSampler(points, defaultLightness);
  let voice: Voice | null = null;
  let poly: { sampler: ReturnType<typeof createTrackSampler>; eng: Engine }[] | null = null;

  if (isAcousticEngine(placed.engine) && ((placed.notes?.length ?? 0) > 0 || (placed.points?.length ?? 0) > 0)) {
    const engineName = placed.engine;
    poly = (placed.notes ?? []).map((n, i) => {
      const eng = createEngine(engineName, sampleRate, placed.hue ?? 110, voiceSeed + i + 1);
      eng.setRelease(placed.release ?? 180);
      return { sampler: createTrackSampler(expandNotes([n]), defaultLightness), eng };
    });
    if ((placed.points?.length ?? 0) > 0) {
      const eng = createEngine(engineName, sampleRate, placed.hue ?? 110, voiceSeed);
      eng.setRelease(placed.release ?? 180);
      poly.push({ sampler: createTrackSampler(placed.points ?? [], defaultLightness), eng });
    }
  } else if (points.length > 0 || !clips.length) {
    voice = new Voice(sampleRate, placed.hue ?? 180, voiceSeed, defaultLightness, placed.saturation ?? 1, placed.timbre);
    voice.setRelease(placed.release ?? 0);
  }

  const clipBuf = clips.length
    ? placeClips(clips, (src) => {
        const audio = clipAudio?.[src];
        if (!audio) throw new Error(`缺少音频 "${src}"。把解码后的 WAV 放进 render 的 clips，键名与 src 一致`);
        return audio;
      }, sampleRate, numSamples)
    : null;

  const l = new Float32Array(numSamples);
  const r = new Float32Array(numSamples);
  const envelope = new Float32Array(numSamples);
  const onsetTimes: number[] = clipBuf ? [...clipBuf.onsets] : [];
  let onsets = onsetTimes.length;
  let samplesRendered = 0;
  let prevAudible = false;

  for (let i = start; i < end; i++) {
    const time = i / sampleRate;
    const sampled = voice ? sampler.sample(time) : null;
    const audible = sampled !== null && sampled.size > 1e-6;
    if (voice && audible && !prevAudible) {
      onsets++;
      onsetTimes.push(time);
    }
    if (voice) prevAudible = audible;

    let sl = clipBuf ? clipBuf.l[i] : 0;
    let sr = clipBuf ? clipBuf.r[i] : 0;
    if (sl !== 0 || sr !== 0) samplesRendered++;
    if (poly) {
      for (const v of poly) {
        const s = v.sampler.sample(time);
        const [a, b] = v.eng.processSample(s?.y ?? 0, s?.size ?? 0, s ? Math.min(1, Math.max(0, s.lightness)) : defaultLightness);
        sl += a;
        sr += b;
        if (s && s.size > 1e-6) samplesRendered++;
      }
    } else if (voice) {
      if (sampled) {
        let y = sampled.y;
        let light = sampled.lightness;
        if (lfoPitch) y += lfoSum('pitch', time);
        if (lfoLight) light += lfoSum('lightness', time);
        if (autoLight) light += keyframeAt(autoLight, time);
        const [a, b] = voice.processSample(y, sampled.size, Math.min(1, Math.max(0, light)));
        sl += a;
        sr += b;
        samplesRendered++;
      } else {
        const [a, b] = voice.processSample(0, 0, defaultLightness);
        sl += a;
        sr += b;
      }
    }
    if (eq) [sl, sr] = eq.process(sl, sr);
    if (comp) [sl, sr] = comp.process(sl, sr);
    if (chorus) [sl, sr] = chorus.process(sl, sr);
    let g = 1;
    for (const lg of lfoGain) {
      const w = lfoValue(lg.shape, (lg.phase ?? 0) + lg.hz * time);
      g *= 1 - Math.min(1, Math.max(0, lg.depth)) * (0.5 - 0.5 * w);
    }
    if (autoGain) g *= Math.max(0, keyframeAt(autoGain, time));
    if (g !== 1) {
      sl *= g;
      sr *= g;
    }
    if (wantPan) {
      let p = staticPan;
      if (lfoPan) p += lfoSum('pan', time);
      if (autoPan) p += keyframeAt(autoPan, time);
      p = Math.min(1, Math.max(-1, p));
      const angle = (p + 1) * 0.25 * Math.PI;
      sl *= Math.cos(angle) * Math.SQRT2;
      sr *= Math.sin(angle) * Math.SQRT2;
    }
    l[i] = sl;
    r[i] = sr;
    envelope[i] = Math.max(Math.abs(sl), Math.abs(sr));
  }

  if (poly && placed.notes) {
    for (const n of placed.notes) {
      if (n.size > 1e-6) onsetTimes.push(n.t);
    }
    onsetTimes.sort((a, b) => a - b);
    onsets = onsetTimes.length;
  }

  return {
    id: placed.id,
    l,
    r,
    envelope,
    track: placed,
    onsets,
    onsetTimes,
    samplesRendered,
    gainReductionDb: comp?.maxReductionDb ?? 0,
  };
}

function frameLevel(buffers: Float32Array[], sampleRate: number, fps: number, numSamples: number): Float32Array {
  const frames = Math.ceil((numSamples / sampleRate) * fps);
  const level = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const a = Math.min(numSamples, Math.floor((f / fps) * sampleRate));
    const b = Math.min(numSamples, Math.floor(((f + 1) / fps) * sampleRate));
    let sum = 0;
    let n = 0;
    for (let i = a; i < b; i++) {
      let m = 0;
      for (const buf of buffers) m = Math.max(m, Math.abs(buf[i]));
      sum += m * m;
      n++;
    }
    level[f] = n > 0 ? Math.sqrt(sum / n) : 0;
  }
  return level;
}

function applyLufsMatch(buffers: Float32Array[], sampleRate: number, target: number) {
  const measured = measureLoudness(buffers, sampleRate).integratedLufs;
  if (!Number.isFinite(measured)) return;
  const gain = Math.pow(10, (target - measured) / 20);
  if (!Number.isFinite(gain) || gain <= 0) return;
  const g = Math.min(gain, 1e4);
  for (const b of buffers) {
    for (let i = 0; i < b.length; i++) b[i] *= g;
  }
}

function matchLoudness(buffers: Float32Array[], sampleRate: number, master: { loudness?: number; lufs?: number }) {
  if (typeof master.lufs === 'number') applyLufsMatch(buffers, sampleRate, master.lufs);
  else applyLoudnessMatch(buffers, master.loudness ?? -14);
}

export function render(scoreIn: Score, options: RenderOptions = {}): RenderResult {
  const score = prepareScore(scoreIn);
  const sampleRate = score.sampleRate;
  let duration = inferDuration(score, options.clips);
  if (!Number.isFinite(duration) || duration <= 0) duration = 0;

  const numSamples = Math.ceil(duration * sampleRate);
  const masterCfg = score.master ?? { loudness: -14, drive: 0.15 };
  const revCfg = masterCfg.reverb ?? { size: 0.6, decay: 0.5 };
  const dlyCfg = {
    beats: masterCfg.delay?.beats ?? 0.75,
    feedback: masterCfg.delay?.feedback ?? 0.35,
  };

  const inputs: NonNullable<RenderResult['inputs']> = [];
  const seenSrc = new Set<string>();
  for (const t of score.tracks) {
    for (const c of trackClips(t)) {
      if (seenSrc.has(c.src)) continue;
      seenSrc.add(c.src);
      const audio = options.clips?.[c.src];
      if (!audio) throw new Error(`缺少音频 "${c.src}"。把解码后的 WAV 放进 render 的 clips，键名与 src 一致`);
      inputs.push({
        src: c.src,
        sha256: audio.sha256 ?? '',
        sampleRate: audio.sampleRate,
        channels: audio.buffers.length,
        frames: audio.buffers[0]?.length ?? 0,
      });
    }
  }

  let maxCh = 0;
  let forceStereo = false;
  for (const t of score.tracks) {
    const chs = getChannelIndices(t.channel ?? 0);
    if (chs.length >= 2) forceStereo = true;
    for (const ch of chs) maxCh = Math.max(maxCh, ch);
  }
  if (forceStereo) maxCh = Math.max(maxCh, 1);

  const order = sortTracksForDuck(score.tracks);
  const trackIndexMap = new Map(score.tracks.map((t, i) => [t.id, i]));

  const rendered: TrackRender[] = [];
  const byId = new Map<string, TrackRender>();

  for (const track of order) {
    const idx = trackIndexMap.get(track.id) ?? 0;
    const tr = renderTrackDry(score, track, idx, numSamples, sampleRate, options.clips);
    rendered.push(tr);
    byId.set(track.id, tr);
  }

  const duckers = new Map<string, Ducker>();
  const bands = new Map<string, BandDuck>();
  for (const t of score.tracks) {
    duckers.set(t.id, new Ducker(sampleRate, { holdMs: t.duck?.holdMs, releaseMs: t.duck?.releaseMs }));
    if (t.duck?.band) bands.set(t.id, new BandDuck(sampleRate, t.duck.band));
  }

  for (const tr of rendered) {
    const duck = tr.track.duck;
    if (!duck) continue;
    const src = byId.get(duck.by);
    if (!src) continue;
    const ducker = duckers.get(tr.id)!;
    const split = bands.get(tr.id);
    const amount = duck.amount ?? 0.6;
    for (let i = 0; i < numSamples; i++) {
      const g = ducker.process(Math.min(1, src.envelope[i] * 4), amount);
      if (split) {
        const [dl, dr] = split.process(tr.l[i], tr.r[i], g);
        tr.l[i] = dl;
        tr.r[i] = dr;
      } else {
        tr.l[i] *= g;
        tr.r[i] *= g;
      }
    }
  }

  const channelBuffers = new Map<number, Float32Array>();
  for (let ch = 0; ch <= maxCh; ch++) {
    channelBuffers.set(ch, new Float32Array(numSamples));
  }

  const revL = new Float32Array(numSamples);
  const revR = new Float32Array(numSamples);
  const roomL = new Float32Array(numSamples);
  const roomR = new Float32Array(numSamples);
  const dlyL = new Float32Array(numSamples);
  const dlyR = new Float32Array(numSamples);
  const hallInL = new Float32Array(numSamples);
  const hallInR = new Float32Array(numSamples);
  const roomInL = new Float32Array(numSamples);
  const roomInR = new Float32Array(numSamples);
  const dlyInL = new Float32Array(numSamples);
  const dlyInR = new Float32Array(numSamples);

  for (const tr of rendered) {
    const chs = getChannelIndices(tr.track.channel ?? 0);
    const space = tr.track.space ?? 0;
    const room = tr.track.room ?? 0;
    const echo = tr.track.echo ?? 0;
    for (let i = 0; i < numSamples; i++) {
      const sl = tr.l[i];
      const sr = tr.r[i];
      if (chs.length >= 2) {
        channelBuffers.get(chs[0])![i] += sl;
        channelBuffers.get(chs[1])![i] += sr;
      } else {
        const mono = (sl + sr) * 0.5;
        channelBuffers.get(chs[0])![i] += mono;
      }
      if (space > 0) {
        hallInL[i] += sl * space;
        hallInR[i] += sr * space;
      }
      if (room > 0) {
        roomInL[i] += sl * room;
        roomInR[i] += sr * room;
      }
      if (echo > 0) {
        dlyInL[i] += sl * echo;
        dlyInR[i] += sr * echo;
      }
    }
  }

  const hall = new FdnReverb(sampleRate, 'hall');
  hall.setParams(revCfg);
  const room = new FdnReverb(sampleRate, 'room');
  room.setParams(masterCfg.room ?? { size: 0.4, decay: 0.3, preDelayMs: 8, damping: 0.3, width: 0.6 });
  const delay = new StereoDelay(sampleRate, score.bpm, dlyCfg.beats / 4);
  delay.setFeedback(dlyCfg.feedback);
  // A long tail on bass notes turns into a low rumble under the whole mix.
  const hallHpL = new Biquad('highpass', sampleRate, 120);
  const hallHpR = new Biquad('highpass', sampleRate, 120);
  for (let i = 0; i < numSamples; i++) {
    const [hl, hr] = hall.processStereo(hallHpL.process(hallInL[i]), hallHpR.process(hallInR[i]));
    revL[i] = hl;
    revR[i] = hr;
    const [ml, mr] = room.processStereo(roomInL[i], roomInR[i]);
    roomL[i] = ml;
    roomR[i] = mr;
    const [dl, dr] = delay.process(dlyInL[i], dlyInR[i]);
    dlyL[i] = dl;
    dlyR[i] = dr;
  }

  const buffers: Float32Array[] = [];
  if (maxCh >= 1 && channelBuffers.has(1)) {
    buffers.push(channelBuffers.get(0)!);
    buffers.push(channelBuffers.get(1)!);
    for (let i = 0; i < numSamples; i++) {
      buffers[0][i] += revL[i] + roomL[i] + dlyL[i];
      buffers[1][i] += revR[i] + roomR[i] + dlyR[i];
    }
  } else {
    const mono = channelBuffers.get(0)!;
    for (let i = 0; i < numSamples; i++) {
      mono[i] += revL[i] + revR[i] + roomL[i] + roomR[i] + dlyL[i] + dlyR[i];
    }
    buffers.push(mono);
  }

  if (masterCfg.eq) {
    const busEq = new StereoEq(sampleRate, masterCfg.eq);
    const left = buffers[0];
    const right = buffers[1];
    for (let i = 0; i < numSamples; i++) {
      const [el, er] = busEq.process(left[i], right ? right[i] : left[i]);
      left[i] = el;
      if (right) right[i] = er;
    }
  }

  const satAmount = masterCfg.saturation ?? 0;
  if (satAmount > 0 && buffers[0]) {
    let prevL = 0;
    let outL = 0;
    let prevR = 0;
    let outR = 0;
    const left = buffers[0];
    const right = buffers[1];
    for (let i = 0; i < numSamples; i++) {
      const sL = saturate(left[i], satAmount);
      outL = sL - prevL + 0.995 * outL;
      prevL = sL;
      left[i] = outL;
      if (right) {
        const sR = saturate(right[i], satAmount);
        outR = sR - prevR + 0.995 * outR;
        prevR = sR;
        right[i] = outR;
      }
    }
  }

  let masterReduction = 0;
  if (masterCfg.comp) {
    matchLoudness(buffers, sampleRate, masterCfg);
    const glue = new Compressor(sampleRate, masterCfg.comp);
    const left = buffers[0];
    const right = buffers[1] ?? buffers[0];
    for (let i = 0; i < numSamples; i++) {
      const [cl, cr] = glue.process(left[i], right[i]);
      left[i] = cl;
      if (buffers[1]) right[i] = cr;
    }
    masterReduction = glue.maxReductionDb;
  }

  const drive = masterCfg.drive ?? 0.15;
  for (const b of buffers) {
    for (let i = 0; i < b.length; i++) b[i] = softClip(b[i], drive);
  }

  let limiterReduction = 0;
  for (let pass = 0; pass < 2; pass++) {
    matchLoudness(buffers, sampleRate, masterCfg);
    limiterReduction = Math.max(limiterReduction, lookaheadLimit(buffers, sampleRate, masterCfg.limiter));
  }

  let masterPeak = 0;
  for (const b of buffers) {
    for (let i = 0; i < b.length; i++) masterPeak = Math.max(masterPeak, Math.abs(b[i]));
  }
  const loudnessDb =
    typeof masterCfg.lufs === 'number'
      ? measureLoudness(buffers, sampleRate).integratedLufs
      : measureRmsDb(buffers[0]);

  const eventReport: RenderResult['eventReport'] = rendered.map((tr) => {
    let peak = 0;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < numSamples; i++) {
      const v = Math.max(Math.abs(tr.l[i]), Math.abs(tr.r[i]));
      peak = Math.max(peak, v);
      sum += v * v;
      if (v > 1e-6) n++;
    }
    const mono = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) mono[i] = (tr.l[i] + tr.r[i]) * 0.5;
    return {
      trackId: tr.id,
      channels: getChannelIndices(tr.track.channel ?? 0),
      samplesRendered: tr.samplesRendered,
      peakGain: peak,
      rmsGain: n > 0 ? Math.sqrt(sum / n) : 0,
      onsets: tr.onsets,
      spectralCentroid: spectralCentroid(mono, sampleRate),
      gainReductionDb: tr.gainReductionDb,
    };
  });

  const wav = writeWavFile(buffers, sampleRate, { seed: score.seed, ...options.wav });

  let envelopes: RenderResult['envelopes'];
  if (options.envelopes) {
    const fps = options.envelopes.fps;
    if (!(fps > 0)) throw new Error('envelopes.fps 必须大于 0');
    const tracks: NonNullable<RenderResult['envelopes']>['tracks'] = {};
    for (const tr of rendered) {
      tracks[tr.id] = {
        onsets: tr.onsetTimes,
        level: frameLevel([tr.l, tr.r], sampleRate, fps, numSamples),
      };
    }
    envelopes = { fps, tracks, master: { level: frameLevel(buffers, sampleRate, fps, numSamples) } };
  }

  return {
    buffers,
    sampleRate,
    duration,
    eventReport,
    master: { peak: masterPeak, loudnessDb, gainReductionDb: masterReduction, limiterReductionDb: limiterReduction },
    wav,
    stems: options.stems
      ? [
          ...score.tracks.map((t) => {
            const tr = byId.get(t.id)!;
            return { id: tr.id, l: tr.l, r: tr.r };
          }),
          { id: 'bus:hall', l: revL, r: revR },
          { id: 'bus:room', l: roomL, r: roomR },
          { id: 'bus:delay', l: dlyL, r: dlyR },
        ]
      : undefined,
    inputs: inputs.length ? inputs : undefined,
    envelopes,
  };
}
