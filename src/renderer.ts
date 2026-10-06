import { Score, Track, getChannelIndices } from './schema.js';
import {
  createTrackSampler,
  getTrackDuration,
  prepareTrackPoints,
} from './interpolator.js';
import { Voice, hashSeed } from './synth.js';
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
import { Chorus, Compressor, StereoEq, keyframeAt, lfoValue } from './mix.js';
import { applyGroove } from './groove.js';
import { writeWavFile, type WavOptions } from './wav.js';

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
}

interface TrackRender {
  id: string;
  l: Float32Array;
  r: Float32Array;
  envelope: Float32Array;
  track: Track;
  onsets: number;
  samplesRendered: number;
  gainReductionDb: number;
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

function renderTrackDry(
  score: Score,
  track: Track,
  trackIndex: number,
  numSamples: number,
  sampleRate: number,
): TrackRender {
  let onsets = 0;
  let samplesRendered = 0;
  const points = prepareTrackPoints(applyGroove(score, track, trackIndex));
  const defaultLightness = track.lightness ?? 0.5;
  const eq = track.eq ? new StereoEq(sampleRate, track.eq) : null;
  const comp = track.comp ? new Compressor(sampleRate, track.comp) : null;
  const beatSec = 60 / (score.bpm ?? 120);
  const lfos = (track.lfo ?? []).map((l) => ({
    ...l,
    hz: l.rate ?? 1 / (l.beats! * beatSec),
  }));
  const lfoSum = (target: string, time: number) => {
    let v = 0;
    for (const l of lfos) if (l.target === target) v += l.depth * lfoValue(l.shape, l.phase + l.hz * time);
    return v;
  };
  const hasLfo = (target: string) => lfos.some((l) => l.target === target);
  const lfoPitch = hasLfo('pitch');
  const lfoLight = hasLfo('lightness');
  const lfoGain = lfos.filter((l) => l.target === 'gain');
  const lfoPan = hasLfo('pan');
  const autoLight = track.automation?.lightness ? [...track.automation.lightness].sort((a, b) => a.t - b.t) : null;
  const autoGain = track.automation?.gain ? [...track.automation.gain].sort((a, b) => a.t - b.t) : null;
  const chorus = track.chorus ? new Chorus(sampleRate, track.chorus) : null;
  const sampler = createTrackSampler(points, defaultLightness);
  const voice = new Voice(
    sampleRate,
    track.hue,
    hashSeed(score.seed, trackIndex),
    defaultLightness,
    track.saturation ?? 1,
    track.timbre,
  );
  voice.setRelease(track.release ?? 0);

  const l = new Float32Array(numSamples);
  const r = new Float32Array(numSamples);
  const envelope = new Float32Array(numSamples);

  let prevAudible = false;

  for (let i = 0; i < numSamples; i++) {
    const time = i / sampleRate;
    const sampled = sampler.sample(time);
    const audible = sampled !== null && sampled.size > 1e-6;
    if (audible && !prevAudible) onsets++;
    prevAudible = audible;

    let sl = 0;
    let sr = 0;
    if (sampled) {
      let y = sampled.y;
      let light = sampled.lightness;
      if (lfoPitch) y += lfoSum('pitch', time);
      if (lfoLight) light += lfoSum('lightness', time);
      if (autoLight) light += keyframeAt(autoLight, time);
      [sl, sr] = voice.processSample(y, sampled.size, Math.min(1, Math.max(0, light)));
      samplesRendered++;
    } else {
      [sl, sr] = voice.processSample(0, 0, defaultLightness);
    }
    if (eq) [sl, sr] = eq.process(sl, sr);
    if (comp) [sl, sr] = comp.process(sl, sr);
    if (chorus) [sl, sr] = chorus.process(sl, sr);
    // Gain/pan modulate after the voice so an LFO trough never re-triggers an onset.
    let g = 1;
    for (const lg of lfoGain) {
      const w = lfoValue(lg.shape, lg.phase + lg.hz * time);
      g *= 1 - Math.min(1, Math.max(0, lg.depth)) * (0.5 - 0.5 * w);
    }
    if (autoGain) g *= Math.max(0, keyframeAt(autoGain, time));
    if (g !== 1) {
      sl *= g;
      sr *= g;
    }
    if (lfoPan) {
      const p = Math.min(1, Math.max(-1, lfoSum('pan', time)));
      const angle = (p + 1) * 0.25 * Math.PI;
      sl *= Math.cos(angle) * Math.SQRT2;
      sr *= Math.sin(angle) * Math.SQRT2;
    }
    l[i] = sl;
    r[i] = sr;
    envelope[i] = Math.max(Math.abs(sl), Math.abs(sr));
  }

  return {
    id: track.id,
    l,
    r,
    envelope,
    track,
    onsets,
    samplesRendered,
    gainReductionDb: comp?.maxReductionDb ?? 0,
  };
}

export interface RenderOptions {
  wav?: WavOptions;
  /** Keep per-track buffers (post channel-strip, pre send) for analysis. */
  stems?: boolean;
}

export function render(score: Score, options: RenderOptions = {}): RenderResult {
  const sampleRate = score.sampleRate;
  let duration = score.duration;
  if (!duration) {
    duration = Math.max(
      ...score.tracks.map((track, i) => getTrackDuration(applyGroove(score, track, i))),
      0,
    );
  }
  if (!Number.isFinite(duration) || duration <= 0) duration = 0;

  const numSamples = Math.ceil(duration * sampleRate);
  const masterCfg = score.master ?? { loudness: -14, drive: 0.15 };
  const revCfg = masterCfg.reverb ?? { size: 0.6, decay: 0.5 };
  const dlyCfg = masterCfg.delay ?? { beats: 0.75, feedback: 0.35 };

  let maxCh = 0;
  let forceStereo = false;
  for (const t of score.tracks) {
    const chs = getChannelIndices(t.channel);
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
    const tr = renderTrackDry(score, track, idx, numSamples, sampleRate);
    rendered.push(tr);
    byId.set(track.id, tr);
  }

  const duckers = new Map<string, Ducker>();
  for (const t of score.tracks) duckers.set(t.id, new Ducker(sampleRate));

  for (const tr of rendered) {
    const duck = tr.track.duck;
    if (!duck) continue;
    const src = byId.get(duck.by);
    if (!src) continue;
    const ducker = duckers.get(tr.id)!;
    for (let i = 0; i < numSamples; i++) {
      const g = ducker.process(Math.min(1, src.envelope[i] * 4), duck.amount);
      tr.l[i] *= g;
      tr.r[i] *= g;
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
    const chs = getChannelIndices(tr.track.channel);
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
  for (let i = 0; i < numSamples; i++) {
    const [hl, hr] = hall.processStereo(hallInL[i], hallInR[i]);
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
    // Threshold is relative to the target loudness, so normalise before compressing.
    applyLoudnessMatch(buffers, masterCfg.loudness ?? -14);
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

  // Limiting lowers RMS a little, so match and limit twice to land near the target.
  let limiterReduction = 0;
  for (let pass = 0; pass < 2; pass++) {
    applyLoudnessMatch(buffers, masterCfg.loudness ?? -14);
    limiterReduction = Math.max(limiterReduction, lookaheadLimit(buffers, sampleRate, masterCfg.limiter));
  }

  let masterPeak = 0;
  for (const b of buffers) {
    for (let i = 0; i < b.length; i++) masterPeak = Math.max(masterPeak, Math.abs(b[i]));
  }
  const loudnessDb = measureRmsDb(buffers[0]);

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
      channels: getChannelIndices(tr.track.channel),
      samplesRendered: tr.samplesRendered,
      peakGain: peak,
      rmsGain: n > 0 ? Math.sqrt(sum / n) : 0,
      onsets: tr.onsets,
      spectralCentroid: spectralCentroid(mono, sampleRate),
      gainReductionDb: tr.gainReductionDb,
    };
  });

  const wav = writeWavFile(buffers, sampleRate, { seed: score.seed, ...options.wav });

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
  };
}
