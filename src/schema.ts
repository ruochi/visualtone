/**
 * VisualTone score format v2.
 *
 * A score is tempo, key, sections and tracks. Tracks hold notes, looping
 * patterns, chord progressions, sound effects and audio clips. Unknown fields
 * are errors: a model that writes `t` or `velocity` in the wrong place is told
 * what to write instead.
 */
import { z, type ZodError } from 'zod';
import { DRUM_NAMES, INSTRUMENT_ALIASES, INSTRUMENT_NAMES } from './instruments.js';
import { SFX_NAMES } from './sfx.js';
import { suggest } from './suggest.js';

const TimeSchema = z.union([z.number().min(0), z.string().min(1)]);
const LengthSchema = z.union([z.number().positive(), z.string().min(1)]);

export const NoteSchema = z
  .object({
    at: TimeSchema,
    pitch: z.union([z.number().int().min(0).max(127), z.string().min(1)]),
    duration: LengthSchema.optional(),
    velocity: z.number().min(0).max(1).default(0.8),
  })
  .strict();

export const SfxSchema = z
  .object({
    type: z.enum(SFX_NAMES),
    at: z.union([TimeSchema, z.array(TimeSchema).min(1)]),
    duration: LengthSchema.optional(),
    size: z.number().min(0).max(1).default(0.6),
    pan: z.number().min(-1).max(1).default(0),
    brightness: z.number().min(0).max(1).default(0.5),
    pitch: z.number().min(-24).max(24).default(0),
    direction: z.enum(['in', 'out']).optional(),
  })
  .strict()
  .refine((e) => e.direction === undefined || e.type === 'whoosh', {
    message: 'direction is only for whoosh (in or out)',
  });

export const ClipSchema = z
  .object({
    src: z.string().min(1),
    at: TimeSchema.default(0),
    offset: z.number().min(0).default(0),
    duration: LengthSchema.optional(),
    loop: z.boolean().default(false),
    gain: z.number().default(0),
    fadeIn: z.number().min(0).default(0),
    fadeOut: z.number().min(0).default(0),
  })
  .strict();

export const DuckSchema = z.union([
  z.enum(['auto', 'off']),
  z
    .object({
      by: z.string().min(1),
      amount: z.number().min(0).max(1).default(0.5),
      release: z.number().positive().default(0.25),
    })
    .strict(),
]);

const InSchema = z.union([
  z.array(z.string().min(1)).min(1),
  z.object({ from: z.string().min(1), to: z.string().min(1) }).strict(),
]);

export const PatternSchema = z
  .object({
    in: InSchema.optional(),
    grid: z.union([z.string().min(1), z.number().positive()]).optional(),
    steps: z.record(z.string(), z.string()).optional(),
    notes: z.string().optional(),
  })
  .strict()
  .refine((p) => Number(p.steps !== undefined) + Number(p.notes !== undefined) === 1, {
    message: 'a pattern needs steps (drums) or notes (a pitched line), and not both',
  });

export const ChordSchema = z
  .object({
    in: InSchema.optional(),
    progression: z.string().min(1),
    per: z.union([z.string().min(1), z.number().positive()]).optional(),
    style: z.enum(['pad', 'block', 'stab', 'strum', 'arp-up', 'arp-down', 'arp-updown']).default('block'),
    rhythm: z.string().optional(),
    register: z.string().optional(),
    voicing: z.enum(['close', 'open', 'spread']).default('close'),
  })
  .strict();

export const TrackSchema = z
  .object({
    id: z.string().min(1),
    role: z.enum(['music', 'sfx', 'voice']).default('music'),
    instrument: z.string().optional(),
    gain: z.number().default(0),
    pan: z.number().min(-1).max(1).optional(),
    brightness: z.number().min(0).max(1).default(0.5),
    space: z.number().min(0).max(1).optional(),
    duck: DuckSchema.optional(),
    follow: z.string().min(1).optional(),
    notes: z.array(NoteSchema).default([]),
    patterns: z.array(PatternSchema).default([]),
    chords: z.array(ChordSchema).default([]),
    sfx: z.array(SfxSchema).default([]),
    clips: z.array(ClipSchema).default([]),
  })
  .strict()
  .refine((t) => t.notes.length + t.patterns.length + t.chords.length + t.sfx.length + t.clips.length > 0, {
    message: 'a track needs notes, patterns, chords, sfx or clips',
  });

