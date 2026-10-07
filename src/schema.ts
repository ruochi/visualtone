import { z } from 'zod';
import { expandUnits } from './units.js';

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
    velocity: z.number().min(0).max(1).optional().describe('How much note size opens the filter'),
    drift: z.number().min(0).max(1).optional().describe('Slow pitch drift and per-note randomness'),
  })
  .partial();

export const DuckSchema = z.object({
  by: z.string().describe('Track id whose envelope triggers ducking'),
  amount: z.number().min(0).max(1).default(0.6),
  holdMs: z.number().min(0).optional().describe('Hold the duck after the source drops, so speech does not pump'),
  releaseMs: z.number().min(1).optional().describe('Release time. Default 120'),
  band: z
    .tuple([z.number().positive(), z.number().positive()])
    .optional()
    .describe('Duck only this Hz range (dynamic EQ). Omit to duck the whole signal'),
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
  pan: z.array(KeyframeSchema).optional().describe('Offset added to pan, -1 left to 1 right'),
});

export const ChorusSchema = z.object({
  depth: z.number().min(0).max(1).default(0.4),
  rateHz: z.number().positive().default(0.4),
  mix: z.number().min(0).max(1).default(0.35),
});

export const HumanizeSchema = z.object({
  timeMs: z.number().min(0).default(0).describe('Max ± onset jitter in ms'),
  size: z.number().min(0).max(1).default(0).describe('Max ± relative size jitter'),
});

export const PointSchema = z
  .object({
    t: z.number().optional().describe('Time in seconds'),
    at: z.string().optional().describe('Bar:beat, 1-based. Requires score bpm'),
    y: z.number().optional().describe('Pitch as MIDI note float (0-127, continuous)'),
    pitch: z.string().optional().describe('Note name such as A3'),
    size: z.number().min(0).max(1).describe('Normalized size 0-1 mapping to gain'),
    lightness: z.number().min(0).max(1).optional().describe('Brightness 0-1, maps to filter cutoff'),
    ease: EaseSchema.optional().describe('How to arrive at this point from the previous one'),
    tween: z.number().min(0).optional().describe('Seconds before this point over which to tween'),
  })
  .refine((p) => (p.t === undefined) !== (p.at === undefined), { message: 'Point needs exactly one of t or at' })
  .refine((p) => (p.y === undefined) !== (p.pitch === undefined), {
    message: 'Point needs exactly one of y or pitch',
  });

export const NoteSchema = z
  .object({
    t: z.number().optional().describe('Note onset time in seconds'),
    at: z.string().optional().describe('Bar:beat, 1-based. Requires score bpm'),
    y: z.number().optional().describe('Pitch MIDI float'),
    pitch: z.string().optional().describe('Note name such as A3'),
    size: z.number().min(0).max(1).describe('Peak gain 0-1'),
    duration: z.number().positive().optional().describe('Note length in seconds'),
    len: z.string().optional().describe('Note length such as 1/8. Requires bpm'),
    ease: NoteEaseSchema.optional().describe('hold = sustain then short release; exp = exponential decay'),
    lightness: z.number().min(0).max(1).optional(),
  })
  .refine((n) => (n.t === undefined) !== (n.at === undefined), { message: 'Note needs exactly one of t or at' })
  .refine((n) => (n.y === undefined) !== (n.pitch === undefined), {
    message: 'Note needs exactly one of y or pitch',
  })
  .refine((n) => (n.duration === undefined) !== (n.len === undefined), {
    message: 'Note needs exactly one of duration or len',
  });

export const ChannelSchema = z.union([
  z.number().int().min(0),
  z.array(z.number().int().min(0)).min(1),
]);

