/**
 * Score v2 → concrete notes, with times in seconds and pitches in MIDI.
 * Patterns restart at each section and stop at the section end. Chord
 * degrees follow the chord that is sounding on the followed track.
 */
import { rng } from './dsp.js';
import { DRUM_MIDI, DRUM_NAMES, type DrumName, drumFromMidi, INSTRUMENTS } from './instruments.js';
import type { Score, Track } from './schema.js';
import { SFX_ANCHOR, SFX_DURATION, type SfxName } from './sfx.js';
import { suggest } from './suggest.js';
import {
  barBeatSeconds,
  degreeToMidi,
  durationSeconds,
  inKey,
  isDegree,
  isNoteName,
  type ParsedChord,
  type ParsedKey,
  parseKey,
  parseProgression,
  swingDelay,
  type Tempo,
  makeTempo,
  midiToName,
  toMidi,
  voiceChord,
  type VoicingName,
} from './theory.js';

export type IssueCode =
  | 'out-of-key'
  | 'out-of-range'
  | 'flat-velocity'
  | 'dense-sfx'
  | 'voice-masked'
  | 'deep-limiting'
  | 'sfx-clipped';

export interface Issue {
  code: IssueCode;
  message: string;
  track?: string;
}

export interface CompiledNote {
  at: number;
  duration: number;
  midi: number;
  velocity: number;
  drum?: DrumName;
  /** drum patterns and hand-written notes are checked for flat velocity. */
  source: 'note' | 'pattern' | 'drums' | 'chord';
}

export interface CompiledSfx {
  type: SfxName;
  /** Anchor time (the moment the effect is aimed at). */
  at: number;
  /** Buffer start. May be before `at`, and may be negative. */
  start: number;
  duration: number;
  size: number;
  pan: number;
  brightness: number;
  pitch: number;
  direction?: 'in' | 'out';
}

export interface CompiledClip {
  src: string;
  at: number;
  offset: number;
  /** Seconds to play. Omitted when the file length is not known yet. */
  duration?: number;
  loop: boolean;
  gain: number;
  fadeIn: number;
  fadeOut: number;
}

export interface CompiledTrack {
  source: Track;
  id: string;
  role: Track['role'];
  instrument?: string;
  /** Instrument default plus the track's own dB. */
  gain: number;
  pan: number;
  brightness: number;
  space: number;
  vocalDip: number;
  lowCut?: number;
  tail: number;
  duck?: { by?: string; auto?: boolean; amount: number; release: number };
  notes: CompiledNote[];
  sfx: CompiledSfx[];
  clips: CompiledClip[];
}

export interface CompiledScore {
  sampleRate: number;
  seed: number;
  /** End of the written music, before release tails. */
  contentEnd: number;
  /** Set when the score named a duration. The render then ends there. */
  fixedDuration?: number;
  mix: Score['mix'];
  tracks: CompiledTrack[];
  issues: Issue[];
  key?: ParsedKey;
  tempo?: Tempo;
}

export interface CompileOptions {
  /** File length in seconds, keyed by clip src. Used when a clip omits duration. */
  clipLengths?: Record<string, number>;
}

interface Section {
  id: string;
  at: number;
  end: number;
}

interface Region {
  start: number;
  end: number;
}

interface Span {
  start: number;
  end: number;
  chord: ParsedChord;
  order: number;
  voices: number[];
}

const DRUM_SET = new Set<string>(DRUM_NAMES);
const STEP_VELOCITY: Record<string, number> = { x: 0.8, X: 1, g: 0.35 };

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function cleanSteps(text: string): string {
  return text.replace(/[|\s]/g, '');
}

