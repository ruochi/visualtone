// @ts-nocheck
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const Comp = z.object({
  threshold: z.number().default(-18).describe('dBFS'),
  ratio: z.number().min(1).default(3),
  attackMs: z.number().min(0).default(10),
  releaseMs: z.number().min(1).default(120),
  knee: z.number().min(0).default(6),
  makeup: z.number().default(0).describe('dB'),
});
const Keyframes = z.array(z.object({ t: z.number(), v: z.number() }));

const JsonScoreSchema = z.object({
  sampleRate: z.number().int().positive().default(48000),
  duration: z.number().positive().optional(),
  seed: z.number().int().optional(),
  bpm: z.number().positive().optional(),
  meter: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
  swing: z.number().min(0).max(1).optional().describe('0 straight, 1 triplet; needs bpm'),
  swingGrid: z.union([z.literal(8), z.literal(16)]).optional(),
  master: z
    .object({
      loudness: z.number().default(-14),
      lufs: z.number().optional().describe('BS.1770 target. When set, replaces the RMS match'),
      drive: z.number().min(0).max(1).default(0.15),
      reverb: z.object({ size: z.number(), decay: z.number() }).optional(),
      delay: z.object({ beats: z.number(), feedback: z.number() }).optional(),
      comp: Comp.optional(),
    })
    .optional(),
  tracks: z.array(
    z.object({
      id: z.string(),
      hue: z.number().min(0).max(360).optional(),
      channel: z.union([z.number().int().min(0), z.array(z.number().int().min(0))]).default(0),
      lightness: z.number().min(0).max(1).default(0.5),
      saturation: z.number().min(0).max(1).optional(),
      space: z.number().min(0).max(1).optional(),
      echo: z.number().min(0).max(1).optional(),
      duck: z
        .object({
          by: z.string(),
          amount: z.number().min(0).max(1),
          holdMs: z.number().optional(),
          releaseMs: z.number().optional(),
          band: z.tuple([z.number(), z.number()]).optional(),
        })
        .optional(),
      timbre: z.record(z.number()).optional(),
      eq: z
        .object({
          lowCut: z.number().positive().optional(),
          highCut: z.number().positive().optional(),
          lowShelf: z.object({ freq: z.number().positive().default(120), gain: z.number() }).optional(),
          highShelf: z.object({ freq: z.number().positive().default(8000), gain: z.number() }).optional(),
          peaks: z
            .array(z.object({ freq: z.number().positive(), gain: z.number(), q: z.number().positive().default(1) }))
            .optional(),
        })
        .optional(),
      comp: Comp.optional(),
      lfo: z
        .array(
          z.object({
            target: z.enum(['lightness', 'pitch', 'gain', 'pan']),
            depth: z.number(),
            rate: z.number().positive().optional().describe('Hz'),
            beats: z.number().positive().optional().describe('Period in quarter-note beats'),
            shape: z.enum(['sine', 'triangle', 'saw', 'square']).default('sine'),
            phase: z.number().default(0),
          }),
        )
        .optional(),
      automation: z.object({ lightness: Keyframes.optional(), gain: Keyframes.optional(), pan: Keyframes.optional() }).optional(),
      swing: z.number().min(0).max(1).optional(),
      humanize: z.object({ timeMs: z.number().min(0).default(0), size: z.number().min(0).max(1).default(0) }).optional(),
      points: z
        .array(
          z.object({
            t: z.number(),
            y: z.number(),
            size: z.number().min(0).max(1),
            lightness: z.number().min(0).max(1).optional(),
            ease: z.enum(['step', 'linear', 'in', 'out', 'inOut', 'exp']).optional(),
            tween: z.number().min(0).optional(),
          }),
        )
        .optional(),
      notes: z
        .array(
          z.object({
            t: z.number().optional(),
            at: z.string().optional(),
            y: z.number().optional(),
            pitch: z.string().optional(),
            size: z.number().min(0).max(1),
            duration: z.number().positive().optional(),
            len: z.string().optional(),
            ease: z.enum(['hold', 'exp']).optional(),
            lightness: z.number().min(0).max(1).optional(),
          }),
        )
        .optional(),
      role: z.enum(['voice', 'sfx', 'music']).optional(),
      engine: z.enum(['wavetable', 'pluck', 'marimba', 'epiano', 'organ']).optional(),
      pan: z.number().min(-1).max(1).optional(),
      offset: z.number().optional(),
      seed: z.number().int().optional(),
      clip: z
        .object({
          src: z.string(),
          at: z.number().default(0),
          gain: z.number().default(1),
          fadeIn: z.number().default(0),
          fadeOut: z.number().default(0),
          trim: z.tuple([z.number(), z.number()]).optional(),
        })
        .optional(),
      clips: z
        .array(
          z.object({
            src: z.string(),
            at: z.number().default(0),
            gain: z.number().default(1),
            fadeIn: z.number().default(0),
            fadeOut: z.number().default(0),
            trim: z.tuple([z.number(), z.number()]).optional(),
          }),
        )
        .optional(),
      sfx: z
        .array(
          z.object({
            sfx: z.enum(['whoosh', 'riser', 'swell', 'impact', 'pop', 'tick', 'key', 'shimmer']),
            t: z.number().optional(),
            duration: z.number().optional(),
            size: z.number().optional(),
            pan: z.number().optional(),
            direction: z.number().optional(),
            brightness: z.number().optional(),
          }),
        )
        .optional(),
    }),
  ),
});

export function getJsonSchema(): Record<string, unknown> {
  const generated = zodToJsonSchema(JsonScoreSchema, {
    name: 'VisualtoneScore',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Visualtone Score',
    description: 'Music as animated colored curves - audio as a pure function of visual data',
    ...generated,
  };
}
