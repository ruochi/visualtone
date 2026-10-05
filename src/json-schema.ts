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
  sampleRate: z.number().int().positive().default(44100),
  duration: z.number().positive().optional(),
  seed: z.number().int().optional(),
  bpm: z.number().positive().optional(),
  swing: z.number().min(0).max(1).optional().describe('0 straight, 1 triplet; needs bpm'),
  swingGrid: z.union([z.literal(8), z.literal(16)]).optional(),
  master: z
    .object({
      loudness: z.number().default(-14),
      drive: z.number().min(0).max(1).default(0.15),
      reverb: z.object({ size: z.number(), decay: z.number() }).optional(),
      delay: z.object({ beats: z.number(), feedback: z.number() }).optional(),
      comp: Comp.optional(),
    })
    .optional(),
  tracks: z.array(
    z.object({
      id: z.string(),
      hue: z.number().min(0).max(360),
      channel: z.union([z.number().int().min(0), z.array(z.number().int().min(0))]).default(0),
      lightness: z.number().min(0).max(1).default(0.5),
      saturation: z.number().min(0).max(1).optional(),
      space: z.number().min(0).max(1).optional(),
      echo: z.number().min(0).max(1).optional(),
      duck: z.object({ by: z.string(), amount: z.number().min(0).max(1) }).optional(),
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
      automation: z.object({ lightness: Keyframes.optional(), gain: Keyframes.optional() }).optional(),
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
            t: z.number(),
            y: z.number(),
            size: z.number().min(0).max(1),
            duration: z.number().positive(),
            ease: z.enum(['hold', 'exp']).optional(),
            lightness: z.number().min(0).max(1).optional(),
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