function tokensOf(text: string): string[] {
  return text.replace(/\|/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function checkStepChar(ch: string, where: string): number {
  const v = STEP_VELOCITY[ch];
  if (v === undefined) throw new Error(`${where}: unexpected "${ch}". Use x, X, g or .`);
  return v;
}

export function compile(score: Score, opts: CompileOptions = {}): CompiledScore {
  const tempo = score.tempo ? makeTempo(score.tempo.bpm, score.tempo.meter, score.tempo.swing) : undefined;
  const key = score.key ? parseKey(score.key) : undefined;
  const where = (track: Track, detail: string) => `track ${track.id}: ${detail}`;

  const resolveTime = (value: number | string, label: string): number => {
    if (typeof value === 'number') return value;
    const s = value.trim();
    const rel = /^([A-Za-z][A-Za-z0-9_-]*)@(\d+):(\d+)$/.exec(s);
    const abs = /^(\d+):(\d+)$/.exec(s);
    if (rel || abs) {
      if (!tempo) throw new Error(`${label}: "${s}" needs a tempo`);
      let origin = 0;
      let bar: number;
      let beat: number;
      if (rel) {
        const section = sectionById(rel[1]);
        origin = section.at;
        bar = Number(rel[2]);
        beat = Number(rel[3]);
      } else {
        bar = Number(abs![1]);
        beat = Number(abs![2]);
      }
      return origin + barBeatSeconds(bar, beat, tempo, label);
    }
    const named = sections.find((sec) => sec.id === s);
    if (named) return named.at;
    if (/^\d+\/\d+\.?$/.test(s) || /^\d+bars?$/.test(s)) {
      throw new Error(`${label}: "${s}" is a duration. Times are seconds, "bar:beat", "section@bar:beat", or a section id`);
    }
    const hint = suggest(s, sections.map((sec) => sec.id));
    throw new Error(`${label}: unknown time "${s}"${hint ? `; did you mean section "${hint}"?` : ''}. Use seconds, "5:1", "groove@2:3", or a section id`);
  };

  const lengthOf = (value: number | string | undefined, label: string, fallback: number): number =>
    value === undefined ? fallback : durationSeconds(value, tempo, label);

  // Section ends are filled in once the piece length is known. Times that
  // point at a section only need its start, so this map is usable immediately.
  const sections: Section[] = score.sections.map((s) => ({ id: s.id, at: s.at, end: Number.POSITIVE_INFINITY }));
  const sectionById = (id: string): Section => {
    const s = sections.find((sec) => sec.id === id);
    if (!s) {
      const hint = suggest(id, sections.map((sec) => sec.id));
      throw new Error(`unknown section "${id}"${hint ? `; did you mean "${hint}"?` : ''}`);
    }
    return s;
  };

  const gridOf = (grid: number | string | undefined, label: string): number => lengthOf(grid ?? '1/16', label, 0);

  const cycleOfPattern = (track: Track, pattern: Track['patterns'][number]): number => {
    const grid = gridOf(pattern.grid, where(track, 'grid'));
    const count = pattern.steps
      ? Math.max(...Object.values(pattern.steps).map((s) => cleanSteps(s).length))
      : tokensOf(pattern.notes ?? '').length;
    return Math.max(count, 1) * grid;
  };

  const cycleOfChords = (track: Track, chord: Track['chords'][number]): number => {
    let chords: ParsedChord[];
    try {
      chords = parseProgression(chord.progression);
    } catch (e) {
      throw new Error(where(track, (e as Error).message));
    }
    const per = lengthOf(chord.per ?? (tempo ? '1bar' : undefined), where(track, 'per'), 0);
    if (!(per > 0)) throw new Error(where(track, 'chords need "per" in seconds, or a tempo so "1bar" has a length'));
    return chords.length * per;
  };

  // Regions before the piece length is known. An open region contributes one
  // cycle; a later pass loops it out to the real end.
  const previewRegions = (spec: Track['patterns'][number]['in'], cycle: number, label: string): Region[] => {
    if (spec && !Array.isArray(spec)) {
      const start = resolveTime(spec.from, label);
      const end = resolveTime(spec.to, label);
      if (end <= start) throw new Error(`${label}: the region ends at ${end.toFixed(2)}s, before it starts at ${start.toFixed(2)}s`);
      return [{ start, end }];
    }
    const ids = Array.isArray(spec) ? spec : sections.map((s) => s.id);
    if (!ids.length) return [{ start: 0, end: cycle }];
    return ids.map((id) => {
      const section = sectionById(id);
      const index = sections.indexOf(section);
      const closed = index < sections.length - 1 || score.duration !== undefined;
      const end = index < sections.length - 1 ? sections[index + 1].at : score.duration ?? section.at + cycle;
      return { start: section.at, end: closed || score.duration !== undefined ? end : section.at + cycle };
    });
  };

  let contentEnd = score.duration ?? 0;
  if (!score.duration && sections.length) contentEnd = Math.max(contentEnd, sections[sections.length - 1].at);
  for (const track of score.tracks) {
    const label = (d: string) => where(track, d);
    for (const note of track.notes) {
      const at = resolveTime(note.at, label('note'));
      const dur = lengthOf(note.duration, label('note duration'), tempo ? durationSeconds('1/4', tempo, label('note')) : 0.25);
      contentEnd = Math.max(contentEnd, at + dur);
    }
    for (const e of track.sfx) {
      const times = Array.isArray(e.at) ? e.at : [e.at];
      const dur = lengthOf(e.duration, label(`${e.type} duration`), SFX_DURATION[e.type]);
      for (const raw of times) {
        const at = resolveTime(raw, label(e.type));
        contentEnd = Math.max(contentEnd, at, at + (1 - SFX_ANCHOR[e.type]) * dur);
      }
    }
    for (const clip of track.clips) {
      const at = resolveTime(clip.at, label(`clip ${clip.src}`));
      const known = opts.clipLengths?.[clip.src];
      const dur = clip.duration !== undefined ? lengthOf(clip.duration, label(`clip ${clip.src}`), 0) : known !== undefined ? Math.max(0, known - clip.offset) : 0;
      contentEnd = Math.max(contentEnd, at + dur);
    }
    for (const pattern of track.patterns) {
      const cycle = cycleOfPattern(track, pattern);
      for (const region of previewRegions(pattern.in, cycle, label('pattern'))) contentEnd = Math.max(contentEnd, region.end);
    }
    for (const chord of track.chords) {
      const cycle = cycleOfChords(track, chord);
      for (const region of previewRegions(chord.in, cycle, label('chords'))) contentEnd = Math.max(contentEnd, region.end);
    }
  }
  if (!(contentEnd > 0)) contentEnd = 0.05;
  if (score.duration !== undefined) {
    const past = sections.find((s) => s.at >= score.duration!);
    if (past) throw new Error(`section "${past.id}" starts at ${past.at}s, past the score duration of ${score.duration}s`);
    contentEnd = score.duration;
  }
  for (let i = 0; i < sections.length; i++) {
    sections[i].end = i + 1 < sections.length ? sections[i + 1].at : contentEnd;
  }

  const regionsOf = (spec: Track['patterns'][number]['in'], label: string): Region[] => {
    if (spec && !Array.isArray(spec)) {
      const start = resolveTime(spec.from, label);
      const end = Math.min(contentEnd, resolveTime(spec.to, label));
      if (end <= start) throw new Error(`${label}: the region ends at ${end.toFixed(2)}s, before it starts at ${start.toFixed(2)}s`);
      return [{ start, end }];
    }
    const ids = Array.isArray(spec) ? spec : sections.map((s) => s.id);
    if (!ids.length) return [{ start: 0, end: contentEnd }];
    return ids.map((id) => {
      const section = sectionById(id);
      return { start: section.at, end: Math.min(section.end, contentEnd) };
    });
  };

  const loop = (region: Region, steps: number, grid: number, visit: (step: number, at: number) => void) => {
    const cycle = steps * grid;
    if (!(cycle > 0) || !(region.end > region.start)) return;
    const limit = Math.ceil((region.end - region.start) / cycle) + 1;
    for (let c = 0; c < limit; c++) {
      const origin = region.start + c * cycle;
      if (origin >= region.end - 1e-9) break;
      for (let i = 0; i < steps; i++) {
        const straight = i * grid;
        const at = origin + straight + swingDelay(straight, tempo);
        if (at < region.start - 1e-9 || at >= region.end - 1e-9) continue;
        visit(i, at);
      }
    }
  };

  const shaped = (step: number, grid: number): number => {
    if (!tempo) {
      if (step % 4 === 0) return 0.95;
      if (step % 2 === 0) return 0.8;
      return 0.65;
    }
    const barPos = ((step * grid) / tempo.beatSec) % tempo.beatsPerBar;
    if (barPos < 0.03) return 0.95;
    const into = barPos - Math.floor(barPos);
    if (into < 0.03) return 0.82;
    if (Math.abs(into - 0.5) < 0.08) return 0.7;
    return 0.62;
  };

  // Chord timelines first, so bass and melody degrees can look them up.
  const timelines = new Map<string, Span[]>();
  for (const track of score.tracks) {
    if (!track.chords.length) continue;
    const info = INSTRUMENTS[track.instrument!];
    const raw: Span[] = [];
    track.chords.forEach((entry, order) => {
      let progression: ParsedChord[];
      try {
        progression = parseProgression(entry.progression);
      } catch (e) {
        throw new Error(where(track, (e as Error).message));
      }
      const per = lengthOf(entry.per ?? (tempo ? '1bar' : undefined), where(track, 'per'), 0);
      if (!(per > 0)) throw new Error(where(track, 'chords need "per" in seconds, or a tempo'));
      let center = info?.center ?? 60;
      if (entry.register) {
        if (!isNoteName(entry.register)) throw new Error(where(track, `register "${entry.register}" must be a note name like C4`));
        center = toMidi(entry.register);
      }
      let prev: number[] | null = null;
      for (const region of regionsOf(entry.in, where(track, 'chords'))) {
        let t = region.start;
        let i = 0;
        while (t < region.end - 1e-6) {
          const end = Math.min(region.end, t + per);
          const chord = progression[i % progression.length];
          const voices = voiceChord(chord, center, entry.voicing as VoicingName, prev, info?.range);
          prev = voices;
          raw.push({ start: t, end, chord, order, voices });
          t = end;
          i++;
          if (i > 100000) throw new Error(where(track, 'chord progression is too long'));
        }
      }
    });
    timelines.set(track.id, resolveOverlaps(raw));
  }

  const chordAt = (id: string, t: number): ParsedChord | undefined => {
    const spans = timelines.get(id);
    if (!spans) return undefined;
    for (let i = spans.length - 1; i >= 0; i--) {
      if (t >= spans[i].start - 1e-6 && t < spans[i].end - 1e-8) return spans[i].chord;
    }
    return undefined;
  };

  const sourceOf = (track: Track): string | undefined => {
    if (track.follow) return track.follow;
    if (track.chords.length) return track.id;
    return undefined;
  };

  for (const track of score.tracks) {
    if (!track.follow) continue;
    const target = score.tracks.find((t) => t.id === track.follow);
    if (!target?.chords.length) throw new Error(where(track, `follow "${track.follow}" has no chords to follow`));
  }

  const pitchOf = (track: Track, pitch: number | string, at: number): { midi: number; drum?: DrumName } => {
    const info = track.instrument ? INSTRUMENTS[track.instrument] : undefined;
    if (typeof pitch === 'number') {
      return info?.kind === 'drums' ? { midi: pitch, drum: drumFromMidi(pitch) } : { midi: pitch };
    }
    if (DRUM_SET.has(pitch)) {
      if (info?.kind !== 'drums') throw new Error(where(track, `"${pitch}" is a drum hit. Use instrument "drums", or write a pitch like C4`));
      return { midi: DRUM_MIDI[pitch as DrumName], drum: pitch as DrumName };
    }
    if (isNoteName(pitch)) {
      if (info?.kind === 'drums') throw new Error(where(track, `drums take drum names (kick, snare, hat, …) or GM numbers, not "${pitch}"`));
      return { midi: toMidi(pitch) };
    }
    if (isDegree(pitch)) {
      if (info?.kind === 'drums') throw new Error(where(track, `"${pitch}" is a chord degree, not a drum`));
      const src = sourceOf(track);
      if (!src) throw new Error(where(track, `"${pitch}" is a chord degree. Set follow to a track with chords, or write a pitch like C4`));
      const chord = chordAt(src, at);
      if (!chord) throw new Error(where(track, `"${pitch}" at ${at.toFixed(2)}s has no chord on "${src}" at that time`));
      return { midi: degreeToMidi(pitch, chord, info?.center ?? 60) };
    }
    const hint = suggest(pitch, [...DRUM_NAMES, 'C4', 'E2']);
    throw new Error(where(track, `invalid pitch "${pitch}"${hint ? `; did you mean "${hint}"?` : ''}`));
  };

  const hasVoice = score.tracks.some((t) => t.role === 'voice');
  const issues: Issue[] = [];
  const compiledTracks: CompiledTrack[] = [];

  for (const track of score.tracks) {
    const info = track.instrument ? INSTRUMENTS[track.instrument] : undefined;
    const notes: CompiledNote[] = [];
    const sfx: CompiledSfx[] = [];
    const fallback = tempo ? durationSeconds('1/4', tempo, 'duration') : 0.25;

    for (const note of track.notes) {
      const at = resolveTime(note.at, where(track, 'note'));
      if (at >= contentEnd) continue;
      const duration = Math.min(lengthOf(note.duration, where(track, 'note duration'), fallback), contentEnd - at);
      const played = pitchOf(track, note.pitch, at);
      notes.push({ at, duration, midi: played.midi, velocity: note.velocity, drum: played.drum, source: 'note' });
    }

    for (const pattern of track.patterns) {
      const grid = gridOf(pattern.grid, where(track, 'grid'));
      const regions = regionsOf(pattern.in, where(track, 'pattern'));
      if (pattern.steps) {
        if (info?.kind !== 'drums') throw new Error(where(track, 'steps are drum hits. Use a notes pattern ("1 . 5 .") or instrument "drums"'));
        for (const [name, text] of Object.entries(pattern.steps)) {
          if (!DRUM_SET.has(name)) {
            const hint = suggest(name, DRUM_NAMES, { hihat: 'hat', hh: 'hat', 'open-hat': 'openhat', tom: 'tom-mid', bd: 'kick', sd: 'snare' });
            throw new Error(where(track, `unknown drum "${name}"${hint ? `; did you mean "${hint}"?` : ''}. Known: ${DRUM_NAMES.join(', ')}`));
          }
          const steps = cleanSteps(text);
          if (!steps) throw new Error(where(track, `${name} pattern is empty`));
          for (const ch of steps) if (ch !== '.') checkStepChar(ch, where(track, name));
          for (const region of regions) {
            loop(region, steps.length, grid, (i, at) => {
              const ch = steps[i];
              if (ch === '.') return;
              const velocity = Math.min(1, checkStepChar(ch, where(track, name)) * (shaped(i, grid) / 0.8));
              notes.push({
                at, duration: grid, midi: DRUM_MIDI[name as DrumName], velocity, drum: name as DrumName, source: 'drums',
              });
            });
          }
        }
      } else {
        if (info?.kind === 'drums') throw new Error(where(track, 'drum patterns use steps ({ kick: "x..." }), not notes'));
        const tokens = tokensOf(pattern.notes ?? '');
        if (!tokens.length) throw new Error(where(track, 'pattern notes are empty'));
        const events: { step: number; cells: number; token: string }[] = [];
        for (let i = 0; i < tokens.length; i++) {
          const token = tokens[i];
          if (token === '.') continue;
          if (token === '-') throw new Error(where(track, 'a "-" tie has nothing to extend'));
          let cells = 1;
          while (tokens[i + cells] === '-') cells++;
          events.push({ step: i, cells, token });
          i += cells - 1;
        }
        for (const region of regions) {
          loop(region, tokens.length, grid, (i, at) => {
            const event = events.find((e) => e.step === i);
            if (!event) return;
            const duration = Math.min(event.cells * grid, region.end - at, contentEnd - at);
            if (duration <= 0.01) return;
            const played = pitchOf(track, event.token, at);
            notes.push({ at, duration, midi: played.midi, velocity: shaped(i, grid), drum: played.drum, source: 'pattern' });
          });
        }
      }
    }

    const spans = timelines.get(track.id) ?? [];
    track.chords.forEach((entry, order) => {
      const style = entry.style;
      const mine = spans.filter((s) => s.order === order);
      const sounding = (at: number) => mine.find((s) => at >= s.start - 1e-6 && at < s.end - 1e-8);
      if (style === 'pad' || style === 'block' || style === 'strum') {
        for (const span of mine) {
          const hold = style === 'block' ? 0.9 : 1;
          span.voices.forEach((midi, index) => {
            const delay = style === 'strum' ? index * 0.018 : 0;
            const at = span.start + delay;
            const duration = Math.min(Math.max(0.05, (span.end - span.start) * hold - delay), contentEnd - at);
            if (duration > 0.02) notes.push({ at, duration, midi, velocity: style === 'pad' ? 0.55 : 0.72, source: 'chord' });
          });
        }
        return;
      }
      const grid = gridOf('1/16', where(track, 'rhythm'));
      const rhythm = entry.rhythm ? cleanSteps(entry.rhythm) : '';
      for (const ch of rhythm) if (ch !== '.') checkStepChar(ch, where(track, 'rhythm'));
      for (const region of regionsOf(entry.in, where(track, 'chords'))) {
        if (rhythm) {
          let arp = 0;
          loop(region, rhythm.length, grid, (i, at) => {
            const ch = rhythm[i];
            if (ch === '.') return;
            const span = sounding(at);
            if (!span) return;
            const velocity = STEP_VELOCITY[ch];
            if (style === 'stab') {
              for (const midi of span.voices) notes.push({ at, duration: Math.min(grid * 1.5, 0.18, contentEnd - at), midi, velocity, source: 'chord' });
            } else {
              const line = arpOrder(span.voices, style);
              notes.push({ at, duration: Math.min(grid * 0.9, contentEnd - at), midi: line[arp % line.length], velocity, source: 'chord' });
              arp++;
            }
          });
        } else if (style === 'stab') {
          for (const span of mine) {
            if (span.start < region.start - 1e-6 || span.start >= region.end - 1e-6) continue;
            for (const midi of span.voices) {
              notes.push({ at: span.start, duration: Math.min(0.18, span.end - span.start, contentEnd - span.start), midi, velocity: 0.85, source: 'chord' });
            }
          }
        } else {
          const eighth = tempo ? durationSeconds('1/8', tempo, 'arp') : 0.25;
          let arp = 0;
          for (let at = region.start; at < region.end - 1e-6; at += eighth) {
            const span = sounding(at);
            if (!span) continue;
            const line = arpOrder(span.voices, style);
            notes.push({ at, duration: Math.min(eighth * 0.9, contentEnd - at), midi: line[arp % line.length], velocity: shaped(arp, eighth), source: 'chord' });
            arp++;
          }
        }
      }
    });

    const typeCount = new Map<SfxName, number>();
    for (const e of track.sfx) typeCount.set(e.type, (typeCount.get(e.type) ?? 0) + (Array.isArray(e.at) ? e.at.length : 1));
    const typeIndex = new Map<SfxName, number>();
    for (const e of track.sfx) {
      const times = Array.isArray(e.at) ? e.at : [e.at];
      const duration = lengthOf(e.duration, where(track, `${e.type} duration`), SFX_DURATION[e.type]);
      for (const raw of times) {
        const at = resolveTime(raw, where(track, e.type));
        const index = typeIndex.get(e.type) ?? 0;
        typeIndex.set(e.type, index + 1);
        const varied = (typeCount.get(e.type) ?? 0) > 1;
        const rand = rng((score.seed ^ hash(track.id) ^ hash(e.type) ^ index) >>> 0);
        const pitch = e.pitch + (varied ? (rand() - 0.5) * 2 : 0);
        const brightness = Math.min(1, Math.max(0, e.brightness + (varied ? (rand() - 0.5) * 0.1 : 0)));
        const start = at - SFX_ANCHOR[e.type] * duration;
        if (start < -0.02) {
          issues.push({
            code: 'sfx-clipped',
            track: track.id,
            message: `${track.id}: ${e.type} is anchored at ${at.toFixed(2)}s but the sound starts ${(-start).toFixed(2)}s before 0, so the beginning is cut off`,
          });
        }
        sfx.push({
          type: e.type, at, start, duration, size: e.size, pan: e.pan, brightness, pitch, direction: e.direction,
        });
      }
    }

    const clips: CompiledClip[] = track.clips.map((clip) => {
      const known = opts.clipLengths?.[clip.src];
      const duration = clip.duration !== undefined
        ? lengthOf(clip.duration, where(track, `clip ${clip.src}`), 0)
        : known !== undefined ? Math.max(0, known - clip.offset) : undefined;
      return {
        src: clip.src,
        at: resolveTime(clip.at, where(track, `clip ${clip.src}`)),
        offset: clip.offset,
        duration,
        loop: clip.loop,
        gain: clip.gain,
        fadeIn: clip.fadeIn,
        fadeOut: clip.fadeOut,
      };
    });

    if (key && info?.kind !== 'drums') {
      const outside = notes.filter((n) => !n.drum && !inKey(n.midi, key));
      if (outside.length) {
        issues.push({
          code: 'out-of-key',
          track: track.id,
          message: `${track.id}: ${outside.length} note${outside.length === 1 ? '' : 's'} outside ${key.name} (${preview(outside)})`,
        });
      }
    }
    if (info && info.kind !== 'drums') {
      const out = notes.filter((n) => n.midi < info.range[0] || n.midi > info.range[1]);
      if (out.length) {
        issues.push({
          code: 'out-of-range',
          track: track.id,
          message: `${track.id}: ${out.length} note${out.length === 1 ? '' : 's'} outside ${track.instrument} (${midiToName(info.range[0])}–${midiToName(info.range[1])}): ${preview(out)}`,
        });
      }
    }
    const played = notes.filter((n) => n.source === 'note' || n.source === 'drums');
    if (played.length >= 8) {
      const lo = Math.min(...played.map((n) => n.velocity));
      const hi = Math.max(...played.map((n) => n.velocity));
      if (hi - lo < 0.05) {
        const hint = played.some((n) => n.drum)
          ? 'Use X for accents and g for ghosts'
          : 'Vary velocity so the line has a shape';
        issues.push({
          code: 'flat-velocity',
          track: track.id,
          message: `${track.id}: all ${played.length} hits use the same velocity (${played[0].velocity.toFixed(2)}). ${hint}`,
        });
      }
    }

    const auto = (track.duck === 'auto' || track.duck === undefined) && track.role === 'music' && hasVoice;
    const duck = auto
      ? { auto: true, amount: 0.55, release: 0.28 }
      : track.duck && typeof track.duck === 'object'
        ? { by: track.duck.by, amount: track.duck.amount, release: track.duck.release }
        : undefined;

    compiledTracks.push({
      source: track,
      id: track.id,
      role: track.role,
      instrument: track.instrument,
      gain: (info?.gain ?? (track.role === 'sfx' ? 2 : 0)) + track.gain,
      pan: track.pan ?? info?.pan ?? 0,
      brightness: track.brightness,
      space: track.space ?? info?.space ?? (track.role === 'sfx' ? 0.3 : 0),
      vocalDip: duck?.auto ? info?.vocalDip ?? 0 : 0,
      lowCut: info?.lowCut,
      tail: info?.tail ?? (track.sfx.length ? 1 : 0.2),
      duck,
      notes,
      sfx,
      clips,
    });
  }

  const hits = compiledTracks.flatMap((t) => t.sfx.map((e) => ({ ...e, track: t.id })));
  hits.sort((a, b) => a.at - b.at);
  // A riser that lands on an impact is one gesture. Crowding is two short effects,
  // or the same effect twice, close enough to sound like a mistake.
  const short = new Set(['impact', 'boom', 'hit', 'pop', 'click', 'tick', 'type', 'chime']);
  for (let i = 1; i < hits.length; i++) {
    const gap = hits[i].at - hits[i - 1].at;
    const same = hits[i].type === hits[i - 1].type;
    const bothShort = short.has(hits[i].type) && short.has(hits[i - 1].type);
    if ((same && gap < 0.08) || (bothShort && gap < 0.05)) {
      issues.push({
        code: 'dense-sfx',
        message: `sfx are crowded: ${hits[i - 1].type} at ${hits[i - 1].at.toFixed(2)}s and ${hits[i].type} at ${hits[i].at.toFixed(2)}s are ${gap.toFixed(2)}s apart`,
      });
      break;
    }
  }

  return {
    sampleRate: score.sampleRate,
    seed: score.seed,
    contentEnd,
    fixedDuration: score.duration,
    mix: score.mix,
    tracks: compiledTracks,
    issues,
    key,
    tempo,
  };
}

/** Later chord entries replace earlier ones where they overlap. */
function resolveOverlaps(spans: Span[]): Span[] {
  if (!spans.length) return [];
  const points = [...new Set(spans.flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b);
  const out: Span[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (b - a < 1e-6) continue;
    const mid = (a + b) / 2;
    const win = spans.filter((s) => s.start <= mid && mid < s.end).reduce<Span | undefined>((best, s) => (!best || s.order >= best.order ? s : best), undefined);
    if (!win) continue;
    const prev = out[out.length - 1];
    if (prev && prev.chord === win.chord && prev.voices === win.voices && Math.abs(prev.end - a) < 1e-6) prev.end = b;
    else out.push({ ...win, start: a, end: b });
  }
  return out;
}

function arpOrder(voices: number[], style: string): number[] {
  const low = [...voices].sort((a, b) => a - b);
  if (style === 'arp-down') return low.slice().reverse();
  if (style === 'arp-updown') {
    if (low.length <= 1) return low;
    return low.concat(low.slice(1, -1).reverse());
  }
  return low;
}

function preview(notes: CompiledNote[]): string {
  const shown = notes.slice(0, 4).map((n) => `${midiToName(n.midi)} at ${n.at.toFixed(2)}s`);
  const more = notes.length - shown.length;
  return shown.join(', ') + (more > 0 ? `, and ${more} more` : '');
}
