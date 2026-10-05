// @ts-nocheck
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const JsonScoreSchema = z.object({
  sampleRate: z.number().int().positive().default(44100),
  duration: z.number().positive().optional(),
  seed: z.number().int().optional(),
  bpm: z.number().positive().optional(),
  master: z
    .object({
      loudness: z.number().default(-14),
      drive: z.number().min(0).max(1).default(0.15),
      reverb: z.object({ size: z.number(), decay: z.number() }).optional(),
      delay: z.object({ beats: z.number(), feedback: z.number() }).optional(),
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
