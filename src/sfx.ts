import type { Note, Point, SfxEvent, Track } from './schema.js';
import { hashSeed } from './timbre.js';

const DEFAULT_DURATION: Record<SfxEvent['sfx'], number> = {
  whoosh: 0.45,
  riser: 2,
  swell: 1.6,
  impact: 0.35,
  pop: 0.07,
  tick: 0.03,
  key: 0.45,
  shimmer: 1.4,
};

function dur(e: SfxEvent): number {
  return e.duration ?? DEFAULT_DURATION[e.sfx];
}

function sizeOf(e: SfxEvent, fallback = 0.7): number {
  return e.size ?? fallback;
}

function light(e: SfxEvent, fallback: number): number {
  return e.brightness ?? fallback;
}

function pitchOf(e: SfxEvent, fallback: number): number {
  return e.y ?? fallback;
}

function base(id: string, seed: number, partial: Partial<Track> & Pick<Track, 'hue'>): Track {
  return {
    id,
    channel: [0, 1],
    role: 'sfx',
    seed,
    lightness: 0.6,
    ...partial,
  };
}

function envPoints(t: number, d: number, y0: number, y1: number, size: number, lightness: number, attack = 0.08): Point[] {
  const a = Math.min(attack, d * 0.4);
  return [
    { t, y: y0, size: 0, lightness, ease: 'step' },
    { t: t + a, y: y0 + (y1 - y0) * (a / d), size, lightness, ease: 'in' },
    { t: t + d, y: y1, size: 0, lightness, ease: 'out' },
  ];
}

function oneShot(t: number, y: number, size: number, d: number, lightness: number): Note[] {
  return [{ t, y, size, duration: d, ease: 'exp', lightness }];
}

/** Expand one event into one or more synth tracks. */
export function sfxToTracks(event: SfxEvent, id: string, seed: number): Track[] {
  const t = event.t ?? 0;
  const d = dur(event);
  const size = sizeOf(event);
  const pan = event.pan;
  const withPan = (track: Track): Track => {
    if (event.sfx === 'whoosh' && event.direction) {
      const center = pan ?? 0;
      const dir = event.direction;
      return {
        ...track,
        pan: center,
        automation: {
          ...track.automation,
          pan: [
            { t, v: -dir },
            { t: t + d, v: dir },
          ],
        },
      };
    }
    return pan === undefined ? track : { ...track, pan };
  };

  switch (event.sfx) {
    case 'whoosh': {
      const b = light(event, 0.75);
      return [
        withPan(
          base(id, seed, {
            hue: 250,
            saturation: 0.12,
            lightness: b,
            eq: { lowCut: 400, highShelf: { freq: 4000, gain: 3 } },
            points: envPoints(t, d, 58, 86, size, b, d * 0.35),
          }),
        ),
      ];
    }
    case 'riser': {
      const b = light(event, 0.85);
      return [
        withPan(
          base(id, seed, {
            hue: 160,
            saturation: 0.85,
            lightness: b,
            points: envPoints(t, d, 40, 76, size, b, d * 0.85),
          }),
        ),
      ];
    }
    case 'swell': {
      const b = light(event, 0.55);
      return [
        withPan(
          base(id, seed, {
            hue: 210,
            saturation: 0.9,
            lightness: b,
            space: 0.35,
            room: 0.2,
            points: envPoints(t, d, pitchOf(event, 60), pitchOf(event, 64), size * 0.7, b, d * 0.45),
          }),
        ),
      ];
    }
    case 'impact': {
      const low = event.low ?? 0.8;
      const tail = event.tail ?? d;
      const boom = withPan(
        base(`${id}:low`, seed, {
          hue: 0,
          lightness: 0.35,
          notes: oneShot(t, 34, size * low, Math.max(0.08, tail), 0.3),
          eq: { highCut: 220 },
        }),
      );
      const crack = withPan(
        base(`${id}:noise`, seed ^ 0x51, {
          hue: 300,
          saturation: 0.15,
          lightness: light(event, 0.7),
          notes: oneShot(t, 72, size * 0.65, 0.09, light(event, 0.7)),
          eq: { lowCut: 800 },
        }),
      );
      return [boom, crack];
    }
    case 'pop':
      return [
        withPan(
          base(id, seed, {
            hue: 70,
            lightness: light(event, 0.7),
            notes: oneShot(t, pitchOf(event, 79), size, d, light(event, 0.7)),
          }),
        ),
      ];
    case 'tick':
      return [
        withPan(
          base(id, seed, {
            hue: 335,
            lightness: light(event, 0.8),
            eq: { lowCut: 2500 },
            notes: oneShot(t, pitchOf(event, 96), size, d, light(event, 0.85)),
          }),
        ),
      ];
    case 'key':
      return [
        withPan(
          base(id, seed, {
            hue: 110,
            lightness: light(event, 0.65),
            space: 0.22,
            release: 180,
            notes: [{ t, y: pitchOf(event, 72), size, duration: d, ease: 'hold', lightness: light(event, 0.65) }],
          }),
        ),
      ];
    case 'shimmer': {
      const b = light(event, 0.8);
      const y = pitchOf(event, 84);
      return [
        withPan(
          base(id, seed, {
            hue: 110,
            lightness: b,
            space: 0.4,
            echo: 0.35,
            release: 240,
            lfo: [{ target: 'lightness', depth: 0.08, rate: 0.35, shape: 'sine', phase: 0 }],
            notes: [
              { t, y, size: size * 0.6, duration: d * 0.7, ease: 'hold', lightness: b },
              { t: t + 0.03, y: y + 7, size: size * 0.35, duration: d * 0.6, ease: 'hold', lightness: b },
            ],
          }),
        ),
      ];
    }
    default:
      throw new Error(`未知音效 ${(event as SfxEvent).sfx}`);
  }
}

/** Replace tracks that carry `sfx` with generated curve tracks. Idempotent. */
export function expandSfx<T extends { seed?: number; tracks: Track[] }>(score: T): T {
  const tracks: Track[] = [];
  score.tracks.forEach((track, trackIndex) => {
    if (!track.sfx?.length) {
      tracks.push(track);
      return;
    }
    const rest: Track = { ...track, sfx: undefined };
    const keep =
      (rest.points?.length ?? 0) > 0 || (rest.notes?.length ?? 0) > 0 || rest.clip !== undefined || (rest.clips?.length ?? 0) > 0;
    if (keep) tracks.push(rest);
    track.sfx.forEach((event, i) => {
      const seed = hashSeed(score.seed, trackIndex * 100 + i + 17);
      const id = `${track.id}:${event.sfx}-${i}`;
      tracks.push(...sfxToTracks(event, id, seed));
    });
  });
  return { ...score, tracks };
}