export const ScoreSchema = z
  .object({
    version: z.literal(2).default(2),
    seed: z.number().int().default(1),
    sampleRate: z.number().int().positive().default(48000),
    duration: z.number().positive().optional(),
    tempo: z
      .object({
        bpm: z.number().positive().max(400),
        meter: z.enum(['2/4', '3/4', '4/4', '5/4', '6/8', '7/8', '12/8']).default('4/4'),
        swing: z.number().min(0).max(0.5).default(0),
      })
      .strict()
      .optional(),
    key: z.string().optional(),
    sections: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'section id must start with a letter (no ":" or "@")'),
            at: z.number().min(0),
          })
          .strict(),
      )
      .default([]),
    tracks: z.array(TrackSchema).min(1),
    mix: z
      .object({
        loudness: z.number().default(-16),
        ceiling: z.number().max(0).default(-1),
      })
      .strict()
      .default({}),
  })
  .strict();

export type Score = z.infer<typeof ScoreSchema>;
export type ScoreInput = z.input<typeof ScoreSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type Note = z.infer<typeof NoteSchema>;
export type SfxEvent = z.infer<typeof SfxSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type Pattern = z.infer<typeof PatternSchema>;
export type ChordTrack = z.infer<typeof ChordSchema>;

const FIELD_ALIASES: Record<string, Record<string, string>> = {
  score: { master: 'mix', bpm: 'tempo', keySignature: 'key' },
  tempo: { rate: 'bpm', time: 'meter', signature: 'meter' },
  sections: { name: 'id', t: 'at', time: 'at', start: 'at' },
  tracks: {
    name: 'id', t: 'at', hue: 'brightness', lightness: 'brightness', reverb: 'space', delay: 'space',
    volume: 'gain', level: 'gain', track: 'id',
  },
  notes: { t: 'at', time: 'at', start: 'at', len: 'duration', length: 'duration', size: 'velocity', vel: 'velocity', note: 'pitch' },
  patterns: { pattern: 'notes', sequence: 'steps', section: 'in' },
  chords: { chords: 'progression', chord: 'progression', section: 'in', length: 'per' },
  sfx: { sfx: 'type', name: 'type', t: 'at', time: 'at', start: 'at', velocity: 'size', len: 'duration', length: 'duration' },
  clips: { file: 'src', path: 'src', t: 'at', time: 'at', start: 'at', len: 'duration', length: 'duration', volume: 'gain' },
  mix: { master: 'loudness', gain: 'loudness', limit: 'ceiling' },
  duck: { track: 'by', source: 'by', from: 'by' },
  in: { start: 'from', end: 'to' },
};

const FIELDS: Record<string, readonly string[]> = {
  score: ['version', 'seed', 'sampleRate', 'duration', 'tempo', 'key', 'sections', 'tracks', 'mix'],
  tempo: ['bpm', 'meter', 'swing'],
  sections: ['id', 'at'],
  tracks: ['id', 'role', 'instrument', 'gain', 'pan', 'brightness', 'space', 'duck', 'follow', 'notes', 'patterns', 'chords', 'sfx', 'clips'],
  notes: ['at', 'pitch', 'duration', 'velocity'],
  patterns: ['in', 'grid', 'steps', 'notes'],
  chords: ['in', 'progression', 'per', 'style', 'rhythm', 'register', 'voicing'],
  sfx: ['type', 'at', 'duration', 'size', 'pan', 'brightness', 'pitch', 'direction'],
  clips: ['src', 'at', 'offset', 'duration', 'loop', 'gain', 'fadeIn', 'fadeOut'],
  mix: ['loudness', 'ceiling'],
  duck: ['by', 'amount', 'release'],
  in: ['from', 'to'],
  steps: DRUM_NAMES,
};