export const MasterSchema = z
  .object({
    loudness: z.number().default(-14).describe('Target integrated loudness approx (dBFS RMS)'),
    drive: z.number().min(0).max(1).default(0.15),
    saturation: z.number().min(0).max(1).optional().describe('Even-harmonic tape saturation on the bus, 0 off'),
    reverb: z
      .object({
        size: z.number().min(0).max(1).default(0.6),
        decay: z.number().min(0).max(1).default(0.5),
        preDelayMs: z.number().min(0).max(100).default(25),
        damping: z.number().min(0).max(1).default(0.4).describe('How fast highs die in the tail'),
        width: z.number().min(0).max(1).default(0.85),
      })
      .optional(),
    room: z
      .object({
        size: z.number().min(0).max(1).default(0.4),
        decay: z.number().min(0).max(1).default(0.3),
        preDelayMs: z.number().min(0).max(100).default(8),
        damping: z.number().min(0).max(1).default(0.3),
        width: z.number().min(0).max(1).default(0.6),
      })
      .optional()
      .describe('Short room bus fed by track.room'),
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
    lufs: z
      .number()
      .optional()
      .describe('Target integrated LUFS (BS.1770). When set, replaces the RMS loudness match'),
  })
  .optional();

export const ClipSchema = z.object({
  src: z.string().min(1).describe('Path of a WAV file, relative to the score when read by the CLI'),
  at: z.number().min(0).default(0).describe('Start time on the score timeline, seconds'),
  gain: z.number().min(0).default(1),
  fadeIn: z.number().min(0).default(0),
  fadeOut: z.number().min(0).default(0),
  trim: z.tuple([z.number().min(0), z.number().min(0)]).optional().describe('Source region in seconds [start, end]'),
});

export const SfxNameSchema = z.enum(['whoosh', 'riser', 'swell', 'impact', 'pop', 'tick', 'key', 'shimmer']);

export const SfxEventSchema = z.object({
  sfx: SfxNameSchema,
  t: z.number().min(0).optional(),
  at: z.string().optional().describe('Bar:beat, 1-based, expanded with bpm'),
  duration: z.number().positive().optional(),
  len: z.string().optional().describe('Note length such as 1/8'),
  size: z.number().min(0).max(1).optional(),
  pan: z.number().min(-1).max(1).optional(),
  direction: z.number().min(-1).max(1).optional().describe('whoosh: pan travel, -1 leftward to 1 rightward'),
  brightness: z.number().min(0).max(1).optional(),
  low: z.number().min(0).max(1).optional().describe('impact: amount of low boom'),
  tail: z.number().min(0).optional().describe('impact: boom length in seconds'),
  pitch: z.string().optional(),
  y: z.number().optional(),
});

export const EngineSchema = z.enum(['wavetable', 'pluck', 'marimba', 'epiano']);
export const RoleSchema = z.enum(['voice', 'sfx', 'music']);

const TrackSchemaBase = z.object({
  id: z.string().describe('Unique track identifier'),
  hue: z.number().min(0).max(360).optional().describe('Hue in degrees (0-360) mapping to timbre family'),
  channel: ChannelSchema.default(0).describe('Output channel index or stereo pair [0,1]'),
  role: RoleSchema.optional().describe('voice, sfx, or music. Analysis prefers this over the track id'),
  engine: EngineSchema.optional().describe('Default wavetable. pluck, marimba and epiano are polyphonic'),
  lightness: z.number().min(0).max(1).default(0.5),
  saturation: z.number().min(0).max(1).default(1).optional(),
  pan: z.number().min(-1).max(1).optional().describe('Static pan, -1 left to 1 right. 0 is center'),
  offset: z.number().optional().describe('Seconds added to every event on this track before render'),
  seed: z.number().int().optional().describe('Voice noise seed. Set so merging scores does not reshuffle noise'),
  space: z.number().min(0).max(1).optional().describe('Hall reverb send 0-1'),
  room: z.number().min(0).max(1).optional().describe('Short room send 0-1'),
  echo: z.number().min(0).max(1).optional().describe('Delay send 0-1'),
  release: z.number().min(0).optional().describe('Tail after the note, milliseconds. 0 keeps the hard cut'),
  chorus: ChorusSchema.optional(),
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
  clip: ClipSchema.optional().describe('Shorthand for a single audio clip'),
  clips: z.array(ClipSchema).optional(),
  sfx: z.array(SfxEventSchema).optional().describe('Named effects, expanded into curve tracks before render'),
});

