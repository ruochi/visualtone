/**
 * Time, pitch, keys and chords for score v2.
 * Bars and beats are 1-based, matching a DAW.
 */

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LETTERS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** Major-scale semitones for degrees 1–7. */
const MAJOR = [0, 2, 4, 5, 7, 9, 11];

export function toMidi(pitch: number | string): number {
  if (typeof pitch === 'number') return pitch;
  const m = /^([A-G])([#b]?)(-?\d+)$/.exec(pitch);
  if (!m) throw new Error(`invalid note name "${pitch}" (use C4, F#3, Bb2)`);
  return LETTERS[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
}

export function midiToName(midi: number): string {
  const n = Math.round(midi);
  const pc = ((n % 12) + 12) % 12;
  return NAMES[pc] + (Math.floor(n / 12) - 1);
}

export function isNoteName(pitch: string): boolean {
  return /^[A-G][#b]?-?\d+$/.test(pitch);
}

/** Chord degree: 1, b3, #4, 8, b7. Not a note name (those start with a letter). */
export function isDegree(token: string): boolean {
  return /^[#b]+\d+$/.test(token) || /^[1-9]\d?$/.test(token);
}

export interface Tempo {
  bpm: number;
  meter: string;
  /** Beats in a bar (the numerator). */
  beatsPerBar: number;
  /** Beat unit as a fraction of a whole note: 4 means a quarter note. */
  denominator: number;
  /** Seconds in one beat. */
  beatSec: number;
  /** Seconds in a quarter note. */
  quarterSec: number;
  /** Delay added to odd 16ths, as a fraction of a 16th (0 = straight). */
  swing: number;
}

export function parseMeter(meter: string): { beatsPerBar: number; denominator: number } {
  const m = /^(\d+)\/(\d+)$/.exec(meter);
  if (!m) throw new Error(`meter "${meter}" must look like "4/4"`);
  return { beatsPerBar: Number(m[1]), denominator: Number(m[2]) };
}

export function makeTempo(bpm: number, meter: string, swing = 0): Tempo {
  const { beatsPerBar, denominator } = parseMeter(meter);
  const beatSec = 60 / bpm;
  return { bpm, meter, beatsPerBar, denominator, beatSec, quarterSec: beatSec * (denominator / 4), swing };
}

/** Musical offset of bar:beat from a downbeat, in seconds. Bar and beat are 1-based. */
export function barBeatSeconds(bar: number, beat: number, tempo: Tempo, label: string): number {
  if (bar < 1) throw new Error(`${label}: bar ${bar} is out of range; bars start at 1`);
  if (beat < 1 || beat > tempo.beatsPerBar) {
    throw new Error(`${label}: beat ${beat} is outside ${tempo.meter} (beats are 1–${tempo.beatsPerBar})`);
  }
  return ((bar - 1) * tempo.beatsPerBar + (beat - 1)) * tempo.beatSec;
}

/**
 * Extra delay for a step that lands on an odd 16th.
 * `straightSec` is the unswung offset from the region start.
 */
export function swingDelay(straightSec: number, tempo: Tempo | undefined): number {
  if (!tempo || tempo.swing === 0) return 0;
  const sixteenth = tempo.quarterSec / 4;
  const index = straightSec / sixteenth;
  const nearest = Math.round(index);
  if (nearest % 2 === 1 && Math.abs(index - nearest) < 1e-6) return tempo.swing * sixteenth;
  return 0;
}

/** "1/8", "1/4.", "2bar", or a number of seconds. */
export function durationSeconds(value: number | string, tempo: Tempo | undefined, label: string): number {
  if (typeof value === 'number') {
    if (!(value > 0)) throw new Error(`${label}: duration must be > 0 seconds`);
    return value;
  }
  const bars = /^(\d+)bars?$/.exec(value);
  if (bars) {
    if (!tempo) throw new Error(`${label}: "${value}" needs a tempo`);
    return Number(bars[1]) * tempo.beatsPerBar * tempo.beatSec;
  }
  const note = /^(\d+)\/(\d+)(\.)?$/.exec(value);
  if (note) {
    if (!tempo) throw new Error(`${label}: "${value}" needs a tempo`);
    const quarters = (4 * Number(note[1])) / Number(note[2]);
    return quarters * tempo.quarterSec * (note[3] ? 1.5 : 1);
  }
  throw new Error(`${label}: invalid duration "${value}". Use seconds, "1/8", "1/4.", or "2bar"`);
}

export interface ParsedKey {
  name: string;
  root: number;
  /** Pitch classes treated as inside the key. */
  pitchClasses: Set<number>;
}

const MODE_OFFSETS: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  // Natural, harmonic and melodic minor: both 6ths and both 7ths.
  minor: [0, 2, 3, 5, 7, 8, 9, 10, 11],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
};

function makeKey(letter: string, acc: string, mode: string, label: string): ParsedKey {
  const root = LETTERS[letter] + (acc === '#' ? 1 : acc === 'b' ? -1 : 0);
  const pc = ((root % 12) + 12) % 12;
  const pitchClasses = new Set(MODE_OFFSETS[mode].map((d) => (pc + d) % 12));
  return { name: label, root: pc, pitchClasses };
}

/** "E minor", "C major", and the short forms models write: "Em", "F#m", "Bb" (major). */
export function parseKey(name: string): ParsedKey {
  const full = /^([A-G])([#b]?) (major|minor|ionian|aeolian|dorian|phrygian|lydian|mixolydian|locrian)$/.exec(name);
  if (full) return makeKey(full[1], full[2], full[3], name);
  const short = /^([A-G])([#b]?)(m|min|minor)?$/.exec(name);
  if (short) {
    const mode = short[3] ? 'minor' : 'major';
    return makeKey(short[1], short[2], mode, `${short[1]}${short[2]} ${mode}`);
  }
  throw new Error(`key "${name}" must look like "E minor", "Em", "C major" or "Bb"`);
}

export function inKey(midi: number, key: ParsedKey): boolean {
  return key.pitchClasses.has(((Math.round(midi) % 12) + 12) % 12);
}

export interface ParsedChord {
  symbol: string;
  /** Pitch class of the root. */
  root: number;
  /** Pitch class of a slash bass, if any. */
  bass?: number;
  /** Semitones from the root for scale degrees the chord defines. */
  members: Partial<Record<1 | 3 | 5 | 7 | 9, number>>;
  /** Intervals to put in a voicing, semitones from the root (may exceed 12). */
  voicing: number[];
}

interface Quality {
  third?: number;
  fifth?: number;
  seventh?: number;
  ninth?: number;
  eleventh?: number;
  thirteenth?: number;
  /** Extra interval kept in the voicing (the 6th of a 6 chord). */
  color?: number;
  /** Drop the fifth when a color tone needs the slot. */
  omitFifth?: boolean;
  /** Root, third, sixth and ninth. The seventh stays on `members` so degree 7 still resolves. */
  sixNine?: boolean;
}

const QUALITIES: Record<string, Quality> = {
  '': { third: 4, fifth: 7, seventh: 11 },
  maj: { third: 4, fifth: 7, seventh: 11 },
  M: { third: 4, fifth: 7, seventh: 11 },
  m: { third: 3, fifth: 7, seventh: 10 },
  min: { third: 3, fifth: 7, seventh: 10 },
  '-': { third: 3, fifth: 7, seventh: 10 },
  dim: { third: 3, fifth: 6, seventh: 10 },
  aug: { third: 4, fifth: 8, seventh: 10 },
  '+': { third: 4, fifth: 8, seventh: 10 },
  sus2: { third: 2, fifth: 7, seventh: 10 },
  sus4: { third: 5, fifth: 7, seventh: 10 },
  sus: { third: 5, fifth: 7, seventh: 10 },
  '5': { fifth: 7, seventh: 10 },
  '6': { third: 4, fifth: 7, seventh: 11, color: 9 },
  m6: { third: 3, fifth: 7, seventh: 10, color: 9 },
  '7': { third: 4, fifth: 7, seventh: 10 },
  maj7: { third: 4, fifth: 7, seventh: 11 },
  M7: { third: 4, fifth: 7, seventh: 11 },
  m7: { third: 3, fifth: 7, seventh: 10 },
  min7: { third: 3, fifth: 7, seventh: 10 },
  '-7': { third: 3, fifth: 7, seventh: 10 },
  dim7: { third: 3, fifth: 6, seventh: 9 },
  m7b5: { third: 3, fifth: 6, seventh: 10 },
  min7b5: { third: 3, fifth: 6, seventh: 10 },
  aug7: { third: 4, fifth: 8, seventh: 10 },
  '9': { third: 4, fifth: 7, seventh: 10, ninth: 14, omitFifth: true },
  maj9: { third: 4, fifth: 7, seventh: 11, ninth: 14, omitFifth: true },
  m9: { third: 3, fifth: 7, seventh: 10, ninth: 14, omitFifth: true },
  add9: { third: 4, fifth: 7, seventh: 11, ninth: 14 },
  madd9: { third: 3, fifth: 7, seventh: 10, ninth: 14 },
  '7b9': { third: 4, fifth: 7, seventh: 10, ninth: 13, omitFifth: true },
  '7#9': { third: 4, fifth: 7, seventh: 10, ninth: 15, omitFifth: true },
};

const QUALITY_NAMES = Object.keys(QUALITIES).filter(Boolean).sort((a, b) => b.length - a.length);

function pitchClass(letter: string): number {
  const name = letter[0].toUpperCase() + letter.slice(1);
  const pc = LETTERS[name[0]] + (name[1] === '#' ? 1 : name[1] === 'b' ? -1 : 0);
  return (pc + 12) % 12;
}

function canonQuality(name: string): string {
  return name.replace(/^(Maj|MAJ)/, 'maj').replace(/^(Min|MIN)/, 'min');
}

/** Extensions and alterations the quality table does not list, such as maj13#11 and 6/9. */
function resolveQuality(raw: string): Quality | undefined {
  const name = canonQuality(raw);
  const known = QUALITIES[name];
  if (known) return known;
  if (name === '6/9' || name === '69') return { third: 4, fifth: 7, seventh: 11, ninth: 14, color: 9, sixNine: true };
  if (name === 'm6/9' || name === 'min6/9' || name === 'm69') {
    return { third: 3, fifth: 7, seventh: 10, ninth: 14, color: 9, sixNine: true };
  }

  let rest = name;
  const alts: { sign: number; deg: number }[] = [];
  for (;;) {
    const found = /([#b])(5|9|11|13)$/.exec(rest);
    if (!found) break;
    alts.unshift({ sign: found[1] === '#' ? 1 : -1, deg: Number(found[2]) });
    rest = rest.slice(0, found.index);
  }
  const base = QUALITIES[rest] ?? extensionQuality(rest);
  if (!base) return undefined;
  const quality = { ...base };
  for (const alt of alts) {
    if (alt.deg === 5) quality.fifth = 7 + alt.sign;
    if (alt.deg === 9) quality.ninth = 14 + alt.sign;
    if (alt.deg === 11) quality.eleventh = 17 + alt.sign;
    if (alt.deg === 13) quality.thirteenth = 21 + alt.sign;
  }
  return quality;
}

function extensionQuality(rest: string): Quality | undefined {
  const m = /^(maj|min|m|M|-|dim|aug|\+|sus2|sus4|sus)?(13|11|9|7|6)?$/.exec(rest);
  if (!m?.[2]) return undefined;
  const qual = m[1] ?? '';
  const ext = Number(m[2]);
  const folded = qual.toLowerCase();
  const minor = folded === 'm' || folded === 'min' || qual === '-';
  const dim = folded === 'dim';
  const aug = folded === 'aug' || qual === '+';
  const majorSeventh = folded === 'maj' || qual === 'M';
  const quality: Quality = {
    third: minor || dim ? 3 : 4,
    fifth: dim ? 6 : aug ? 8 : 7,
    seventh: dim ? 9 : majorSeventh ? 11 : 10,
  };
  if (ext === 6) {
    quality.color = 9;
    quality.seventh = minor ? 10 : 11;
    return quality;
  }
  if (ext >= 9) quality.ninth = 14;
  if (ext >= 11) quality.eleventh = 17;
  if (ext >= 13) quality.thirteenth = 21;
  return quality;
}

export function parseChord(symbol: string): ParsedChord {
  const parts = symbol.split('/');
  let head = symbol;
  let bass: number | undefined;
  // "C/E" is a slash bass. "C6/9" is a sixth plus a ninth: the right side is not a note name.
  if (parts.length === 2 && /^[A-Ga-g][#b]?$/.test(parts[1])) {
    head = parts[0];
    bass = pitchClass(parts[1]);
  } else if (parts.length > 2) {
    throw new Error(`invalid chord "${symbol}" (examples: Em7, A7, Dmaj7, C6/9, C/E)`);
  }
  const m = /^([A-Ga-g][#b]?)(.*)$/.exec(head);
  if (!m) throw new Error(`invalid chord "${symbol}" (examples: Em7, A7, Dmaj7, C6/9)`);
  const qualityName = m[2];
  const quality = resolveQuality(qualityName);
  if (!quality) {
    const near = QUALITY_NAMES.find((q) => q.toLowerCase() === qualityName.toLowerCase());
    throw new Error(
      `invalid chord "${symbol}"${near ? `; did you mean ${m[1][0].toUpperCase()}${m[1].slice(1)}${near}?` : '. Examples: Em7, A7, Dmaj7, C6/9, Dmaj13#11'}`,
    );
  }
  const members: ParsedChord['members'] = { 1: 0, 5: quality.fifth ?? 7 };
  if (quality.third !== undefined) members[3] = quality.third;
  if (quality.seventh !== undefined) members[7] = quality.seventh;
  if (quality.ninth !== undefined) members[9] = quality.ninth;
  return { symbol, root: pitchClass(m[1]), bass, members, voicing: voicingIntervals(qualityName, quality) };
}

const TRIADS = new Set(['', 'maj', 'M', 'm', 'min', '-', 'dim', 'aug', '+', 'sus2', 'sus4', 'sus', '5']);

/** Up to four intervals that make up the played voicing. Triads stay triads. */
function voicingIntervals(name: string, q: Quality): number[] {
  if (q.sixNine && q.third !== undefined && q.ninth !== undefined) return [0, q.third, 9, q.ninth];
  if ((name === 'add9' || name === 'madd9') && q.third !== undefined && q.fifth !== undefined && q.ninth !== undefined) {
    return [0, q.third, q.fifth, q.ninth];
  }
  if (q.thirteenth !== undefined && q.eleventh !== undefined && q.seventh !== undefined) {
    return [0, q.seventh, q.eleventh, q.thirteenth];
  }
  if (q.thirteenth !== undefined && q.seventh !== undefined) return [0, q.seventh, q.ninth ?? 14, q.thirteenth];
  if (q.eleventh !== undefined && q.seventh !== undefined) {
    if (q.ninth !== undefined) return [0, q.seventh, q.ninth, q.eleventh];
    if (q.third !== undefined) return [0, q.third, q.seventh, q.eleventh];
  }
  const tones = [0];
  if (q.third !== undefined) tones.push(q.third);
  if (q.ninth !== undefined) {
    if (q.seventh !== undefined) tones.push(q.seventh);
    tones.push(q.ninth);
  } else if (q.color !== undefined) {
    if (q.fifth !== undefined) tones.push(q.fifth);
    tones.push(q.color);
  } else if (!TRIADS.has(name) && q.seventh !== undefined) {
    if (q.fifth !== undefined) tones.push(q.fifth);
    tones.push(q.seventh);
  } else if (q.fifth !== undefined) tones.push(q.fifth);
  return unique(tones).slice(0, 4);
}

function unique(xs: number[]): number[] {
  const out: number[] = [];
  for (const x of xs) if (!out.includes(x)) out.push(x);
  return out;
}

export function parseProgression(text: string): ParsedChord[] {
  const tokens = text
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t && t !== '|');
  if (!tokens.length) throw new Error('chord progression is empty');
  return tokens.map(parseChord);
}

/**
 * Semitones from the chord root.
 * Plain 1, 3, 5, 7 (and their octaves) use the chord's own tones.
 * Accidentals (b7, #4) are measured from the major scale, so they stay put when the chord changes.
 */
export function degreeToSemitones(token: string, chord: ParsedChord): number {
  const m = /^([#b]*)(\d+)$/.exec(token);
  if (!m) throw new Error(`invalid degree "${token}"`);
  const n = Number(m[2]);
  if (n < 1 || n > 15) throw new Error(`degree "${token}" is out of range (1–15)`);
  const klass = (((n - 1) % 7) + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
  const octave = Math.floor((n - 1) / 7) * 12;
  if (!m[1]) {
    if (klass === 1) return octave;
    if (klass === 3 && chord.members[3] !== undefined) return chord.members[3] + octave;
    if (klass === 5 && chord.members[5] !== undefined) return chord.members[5] + octave;
    if (klass === 7 && chord.members[7] !== undefined) return chord.members[7] + octave;
    if (klass === 2 && n >= 9 && chord.members[9] !== undefined) return chord.members[9] + (octave - 12);
  }
  let semi = MAJOR[klass - 1] + octave;
  for (const c of m[1]) semi += c === '#' ? 1 : -1;
  return semi;
}

/** Midi note of a degree, with the root parked on the octave nearest `center`. */
export function degreeToMidi(token: string, chord: ParsedChord, center: number): number {
  const root = nearestPitch(chord.root, center);
  return root + degreeToSemitones(token, chord);
}

export function nearestPitch(pitchClass: number, center: number): number {
  const pc = ((pitchClass % 12) + 12) % 12;
  const base = Math.round((center - pc) / 12) * 12 + pc;
  let best = base;
  for (const m of [base - 12, base, base + 12]) {
    if (Math.abs(m - center) < Math.abs(best - center)) best = m;
  }
  return best;
}

export type VoicingName = 'close' | 'open' | 'spread';

/** Stack absolute pitch classes upward from a bass midi note. */
function stack(pcs: number[], bassMidi: number): number[] {
  const bassPc = ((bassMidi % 12) + 12) % 12;
  const at = pcs.indexOf(bassPc);
  const order = at > 0 ? pcs.slice(at).concat(pcs.slice(0, at)) : pcs;
  const rest = at >= 0 ? order.slice(1) : order;
  const voices = [bassMidi];
  for (const pc of rest) {
    let v = bassMidi + ((pc - bassPc + 12) % 12);
    if (v <= voices[voices.length - 1]) v += 12;
    voices.push(v);
  }
  return voices;
}

/**
 * Place a chord around `center`. When `prev` is set, pick the inversion
 * whose voices move the least, and prefer notes inside `range`.
 */
export function voiceChord(
  chord: ParsedChord,
  center: number,
  voicing: VoicingName,
  prev: number[] | null,
  range?: [number, number],
): number[] {
  const intervals = chord.voicing.length ? chord.voicing : [0, 4, 7];
  const pcs = unique(intervals.map((i) => (((chord.root + i) % 12) + 12) % 12));
  const options: number[][] = [];
  const basses = chord.bass === undefined ? pcs : [chord.bass];
  for (const bassPc of basses) {
    const near = nearestPitch(bassPc, center);
    for (const oct of [-2, -1, 0, 1, 2]) {
      let voices = stack(pcs, near + oct * 12);
      if (voicing === 'open' && voices.length >= 3) {
        voices = voices.slice();
        voices[voices.length - 2] -= 12;
        voices.sort((a, b) => a - b);
      } else if (voicing === 'spread') {
        voices = voices.slice();
        voices[0] -= 12;
        if (voices.length > 2) voices[voices.length - 1] += 12;
        voices.sort((a, b) => a - b);
      }
      options.push(voices);
    }
  }
  const score = (voices: number[]) => {
    let s = 0;
    if (prev && prev.length) {
      const n = Math.max(voices.length, prev.length);
      for (let i = 0; i < n; i++) {
        s += Math.abs((voices[i] ?? voices[voices.length - 1]) - (prev[i] ?? prev[prev.length - 1]));
      }
    } else {
      for (const m of voices) s += Math.abs(m - center);
      const span = voices[voices.length - 1] - voices[0];
      if (voicing === 'close' && span > 12) s += (span - 12) * 2;
    }
    if (range) {
      for (const m of voices) if (m < range[0] || m > range[1]) s += 80;
    }
    return s;
  };
  return options.reduce((best, o) => (score(o) < score(best) ? o : best));
}