function pathString(path: (string | number)[]): string {
  if (!path.length) return 'score';
  let s = '';
  for (const p of path) s += typeof p === 'number' ? `[${p}]` : (s ? '.' : '') + p;
  return s;
}

function kindOf(path: (string | number)[]): string {
  for (let i = path.length - 1; i >= 0; i--) if (typeof path[i] === 'string') return path[i] as string;
  return 'score';
}

function formatZod(error: ZodError): string {
  const lines: string[] = [];
  for (const issue of error.issues) {
    if (lines.length >= 8) break;
    const path = pathString(issue.path);
    if (issue.code === 'unrecognized_keys') {
      const kind = kindOf(issue.path);
      const fields = FIELDS[kind] ?? [];
      for (const key of issue.keys) {
        if (lines.length >= 8) break;
        const hint = suggest(key, fields, FIELD_ALIASES[kind] ?? {});
        lines.push(`${path}.${key}: unknown field${hint ? `; did you mean "${hint}"?` : ''}`);
      }
      continue;
    }
    if (issue.code === 'invalid_enum_value' && issue.path[issue.path.length - 1] === 'instrument') {
      lines.push(`${path}: unknown instrument "${String(issue.received)}"`);
      continue;
    }
    lines.push(`${path}: ${issue.message}`);
  }
  const extra = error.issues.length - lines.length;
  if (extra > 0) lines.push(`and ${extra} more`);
  return lines.join('\n');
}

function checkNames(score: Score): void {
  const ids = new Set<string>();
  for (const t of score.tracks) {
    if (ids.has(t.id)) throw new Error(`track id "${t.id}" is used twice`);
    ids.add(t.id);
  }
  const sections = new Set<string>();
  let prev = -1;
  for (const s of score.sections) {
    if (sections.has(s.id)) throw new Error(`section id "${s.id}" is used twice`);
    sections.add(s.id);
    if (s.at < prev) throw new Error(`section "${s.id}" starts before the previous section; list sections in time order`);
    prev = s.at;
  }
  for (const t of score.tracks) {
    if (t.follow && !ids.has(t.follow)) {
      const hint = suggest(t.follow, [...ids]);
      throw new Error(`track ${t.id}: follow "${t.follow}" is not a track${hint ? `; did you mean "${hint}"?` : ''}`);
    }
    if (t.duck && typeof t.duck === 'object' && !ids.has(t.duck.by)) {
      const hint = suggest(t.duck.by, [...ids]);
      throw new Error(`track ${t.id}: duck.by "${t.duck.by}" is not a track${hint ? `; did you mean "${hint}"?` : ''}`);
    }
    const needsInstrument = t.notes.length + t.patterns.length + t.chords.length > 0;
    if (needsInstrument && !t.instrument) throw new Error(`track ${t.id}: needs an instrument (${INSTRUMENT_NAMES.join(', ')})`);
    if (t.instrument && !INSTRUMENT_NAMES.includes(t.instrument)) {
      const hint = suggest(t.instrument, INSTRUMENT_NAMES, INSTRUMENT_ALIASES);
      throw new Error(`track ${t.id}: unknown instrument "${t.instrument}"${hint ? `; did you mean "${hint}"?` : ''}. Known: ${INSTRUMENT_NAMES.join(', ')}`);
    }
  }
}

export function parseScore(input: unknown): Score {
  if (input && typeof input === 'object' && (input as { version?: unknown }).version === 1) {
    throw new Error('score version 1 is not supported. Write version 2: tempo, sections, patterns and chords (see README)');
  }
  const parsed = ScoreSchema.safeParse(input);
  if (!parsed.success) throw new Error(formatZod(parsed.error));
  checkNames(parsed.data);
  return parsed.data;
}
