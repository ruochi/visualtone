import type { Point, Track } from './schema.js';
import type { Ease } from './schema.js';
import { expandNotes } from './notes.js';

export interface SampledPoint {
  y: number;
  size: number;
  lightness: number;
}

export interface ResolvedSample {
  t: number;
  y: number;
  size: number;
  lightness: number;
}

const SILENCE_EPS = 1e-6;

export function sortPoints(points: Point[]): Point[] {
  return [...points].sort((a, b) => a.t - b.t);
}

function applyEase(ease: Ease, t: number): number {
  const x = Math.max(0, Math.min(1, t));
  switch (ease) {
    case 'step':
      return x >= 1 ? 1 : 0;
    case 'linear':
      return x;
    case 'in':
      return x * x;
    case 'out':
      return 1 - (1 - x) * (1 - x);
    case 'inOut':
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    case 'exp':
      if (x >= 1) return 1;
      return 1 - Math.exp(-6 * x);
    default:
      return x;
  }
}

function defaultEaseForSegment(p0: Point, p1: Point): { sizeEase: Ease; yEase: Ease } {
  const s0 = p0.size;
  const s1 = p1.size;
  if (s0 <= SILENCE_EPS && s1 > SILENCE_EPS) {
    return { sizeEase: 'step', yEase: 'step' };
  }
  if (s1 < s0 - SILENCE_EPS) {
    return { sizeEase: p1.ease ?? 'exp', yEase: p1.ease ?? 'linear' };
  }
  return { sizeEase: p1.ease ?? 'linear', yEase: p1.ease ?? 'linear' };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function interpolateSegment(
  p0: Point,
  p1: Point,
  time: number,
  defaultLightness: number,
): SampledPoint | null {
  if (time < p0.t || time > p1.t) {
    return null;
  }
  if (p0.size <= SILENCE_EPS && p1.size <= SILENCE_EPS) {
    return null;
  }

  const { sizeEase, yEase } = defaultEaseForSegment(p0, p1);
  const sizeE = p1.ease ?? sizeEase;
  const yE = p1.ease ?? yEase;

  const tween = p1.tween ?? p1.t - p0.t;
  const tweenStart = Math.max(p0.t, p1.t - tween);
  const span = p1.t - tweenStart;

  let frac = 1;
  if (span > 0 && time < p1.t) {
    if (time < tweenStart) {
      frac = 0;
    } else {
      frac = (time - tweenStart) / span;
    }
  } else if (time >= p1.t) {
    frac = 1;
  }

  const l0 = p0.lightness ?? defaultLightness;
  const l1 = p1.lightness ?? defaultLightness;

  const y = lerp(p0.y, p1.y, applyEase(yE, frac));
  const size = lerp(p0.size, p1.size, applyEase(sizeE, frac));
  const lightness = lerp(l0, l1, applyEase('linear', frac));

  if (size <= SILENCE_EPS) {
    return null;
  }
  return { y, size, lightness };
}

/** Sample track curve at an arbitrary time (for tests and resolveTrack). */
export function sampleAt(
  points: Point[],
  time: number,
  defaultLightness = 0.5,
): SampledPoint | null {
  if (points.length === 0) return null;
  const sorted = sortPoints(points);

  if (time < sorted[0].t) {
    return null;
  }

  if (sorted.length === 1) {
    const p = sorted[0];
    if (Math.abs(time - p.t) < 1e-9 && p.size > SILENCE_EPS) {
      return {
        y: p.y,
        size: p.size,
        lightness: p.lightness ?? defaultLightness,
      };
    }
    return null;
  }

  let i = 0;
  while (i < sorted.length - 1 && sorted[i + 1].t < time) {
    i++;
  }

  if (time > sorted[sorted.length - 1].t) {
    return null;
  }

  if (Math.abs(time - sorted[i].t) < 1e-9) {
    const p = sorted[i];
    if (p.size <= SILENCE_EPS) return null;
    return {
      y: p.y,
      size: p.size,
      lightness: p.lightness ?? defaultLightness,
    };
  }

  if (i < sorted.length - 1 && time <= sorted[i + 1].t) {
    return interpolateSegment(sorted[i], sorted[i + 1], time, defaultLightness);
  }

  const last = sorted[sorted.length - 1];
  if (last.size <= SILENCE_EPS) return null;
  return {
    y: last.y,
    size: last.size,
    lightness: last.lightness ?? defaultLightness,
  };
}

/** @deprecated Use sampleAt */
export function interpolateTrack(
  points: Point[],
  time: number,
  defaultLightness = 0.5,
): SampledPoint | null {
  return sampleAt(points, time, defaultLightness);
}

export function prepareTrackPoints(track: Track): Point[] {
  const fromNotes = track.notes ? expandNotes(track.notes) : [];
  const fromPoints = track.points ?? [];
  return sortPoints([...fromPoints, ...fromNotes]);
}

export function getTrackDurationFromPoints(points: Point[]): number {
  if (points.length === 0) return 0;
  return Math.max(...points.map((p) => p.t));
}

export function getTrackDuration(track: Track): number {
  return getTrackDurationFromPoints(prepareTrackPoints(track));
}

export interface TrackSampler {
  sample(time: number): SampledPoint | null;
}

/** Sequential sampler with cursor for O(1) amortized per-sample rendering. */
export function createTrackSampler(
  points: Point[],
  defaultLightness = 0.5,
): TrackSampler {
  const sorted = sortPoints(points);
  let segIndex = 0;

  function sample(time: number): SampledPoint | null {
    if (sorted.length === 0) return null;
    while (segIndex < sorted.length - 1 && sorted[segIndex + 1].t < time) {
      segIndex++;
    }
    while (segIndex > 0 && sorted[segIndex].t > time) {
      segIndex--;
    }
    return sampleAt(sorted, time, defaultLightness);
  }

  return { sample };
}

export function resolveTrack(track: Track, rate = 200): ResolvedSample[] {
  const points = prepareTrackPoints(track);
  const defaultL = track.lightness ?? 0.5;
  if (points.length === 0) return [];
  const end = getTrackDurationFromPoints(points);
  const out: ResolvedSample[] = [];
  const dt = 1 / rate;
  for (let t = 0; t <= end; t += dt) {
    const s = sampleAt(points, t, defaultL);
    if (s) {
      out.push({ t, ...s });
    }
  }
  return out;
}
