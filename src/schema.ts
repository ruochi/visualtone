import { z } from 'zod';

export const EaseSchema = z.enum(['step', 'linear', 'in', 'out', 'inOut', 'exp']);
export type Ease = z.infer<typeof EaseSchema>;

export const NoteEaseSchema = z.enum(['hold', 'exp']);
export type NoteEase = z.infer<typeof NoteEaseSchema>;

export const PointSchema = z.object({
  t: z.number().describe('Time in seconds'),
  y: z.number().describe('Pitch as MIDI note float (0-127, continuous)'),
  size: z.number().min(0).max(1).describe('Normalized size 0-1 mapping to gain'),
  lightness: z.number().min(0).max(1).optional().describe('Brightness 0-1, maps to filter cutoff'),
  ease: EaseSchema.optional().describe('How to arrive at this point from the previous one'),
  tween: z.number().min(0).optional().describe('Seconds before this point over which to tween'),
});

export const NoteSchema = z.object({
  t: z.number().describe('Note onset time in seconds'),
  y: z.number().describe('Pitch MIDI float'),
  size: z.number().min(0).max(1).describe('Peak gain 0-1'),
  duration: z.number().positive().describe('Note length in seconds'),
  ease: NoteEaseSchema.optional().describe('hold = sustain then short release; exp = exponential decay'),
  lightness: z.number().min(0).max(1).optional(),
});

const TrackSchemaBase = z.object({
  id: z.string().describe('Unique track identifier'),
  hue: z.number().min(0).max(360).describe('Hue in degrees (0-360) mapping to timbre family'),
  channel: z.number().int().min(0).default(0).describe('Channel index (0 = mono bus)'),
  lightness: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe('Default lightness for this track when not set on points/notes'),
  points: z.array(PointSchema).optional().describe('Curve control points'),
  notes: z.array(NoteSchema).optional().describe('Shorthand notes expanded to points before render'),
});

export const TrackSchema = TrackSchemaBase.refine(
  (t) => (t.points?.length ?? 0) > 0 || (t.notes?.length ?? 0) > 0,
  { message: 'Track must have points or notes' },
);

export const ScoreSchema = z.object({
  sampleRate: z.number().int().positive().default(44100).describe('Audio sample rate in Hz'),
  duration: z.number().positive().optional().describe('Optional explicit duration in seconds'),
  seed: z.number().int().optional().describe('Optional random seed for deterministic synthesis'),
  tracks: z.array(TrackSchema).describe('Array of curve tracks'),
});

export type Point = z.infer<typeof PointSchema>;
export type Note = z.infer<typeof NoteSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type Score = z.infer<typeof ScoreSchema>;
