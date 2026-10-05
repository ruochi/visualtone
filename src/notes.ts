import type { Note, Point } from './schema.js';

const HOLD_TAIL = 0.02;

/** Expand note shorthand into explicit curve points (deterministic). */
export function expandNotes(notes: Note[]): Point[] {
  const out: Point[] = [];
  for (const n of notes) {
    const L = n.lightness;
    const ease = n.ease ?? 'hold';
    if (ease === 'exp') {
      out.push({
        t: n.t,
        y: n.y,
        size: n.size,
        lightness: L,
        ease: 'step',
      });
      out.push({
        t: n.t + n.duration,
        y: n.y,
        size: 0,
        lightness: L,
        ease: 'exp',
      });
    } else {
      const end = n.t + n.duration;
      const sustainEnd = Math.max(n.t, end - HOLD_TAIL);
      out.push({
        t: n.t,
        y: n.y,
        size: n.size,
        lightness: L,
        ease: 'step',
      });
      if (sustainEnd > n.t) {
        out.push({
          t: sustainEnd,
          y: n.y,
          size: n.size,
          lightness: L,
        });
      }
      out.push({
        t: end,
        y: n.y,
        size: 0,
        lightness: L,
        ease: 'linear',
      });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
