import type { Score, Track } from './schema.js';
import { applyGroove } from './groove.js';
import { getTrackDuration } from './interpolator.js';
import { keyframeAt } from './mix.js';
import { expandSfx } from './sfx.js';
import { hashSeed } from './timbre.js';
import { expandUnits } from './units.js';

type Master = Score['master'];

export interface MixSegment {
  score: Score;
  /** Seconds on the outer timeline. */
  at: number;
  fadeIn?: number;
  fadeOut?: number;
  /** Prepended to every track id in this segment. */
  prefix?: string;
}

export interface MixResult {
  score: Score;
  warnings: string[];
}

function shiftKeys(keys: { t: number; v: number }[] | undefined, dt: number) {
  return keys?.map((k) => ({ ...k, t: k.t + dt }));
}

function shiftTrack(track: Track, dt: number): Track {
  if (!dt) return { ...track, offset: undefined };
  return {
    ...track,
    offset: undefined,
    points: track.points?.map((p) => ({ ...p, t: p.t + dt })),
    notes: track.notes?.map((n) => ({ ...n, t: n.t + dt })),
    clips: track.clips?.map((c) => ({ ...c, at: c.at + dt })),
    clip: track.clip ? { ...track.clip, at: track.clip.at + dt } : undefined,
    automation: track.automation
      ? {
          lightness: shiftKeys(track.automation.lightness, dt),
          gain: shiftKeys(track.automation.gain, dt),
          pan: shiftKeys(track.automation.pan, dt),
        }
      : undefined,
  };
}

/** Beats become Hz so a later time shift does not retune the LFO to a different bpm. */
function freezeLfo(track: Track, bpm: number | undefined): Track {
  if (!track.lfo?.length) return track;
  const beatSec = 60 / (bpm ?? 120);
  return {
    ...track,
    lfo: track.lfo.map((l) => {
      if (l.rate !== undefined || l.beats === undefined) return l;
      return { ...l, rate: 1 / (l.beats * beatSec), beats: undefined };
    }),
  };
}

function applySegmentFade(track: Track, t0: number, t1: number, fadeIn: number, fadeOut: number): Track {
  if (fadeIn <= 0 && fadeOut <= 0) return track;
  const existing = track.automation?.gain;
  const times = new Set<number>([t0, t1]);
  if (fadeIn > 0) times.add(t0 + fadeIn);
  if (fadeOut > 0) times.add(Math.max(t0, t1 - fadeOut));
  for (const k of existing ?? []) times.add(k.t);
  const gain = [...times]
    .sort((a, b) => a - b)
    .map((t) => {
      let env = 1;
      if (fadeIn > 0 && t < t0 + fadeIn) env *= Math.max(0, (t - t0) / fadeIn);
      if (fadeOut > 0 && t > t1 - fadeOut) env *= Math.max(0, (t1 - t) / Math.max(1e-6, fadeOut));
      const base = existing?.length ? keyframeAt(existing, t) : 1;
      return { t, v: base * env };
    });
  return { ...track, automation: { ...track.automation, gain } };
}

function segmentDuration(score: Score): number {
  if (score.duration && score.duration > 0) return score.duration;
  return Math.max(0, ...score.tracks.map((t, i) => getTrackDuration(applyGroove(score, t, i))));
}

/**
 * Place each score on the outer timeline. Groove is applied in the segment's own
 * time before the shift, so swing stays on the segment grid.
 * A segment's master is ignored; pass the outer master as the second argument.
 */
export function mix(segments: MixSegment[], master?: Master): MixResult {
  const warnings: string[] = [];
  const tracks: Track[] = [];
  let sampleRate = segments[0]?.score.sampleRate ?? 48000;
  let seed = segments[0]?.score.seed;
  let bpm = segments[0]?.score.bpm;
  let meter = segments[0]?.score.meter;
  let end = 0;

  segments.forEach((seg, segIndex) => {
    if (seg.score.master) {
      warnings.push(`第 ${segIndex + 1} 段自带 master，已忽略，总线以外层为准`);
    }
    if (seg.score.sampleRate && seg.score.sampleRate !== sampleRate) {
      throw new Error(`分段采样率不一致：${sampleRate} 与 ${seg.score.sampleRate}`);
    }
    const prepared = expandSfx(expandUnits(seg.score));
    const localDur = segmentDuration(prepared);
    const prefix = seg.prefix ?? '';
    const ids = new Map(prepared.tracks.map((t) => [t.id, `${prefix}${t.id}`]));
    prepared.tracks.forEach((track, trackIndex) => {
      const grooved = applyGroove(prepared, track, trackIndex);
      const frozen = freezeLfo(grooved, prepared.bpm);
      const shifted = shiftTrack(frozen, seg.at + (frozen.offset ?? 0));
      const faded = applySegmentFade(shifted, seg.at, seg.at + localDur, seg.fadeIn ?? 0, seg.fadeOut ?? 0);
      const id = ids.get(track.id) ?? `${prefix}${track.id}`;
      const duck = faded.duck
        ? { ...faded.duck, by: ids.get(faded.duck.by) ?? `${prefix}${faded.duck.by}` }
        : undefined;
      tracks.push({
        ...faded,
        id,
        duck,
        swing: undefined,
        humanize: undefined,
        seed: track.seed ?? hashSeed(prepared.seed, trackIndex),
      });
    });
    end = Math.max(end, seg.at + localDur);
    if (segIndex === 0) {
      seed = prepared.seed;
      bpm = prepared.bpm;
      meter = prepared.meter;
      sampleRate = prepared.sampleRate;
    }
  });

  const seen = new Set<string>();
  for (const t of tracks) {
    if (seen.has(t.id)) throw new Error(`合并后轨道 id 重复：${t.id}。给分段加 prefix`);
    seen.add(t.id);
  }

  const score: Score = {
    sampleRate,
    duration: end > 0 ? end : undefined,
    seed,
    bpm,
    meter,
    master: master as Score['master'],
    tracks,
  };
  return { score, warnings };
}
