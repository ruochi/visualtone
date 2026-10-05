import { Score, Track, getChannelIndices } from './schema.js';
import {
  createTrackSampler,
  getTrackDuration,
  prepareTrackPoints,
} from './interpolator.js';
import { Voice, hashSeed } from './synth.js';
import {
  Ducker,
  Freeverb,
  StereoDelay,
  softClip,
  peakLimit,
  applyLoudnessMatch,
  measureRmsDb,
  spectralCentroid,
} from './fx.js';
import { writeWavFile } from './wav.js';

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
  }[];
  master: {
    peak: number;
    loudnessDb: number;
  };
  wav: Buffer;
}

interface TrackRender {
  id: string;
  l: Float32Array;
  r: Float32Array;
  envelope: Float32Array;
  track: Track;
  onsets: number;
  samplesRendered: number;
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
  const points = prepareTrackPoints(track);
  const defaultLightness = track.lightness ?? 0.5;
  const sampler = createTrackSampler(points, defaultLightness);
  const voice = new Voice(
    sampleRate,
    track.hue,
    hashSeed(score.seed, trackIndex),
    defaultLightness,
    track.saturation ?? 1,
    track.timbre,
  );

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
      [sl, sr] = voice.processSample(sampled.y, sampled.size, sampled.lightness);
      samplesRendered++;
    } else {
      voice.processSample(0, 0, defaultLightness);
    }
    l[i] = sl;
    r[i] = sr;
    envelope[i] = Math.max(Math.abs(sl), Math.abs(sr));
  }

  return { id: track.id, l, r, envelope, track, onsets, samplesRendered };
}

export function render(score: Score): RenderResult {
  const sampleRate = score.sampleRate;
  let duration = score.duration;
  if (!duration) {
    duration = Math.max(...score.tracks.map((track) => getTrackDuration(track)), 0);
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

  const reverb = new Freeverb(sampleRate);
  reverb.setParams(revCfg.size, revCfg.decay);
  const delay = new StereoDelay(sampleRate, score.bpm, dlyCfg.beats / 4);
  delay.setFeedback(dlyCfg.feedback);

  const revL = new Float32Array(numSamples);
  const revR = new Float32Array(numSamples);
  const dlyL = new Float32Array(numSamples);
  const dlyR = new Float32Array(numSamples);

  for (const tr of rendered) {
    const chs = getChannelIndices(tr.track.channel);
    const space = tr.track.space ?? 0;
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
        const send = (sl + sr) * 0.5 * space;
        const [rl, rr] = reverb.processStereo(send, send);
        revL[i] += rl;
        revR[i] += rr;
      }
      if (echo > 0) {
        const send = (sl + sr) * 0.5 * echo;
        const [dl, dr] = delay.process(send, send);
        dlyL[i] += dl;
        dlyR[i] += dr;
      }
    }
  }

  const buffers: Float32Array[] = [];
  if (maxCh >= 1 && channelBuffers.has(1)) {
    buffers.push(channelBuffers.get(0)!);
    buffers.push(channelBuffers.get(1)!);
    for (let i = 0; i < numSamples; i++) {
      buffers[0][i] += revL[i] + dlyL[i];
      buffers[1][i] += revR[i] + dlyR[i];
    }
  } else {
    const mono = channelBuffers.get(0)!;
    for (let i = 0; i < numSamples; i++) {
      mono[i] += revL[i] + revR[i] + dlyL[i] + dlyR[i];
    }
    buffers.push(mono);
  }

  const drive = masterCfg.drive ?? 0.15;
  for (const b of buffers) {
    for (let i = 0; i < b.length; i++) b[i] = softClip(b[i], drive);
  }

  applyLoudnessMatch(buffers, masterCfg.loudness ?? -14);
  for (const b of buffers) peakLimit(b, 0.891);

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
    };
  });

  const wav = writeWavFile(buffers, sampleRate);

  return {
    buffers,
    sampleRate,
    duration,
    eventReport,
    master: { peak: masterPeak, loudnessDb },
    wav,
  };
}
