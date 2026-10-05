// @ts-nocheck
import { z } from 'zod';
// Avoid deep type instantiation from zod-to-json-schema during project compile.
import { zodToJsonSchema } from 'zod-to-json-schema';

const JsonScoreSchema = z.object({
  sampleRate: z.number().int().positive().default(44100),
  duration: z.number().positive().optional(),
  seed: z.number().int().optional(),
  tracks: z.array(
    z.object({
      id: z.string(),
      hue: z.number().min(0).max(360),
      channel: z.number().int().min(0).default(0),
      lightness: z.number().min(0).max(1).default(0.5),
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
  const generated = zodToJsonSchema(JsonScoreSchema as z.ZodTypeAny, {
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
