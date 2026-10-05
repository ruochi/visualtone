import type { Note, Point, Score, Track } from './schema.js';
import { mulberry32 } from './synth.js';
import { hashSeed } from './timbre.js';

/**
 * Warp time so every second grid step is pushed late.
 * amount 0 = straight, 1 = full triplet swing (off-step lands at 2/3 of the pair).
 */
export function swingTime(t: number, bpm: number, amount: number, grid = 16): number {
  if (amount <= 0 || t <= 0) return t;
  const step = (60 / bpm) * (4 / grid);
  const pair = step * 2;
  const k = Math.floor(t / pair);
  const frac = (t - k * pair) / pair;
  const s = 0.5 + Math.min(1, amount) / 6;
  const warped = frac < 0.5 ? frac * (s / 0.5) : s + (frac - 0.5) * ((1 - s) / 0.5);
  return (k + warped) * pair;
}

/** Apply score/track swing and per-note humanize; returns a new track (input untouched). */
export function applyGroove(score: Score, track: Track, trackIndex: number): Track {
  const amount = track.swing ?? score.swing ?? 0;
  const swingOn = amount > 0 && !!score.bpm;
  const human = track.humanize;
  const humanOn = !!human && ((human.timeMs ?? 0) > 0 || (human.size ?? 0) > 0);
  if (!swingOn && !humanOn) return track;

  const grid = score.swingGrid ?? 16;
  const warp = (t: number) => (swingOn ? swingTime(t, score.bpm!, amount, grid) : t);
  const rng = mulberry32(hashSeed(score.seed, trackIndex) ^ 0x68756d61);

  let notes: Note[] | undefined;
  if (track.notes) {
    notes = [...track.notes]
      .sort((a, b) => a.t - b.t)
      .map((n) => {
        let start = warp(n.t);
        let end = warp(n.t + n.duration);
        let size = n.size;
        if (humanOn) {
          const jitter = ((rng() * 2 - 1) * (human!.timeMs ?? 0)) / 1000;
          start = Math.max(0, start + jitter);
          end = Math.max(start + 0.005, end + jitter);
          size = Math.min(1, Math.max(0, size * (1 + (rng() * 2 - 1) * (human!.size ?? 0))));
        }
        return { ...n, t: start, duration: end - start, size };
      });
    for (let i = 0; i < notes.length - 1; i++) {
      const next = notes[i + 1].t;
      if (notes[i].t + notes[i].duration > next) {
        notes[i] = { ...notes[i], duration: Math.max(0.005, next - notes[i].t) };
      }
    }
  }

  const points: Point[] | undefined = track.points?.map((p) => ({ ...p, t: warp(p.t) }));
  return { ...track, notes, points };
}
