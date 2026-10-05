import { Score } from './schema.js';
import {
  createTrackSampler,
  getTrackDuration,
  prepareTrackPoints,
} from './interpolator.js';
import { Voice, hashSeed, midiToFrequency } from './synth.js';
import { writeWavFile } from './wav.js';

export interface RenderResult {
  buffers: Float32Array[];
  sampleRate: number;
  duration: number;
  eventReport: {
    trackId: string;
    channel: number;
    samplesRendered: number;
    peakGain: number;
    rmsGain: number;
    onsets: number;
  }[];
  wav: Buffer;
}

export function render(score: Score): RenderResult {
  const sampleRate = score.sampleRate;

  let duration = score.duration;
  if (!duration) {
    duration = Math.max(...score.tracks.map((track) => getTrackDuration(track)), 0);
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    duration = 0;
  }

  const numSamples = Math.ceil(duration * sampleRate);

  const channelMap = new Map<number, Float32Array>();
  const maxChannel = Math.max(...score.tracks.map((t) => t.channel), 0);

  for (let ch = 0; ch <= maxChannel; ch++) {
    channelMap.set(ch, new Float32Array(numSamples));
  }

  const eventReport: RenderResult['eventReport'] = [];

  score.tracks.forEach((track, trackIndex) => {
    const points = prepareTrackPoints(track);
    const defaultLightness = track.lightness ?? 0.5;
    const sampler = createTrackSampler(points, defaultLightness);
    const voice = new Voice(sampleRate, track.hue, hashSeed(score.seed, trackIndex));
    const channelBuffer = channelMap.get(track.channel)!;

    let samplesRendered = 0;
    let sumSquares = 0;
    let peakGain = 0;
    let onsets = 0;
    let prevAudible = false;

    for (let i = 0; i < numSamples; i++) {
      const time = i / sampleRate;
      const sampled = sampler.sample(time);

      const audible = sampled !== null && sampled.size > 1e-6;
      if (audible && !prevAudible) {
        onsets++;
      }
      prevAudible = audible;

      let sample = 0;
      if (sampled) {
        sample = voice.processSample(sampled.y, sampled.size, sampled.lightness);
        samplesRendered++;
        sumSquares += sample * sample;
        peakGain = Math.max(peakGain, Math.abs(sample));
      } else {
        sample = voice.processSample(0, 0, defaultLightness);
      }

      channelBuffer[i] += sample;
    }

    const rmsGain = samplesRendered > 0 ? Math.sqrt(sumSquares / samplesRendered) : 0;

    eventReport.push({
      trackId: track.id,
      channel: track.channel,
      samplesRendered,
      peakGain,
      rmsGain,
      onsets,
    });
  });

  const buffers = Array.from(channelMap.values());

  for (const buffer of buffers) {
    let peak = 0;
    for (let i = 0; i < buffer.length; i++) {
      peak = Math.max(peak, Math.abs(buffer[i]));
    }

    if (peak > 1.0) {
      const scale = 0.95 / peak;
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] *= scale;
      }
    }
  }

  const wav = writeWavFile(buffers, sampleRate);

  return {
    buffers,
    sampleRate,
    duration,
    eventReport,
    wav,
  };
}
