import { z } from 'zod';

export const EaseSchema = z.enum(['step', 'linear', 'in', 'out', 'inOut', 'exp']);
export type Ease = z.infer<typeof EaseSchema>;

export const NoteEaseSchema = z.enum(['hold', 'exp']);
export type NoteEase = z.infer<typeof NoteEaseSchema>;

export const TimbreOverrideSchema = z
  .object({
    tilt: z.number().optional(),
    oddEven: z.number().optional(),
    inharmonic: z.number().optional(),
    formantFreq: z.number().optional(),
    formantGain: z.number().optional(),
    unison: z.number().optional(),
    detuneCents: z.number().optional(),
    spread: z.number().optional(),
    noise: z.number().optional(),
    noiseColor: z.number().optional(),
    transient: z.number().optional(),
    attackMs: z.number().optional(),
    resonance: z.number().optional(),
    filterEnv: z.number().optional(),
    filterDecayMs: z.number().optional(),
    pitchEnvSemis: z.number().optional(),
    pitchEnvMs: z.number().optional(),
    drive: z.number().optional(),
  })
  .partial();

export const DuckSchema = z.object({
  by: z.string().describe('Track id whose envelope triggers ducking'),
  amount: z.number().min(0).max(1).default(0.6),
});

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

export const ChannelSchema = z.union([
  z.number().int().min(0),
  z.array(z.number().int().min(0)).min(1),
]);

export const MasterSchema = z
  .object({
    loudness: z.number().default(-14).describe('Target integrated loudness approx (dBFS RMS)'),
    drive: z.number().min(0).max(1).default(0.15),
    reverb: z
      .object({
        size: z.number().min(0).max(1).default(0.6),
        decay: z.number().min(0).max(1).default(0.5),
      })
      .optional(),
    delay: z
      .object({
        beats: z.number().positive().default(0.75).describe('Delay time in quarter-note beats'),
        feedback: z.number().min(0).max(0.95).default(0.35),
      })
      .optional(),
  })
  .optional();

const TrackSchemaBase = z.object({
  id: z.string().describe('Unique track identifier'),
  hue: z.number().min(0).max(360).describe('Hue in degrees (0-360) mapping to timbre family'),
  channel: ChannelSchema.default(0).describe('Output channel index or stereo pair [0,1]'),
  lightness: z.number().min(0).max(1).default(0.5),
  saturation: z.number().min(0).max(1).default(1).optional(),
  space: z.number().min(0).max(1).optional().describe('Reverb send 0-1'),
  echo: z.number().min(0).max(1).optional().describe('Delay send 0-1'),
  duck: DuckSchema.optional(),
  timbre: TimbreOverrideSchema.optional(),
  points: z.array(PointSchema).optional(),
  notes: z.array(NoteSchema).optional(),
});

export const TrackSchema = TrackSchemaBase.refine(
  (t) => (t.points?.length ?? 0) > 0 || (t.notes?.length ?? 0) > 0,
  { message: 'Track must have points or notes' },
);

export const ScoreSchema = z.object({
  sampleRate: z.number().int().positive().default(44100),
  duration: z.number().positive().optional(),
  seed: z.number().int().optional(),
  bpm: z.number().positive().optional(),
  master: MasterSchema,
  tracks: z.array(TrackSchema),
});

export type Point = z.infer<typeof PointSchema>;
export type Note = z.infer<typeof NoteSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type Score = z.infer<typeof ScoreSchema>;
export type TimbreOverride = z.infer<typeof TimbreOverrideSchema>;

export function getChannelIndices(channel: number | number[]): number[] {
  return Array.isArray(channel) ? channel : [channel];
}
