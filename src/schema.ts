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

export const EqSchema = z.object({
  lowCut: z.number().positive().optional().describe('High-pass corner Hz (removes rumble/mud)'),
  highCut: z.number().positive().optional().describe('Low-pass corner Hz'),
  lowShelf: z.object({ freq: z.number().positive().default(120), gain: z.number() }).optional(),
  highShelf: z.object({ freq: z.number().positive().default(8000), gain: z.number() }).optional(),
  peaks: z
    .array(z.object({ freq: z.number().positive(), gain: z.number(), q: z.number().positive().default(1) }))
    .optional()
    .describe('Bell bands; negative gain carves space for other tracks'),
});

export const CompSchema = z.object({
  threshold: z.number().default(-18).describe('dBFS'),
  ratio: z.number().min(1).default(3),
  attackMs: z.number().min(0).default(10),
  releaseMs: z.number().min(1).default(120),
  knee: z.number().min(0).default(6).describe('Soft knee width dB'),
  makeup: z.number().default(0).describe('Makeup gain dB'),
});

export const LfoSchema = z
  .object({
    target: z.enum(['lightness', 'pitch', 'gain', 'pan']),
    depth: z
      .number()
      .describe('lightness: ±offset 0-1; pitch: ±semitones; gain: dip 0-1; pan: ±1 = hard L/R'),
    rate: z.number().positive().optional().describe('Hz'),
    beats: z.number().positive().optional().describe('Period in quarter-note beats (uses bpm)'),
    shape: z.enum(['sine', 'triangle', 'saw', 'square']).default('sine'),
    phase: z.number().default(0).describe('Start phase in cycles 0-1'),
  })
  .refine((l) => l.rate !== undefined || l.beats !== undefined, {
    message: 'LFO needs rate (Hz) or beats',
  });

const KeyframeSchema = z.object({ t: z.number(), v: z.number() });

export const AutomationSchema = z.object({
  lightness: z.array(KeyframeSchema).optional().describe('Offset added to lightness, linear between keyframes'),
  gain: z.array(KeyframeSchema).optional().describe('Gain multiplier (1 = unchanged), linear'),
});

export const HumanizeSchema = z.object({
  timeMs: z.number().min(0).default(0).describe('Max ± onset jitter in ms'),
  size: z.number().min(0).max(1).default(0).describe('Max ± relative size jitter'),
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
    eq: EqSchema.optional().describe('EQ on the summed mix, before the glue compressor'),
    comp: CompSchema.optional().describe('Glue compressor on the summed mix'),
    limiter: z
      .object({
        ceiling: z.number().max(0).default(-1).describe('Sample-peak ceiling, dBFS'),
        lookaheadMs: z.number().min(0.5).max(20).default(5),
        releaseMs: z.number().min(5).max(1000).default(60),
      })
      .optional()
      .describe('Lookahead peak limiter at the end of the chain (always on; these override defaults)'),
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
  eq: EqSchema.optional(),
  comp: CompSchema.optional(),
  lfo: z.array(LfoSchema).optional(),
  automation: AutomationSchema.optional(),
  swing: z.number().min(0).max(1).optional().describe('Overrides score swing for this track'),
  humanize: HumanizeSchema.optional(),
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
  swing: z.number().min(0).max(1).optional().describe('0 straight, 1 triplet; needs bpm'),
  swingGrid: z.union([z.literal(8), z.literal(16)]).optional().describe('Grid that swing pushes (default 16ths)'),
  master: MasterSchema,
  tracks: z.array(TrackSchema),
});

export type Point = z.infer<typeof PointSchema>;
export type Note = z.infer<typeof NoteSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type Score = z.infer<typeof ScoreSchema>;
export type TimbreOverride = z.infer<typeof TimbreOverrideSchema>;
export type Lfo = z.infer<typeof LfoSchema>;

export function getChannelIndices(channel: number | number[]): number[] {
  return Array.isArray(channel) ? channel : [channel];
}