export const TrackSchema = TrackSchemaBase.superRefine((t, ctx) => {
  const clips = (t.clips?.length ?? 0) > 0 || t.clip !== undefined;
  const sfx = (t.sfx?.length ?? 0) > 0;
  const curves = (t.points?.length ?? 0) > 0 || (t.notes?.length ?? 0) > 0;
  if (!clips && !sfx && !curves) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Track needs points, notes, clips, or sfx' });
  }
  if (!clips && !sfx && t.hue === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Synth track needs hue' });
  }
});

const ScoreObjectSchema = z.object({
  sampleRate: z.number().int().positive().default(48000),
  duration: z.number().positive().optional(),
  seed: z.number().int().optional(),
  bpm: z.number().positive().optional(),
  meter: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional().describe('Beats per bar and beat unit, default [4, 4]'),
  swing: z.number().min(0).max(1).optional().describe('0 straight, 1 triplet; needs bpm'),
  swingGrid: z.union([z.literal(8), z.literal(16)]).optional().describe('Grid that swing pushes (default 16ths)'),
  master: MasterSchema,
  tracks: z.array(TrackSchema),
});

export const ScoreSchema = ScoreObjectSchema.transform((raw): Score => expandUnits(raw as Score));

export type SfxEvent = z.infer<typeof SfxEventSchema>;
export type SfxName = z.infer<typeof SfxNameSchema>;
export type EngineName = z.infer<typeof EngineSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type TimbreOverride = z.infer<typeof TimbreOverrideSchema>;
export type Lfo = z.infer<typeof LfoSchema>;

export interface Point {
  t: number;
  y: number;
  size: number;
  lightness?: number;
  ease?: Ease;
  tween?: number;
  at?: string;
  pitch?: string;
}

export interface Note {
  t: number;
  y: number;
  size: number;
  duration: number;
  ease?: NoteEase;
  lightness?: number;
  at?: string;
  pitch?: string;
  len?: string;
}

export interface Clip {
  src: string;
  at: number;
  gain?: number;
  fadeIn?: number;
  fadeOut?: number;
  trim?: [number, number];
}

export interface Track {
  id: string;
  hue?: number;
  channel?: number | number[];
  role?: Role;
  engine?: EngineName;
  lightness?: number;
  saturation?: number;
  pan?: number;
  offset?: number;
  seed?: number;
  space?: number;
  room?: number;
  echo?: number;
  release?: number;
  chorus?: { depth?: number; rateHz?: number; mix?: number };
  duck?: { by: string; amount?: number; holdMs?: number; releaseMs?: number; band?: [number, number] };
  timbre?: TimbreOverride;
  eq?: z.infer<typeof EqSchema>;
  comp?: z.infer<typeof CompSchema>;
  lfo?: Lfo[];
  automation?: {
    lightness?: { t: number; v: number }[];
    gain?: { t: number; v: number }[];
    pan?: { t: number; v: number }[];
  };
  swing?: number;
  humanize?: { timeMs?: number; size?: number };
  points?: Point[];
  notes?: Note[];
  clip?: Clip;
  clips?: Clip[];
  sfx?: SfxEvent[];
}

export interface Score {
  sampleRate: number;
  duration?: number;
  seed?: number;
  bpm?: number;
  meter?: [number, number];
  swing?: number;
  swingGrid?: 8 | 16;
  master?: {
    loudness?: number;
    drive?: number;
    saturation?: number;
    reverb?: { size?: number; decay?: number; preDelayMs?: number; damping?: number; width?: number };
    room?: { size?: number; decay?: number; preDelayMs?: number; damping?: number; width?: number };
    delay?: { beats?: number; feedback?: number };
    eq?: z.infer<typeof EqSchema>;
    comp?: z.infer<typeof CompSchema>;
    limiter?: { ceiling?: number; lookaheadMs?: number; releaseMs?: number };
    lufs?: number;
  };
  tracks: Track[];
}

export function trackClips(track: { clip?: Clip; clips?: Clip[] }): Clip[] {
  const many = track.clips ?? [];
  return track.clip ? [track.clip, ...many] : many;
}

export function getChannelIndices(channel: number | number[] | undefined): number[] {
  if (channel === undefined) return [0];
  return Array.isArray(channel) ? channel : [channel];
}
