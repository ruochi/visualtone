/**
 * VisualTone score format v1.
 *
 * A score is a list of tracks. Each track holds notes (synthesized),
 * sfx (built-in effects) and/or clips (external WAV files), plus simple
 * mixing settings. Times are in seconds, pitches are MIDI numbers or note names.
 */
import { z } from 'zod';

export const PitchSchema = z.union([
  z.number().min(0).max(127),
  z.string().regex(/^[A-G][#b]?-?\d$/, 'Note name like C4, F#3, Bb2'),
]);

export const NoteSchema = z.object({
  t: z.number().min(0).describe('Start time, seconds'),
  pitch: PitchSchema.default(60).describe('MIDI 0-127 or note name. Drum kits use GM numbers'),
  size: z.number().min(0).max(1).default(0.8).describe('Velocity 0-1'),
  duration: z.number().positive().default(0.25).describe('Seconds'),
});

export const SFX_NAMES = ['whoosh', 'riser', 'impact', 'pop', 'tick'] as const;

export const SfxSchema = z.object({
  sfx: z.enum(SFX_NAMES),
  t: z.number().min(0),
  size: z.number().min(0).max(1).default(0.7),
  duration: z.number().positive().optional().describe('Defaults per effect'),
});

export const ClipSchema = z.object({
  src: z.string().describe('WAV path, relative to the score file'),
  at: z.number().default(0).describe('Timeline position, seconds'),
  gain: z.number().default(0).describe('dB'),
  fadeIn: z.number().min(0).default(0),
  fadeOut: z.number().min(0).default(0),
});

export const DuckSchema = z.object({
  by: z.string().describe('Track id whose level pushes this track down'),
  amount: z.number().min(0).max(1).default(0.5),
  release: z.number().positive().default(0.25).describe('Seconds'),
});

export const TrackSchema = z
  .object({
    id: z.string(),
    role: z.enum(['music', 'sfx', 'voice']).default('music'),
    instrument: z.string().default('lead').describe('Preset name, see INSTRUMENTS'),
    hue: z.number().min(0).max(360).optional().describe('Overrides the preset waveform blend'),
    lightness: z.number().min(0).max(1).optional().describe('Overrides the preset filter brightness'),
    gain: z.number().default(0).describe('dB'),
    pan: z.number().min(-1).max(1).default(0),
    lowCut: z.number().positive().optional().describe('High-pass Hz'),
    highCut: z.number().positive().optional().describe('Low-pass Hz'),
    reverb: z.number().min(0).max(1).default(0).describe('Send to master reverb'),
    delay: z.number().min(0).max(1).default(0).describe('Send to master delay'),
    duck: DuckSchema.optional(),
    params: z.record(z.string(), z.unknown()).optional().describe('Engine-specific settings. Engines ignore keys they do not know'),
    notes: z.array(NoteSchema).default([]),
    sfx: z.array(SfxSchema).default([]),
    clips: z.array(ClipSchema).default([]),
  })
  .refine((t) => t.notes.length + t.sfx.length + t.clips.length > 0, {
    message: 'Track needs notes, sfx or clips',
  });

export const MasterSchema = z.object({
  loudness: z.number().default(-14).describe('Target RMS loudness, dBFS (approximate LUFS)'),
  ceiling: z.number().max(0).default(-1).describe('Peak ceiling, dBFS'),
  reverb: z.object({ size: z.number().min(0).max(1).default(0.6), damping: z.number().min(0).max(1).default(0.4) }).default({}),
  delay: z.object({ time: z.number().positive().default(0.375), feedback: z.number().min(0).max(0.95).default(0.35) }).default({}),
});

export const ScoreSchema = z.object({
  version: z.literal(1).default(1),
  sampleRate: z.number().int().positive().default(48000),
  duration: z.number().positive().optional().describe('Seconds. Default: last event + tail'),
  seed: z.number().int().default(1),
  tracks: z.array(TrackSchema).min(1),
  master: MasterSchema.default({}),
});

export type Score = z.infer<typeof ScoreSchema>;
export type ScoreInput = z.input<typeof ScoreSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type Note = z.infer<typeof NoteSchema>;
export type SfxEvent = z.infer<typeof SfxSchema>;
export type Clip = z.infer<typeof ClipSchema>;

export function parseScore(input: unknown): Score {
  const score = ScoreSchema.parse(input);
  const ids = new Set(score.tracks.map((t) => t.id));
  if (ids.size !== score.tracks.length) throw new Error('Track ids must be unique');
  for (const t of score.tracks) {
    if (t.duck && !ids.has(t.duck.by)) throw new Error(`Track ${t.id}: duck.by "${t.duck.by}" is not a track id`);
  }
  return score;
}

const LETTERS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** C4 = 60, A4 = 69. */
export function toMidi(pitch: number | string): number {
  if (typeof pitch === 'number') return pitch;
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(pitch);
  if (!m) throw new Error(`Invalid note name: ${pitch}`);
  return LETTERS[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
}
