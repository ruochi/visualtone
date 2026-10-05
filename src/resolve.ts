import type { Score } from './schema.js';
import { resolveTrack, sampleAt, prepareTrackPoints } from './interpolator.js';
import { applyGroove } from './groove.js';

export interface ResolvedTrackCurve {
  trackId: string;
  samples: { t: number; y: number; size: number; lightness: number }[];
}

/** Dense curves per track (swing/humanize applied); ducking applied to size when duck is set. */
export function resolveScore(score: Score, rate = 200): ResolvedTrackCurve[] {
  const tracks = score.tracks.map((t, i) => applyGroove(score, t, i));
  const envelopes = new Map<string, Float32Array>();
  const duration = score.duration ?? Math.max(
    ...tracks.map((t) => {
      const pts = prepareTrackPoints(t);
      return pts.length ? Math.max(...pts.map((p) => p.t)) : 0;
    }),
    0,
  );
  const frames = Math.ceil(duration * rate);

  for (const track of tracks) {
    const points = prepareTrackPoints(track);
    const env = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const s = sampleAt(points, i / rate, track.lightness ?? 0.5);
      env[i] = s ? s.size : 0;
    }
    envelopes.set(track.id, env);
  }

  return tracks.map((track) => {
    const base = resolveTrack(track, rate);
    const duck = track.duck;
    if (!duck) return { trackId: track.id, samples: base };
    const src = envelopes.get(duck.by);
    if (!src) return { trackId: track.id, samples: base };
    const samples = base.map((s, i) => {
      const srcLevel = src[Math.min(i, src.length - 1)] ?? 0;
      const gain = 1 - Math.min(1, srcLevel * 4) * duck.amount;
      return { ...s, size: s.size * gain };
    });
    return { trackId: track.id, samples };
  });
}
