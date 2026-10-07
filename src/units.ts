/** Musical spelling expanded to seconds and MIDI before render. Not part of the audio model. */

export interface LoosePoint {
  t?: number;
  at?: string;
  y?: number;
  pitch?: string;
  size: number;
  lightness?: number;
  ease?: string;
  tween?: number;
}

export interface LooseNote extends LoosePoint {
  duration?: number;
  len?: string;
}

export interface LooseSfx {
  t?: number;
  at?: string;
  duration?: number;
  len?: string;
  pitch?: string;
  y?: number;
}

export interface LooseScore {
  bpm?: number;
  meter?: [number, number];
  tracks: {
    points?: LoosePoint[];
    notes?: LooseNote[];
    sfx?: LooseSfx[];
  }[];
}

const SEMI: Record<string, number> = {
  C: 0,
  'C#': 1,
  DB: 1,
  D: 2,
  'D#': 3,
  EB: 3,
  E: 4,
  F: 5,
  'F#': 6,
  GB: 6,
  G: 7,
  'G#': 8,
  AB: 8,
  A: 9,
  'A#': 10,
  BB: 10,
  B: 11,
};

/** "A3" -> MIDI. C4 is 60. */
export function parsePitch(name: string): number {
  const m = name.trim().match(/^([A-Ga-g])([#bB])?(-?\d+)$/);
  if (!m) throw new Error(`无法识别音名 "${name}"，例如 A3、Bb2`);
  const letter = m[1].toUpperCase();
  const acc = m[2] ? (m[2].toLowerCase() === 'b' ? 'B' : '#') : '';
  const key = letter + acc;
  const semi = SEMI[key];
  if (semi === undefined) throw new Error(`无法识别音名 "${name}"`);
  const oct = Number(m[3]);
  return (oct + 1) * 12 + semi;
}

/** "1/8" -> seconds. bpm is quarter notes per minute, so a whole note is 4 beats. */
export function parseLen(len: string, bpm: number): number {
  const m = len.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) throw new Error(`无法识别时值 "${len}"，例如 1/8`);
  const beats = (4 * Number(m[1])) / Number(m[2]);
  return beats * (60 / bpm);
}

/**
 * "4:2" -> seconds. Bar and beat are 1-based.
 * meter is [beats per bar, beat unit]; [4, 4] means a beat is a quarter note.
 */
export function parseAt(at: string, bpm: number, meter: [number, number] = [4, 4]): number {
  const m = at.trim().match(/^(\d+)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (!m) throw new Error(`无法识别位置 "${at}"，应写成 小节:拍，例如 4:2`);
  const bar = Number(m[1]);
  const beat = Number(m[2]);
  if (bar < 1 || beat < 1) throw new Error(`位置 "${at}" 从 1 起算`);
  const beatSec = (60 / bpm) * (4 / meter[1]);
  const barSec = meter[0] * beatSec;
  return (bar - 1) * barSec + (beat - 1) * beatSec;
}

function requireBpm(bpm: number | undefined): number {
  if (!bpm || bpm <= 0) throw new Error('乐谱使用了小节、音名或时值写法，需要 bpm');
  return bpm;
}

function expandPoint<T extends LoosePoint>(p: T, bpm: number | undefined, meter: [number, number]): T {
  const next = { ...p };
  if (p.at !== undefined) {
    next.t = parseAt(p.at, requireBpm(bpm), meter);
    delete next.at;
  }
  if (p.pitch !== undefined) {
    next.y = parsePitch(p.pitch);
    delete next.pitch;
  }
  if (next.t === undefined || next.y === undefined) {
    throw new Error('点缺少时间或音高');
  }
  return next;
}

function expandNote<T extends LooseNote>(n: T, bpm: number | undefined, meter: [number, number]): T {
  const next = expandPoint(n, bpm, meter);
  if (n.len !== undefined) {
    next.duration = parseLen(n.len, requireBpm(bpm));
    delete next.len;
  }
  if (next.duration === undefined || next.duration <= 0) throw new Error('音符缺少时值');
  return next;
}

function expandSfxEvent<T extends LooseSfx>(e: T, bpm: number | undefined, meter: [number, number]): T {
  const next = { ...e };
  if (e.at !== undefined) {
    next.t = parseAt(String(e.at), requireBpm(bpm), meter);
    delete next.at;
  }
  if (e.len !== undefined) {
    next.duration = parseLen(String(e.len), requireBpm(bpm));
    delete next.len;
  }
  if (e.pitch !== undefined) {
    next.y = parsePitch(String(e.pitch));
    delete next.pitch;
  }
  if (next.t === undefined) throw new Error('音效缺少时间');
  return next;
}

/** Fill t/y/duration from at/pitch/len. Idempotent once those fields are gone. */
export function expandUnits<T extends LooseScore>(score: T): T {
  const meter = score.meter ?? [4, 4];
  const tracks = score.tracks.map((track) => ({
    ...track,
    points: track.points?.map((p) => expandPoint(p, score.bpm, meter)),
    notes: track.notes?.map((n) => expandNote(n, score.bpm, meter)),
    sfx: track.sfx?.map((e) => expandSfxEvent(e, score.bpm, meter)),
  }));
  return { ...score, tracks };
}

const CHORD_QUALITY: Record<string, number[]> = {
  '': [0, 4, 7],
  maj: [0, 4, 7],
  M: [0, 4, 7],
  m: [0, 3, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  '7': [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  M7: [0, 4, 7, 11],
  m7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  add9: [0, 4, 7, 14],
  '9': [0, 4, 7, 10, 14],
  m9: [0, 3, 7, 10, 14],
};

/** MIDI notes of a chord. chord("Am7", "A3") places the root at A3. */
export function chord(symbol: string, rootPitch: string): number[] {
  const m = symbol.trim().match(/^([A-Ga-g][#bB]?)(.*)$/);
  if (!m) throw new Error(`无法识别和弦 "${symbol}"`);
  const oct = rootPitch.match(/(-?\d+)$/)?.[1];
  if (oct === undefined) throw new Error(`和弦根音需要八度，例如 A3，收到 "${rootPitch}"`);
  const root = parsePitch(m[1] + oct);
  const quality = CHORD_QUALITY[m[2]];
  if (!quality) throw new Error(`不认识的和弦性质 "${m[2]}"`);
  return quality.map((semi) => root + semi);
}

export interface PatternOptions {
  /** 1-based bar the pattern starts on. */
  bar?: number;
  /** Grid step, default 1/16. */
  step?: string;
  y: number;
  size?: number;
  /** Seconds. Default is just under one step, capped at 150 ms. */
  duration?: number;
  bpm: number;
  meter?: [number, number];
  ease?: 'hold' | 'exp';
}

/** "x...x...x.x." -> notes. x is a hit, . or - is a rest. */
export function pattern(grid: string, opts: PatternOptions): {
  t: number;
  y: number;
  size: number;
  duration: number;
  ease: 'hold' | 'exp';
}[] {
  const step = opts.step ?? '1/16';
  const stepSec = parseLen(step, opts.bpm);
  const origin = parseAt(`${opts.bar ?? 1}:1`, opts.bpm, opts.meter ?? [4, 4]);
  const notes = [];
  const chars = grid.replace(/[|\s]/g, '');
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '.' || ch === '-') continue;
    if (ch !== 'x' && ch !== 'X') throw new Error(`节奏型里不认识的符号 "${ch}"，用 x 和 .`);
    notes.push({
      t: origin + i * stepSec,
      y: opts.y,
      size: opts.size ?? 0.8,
      duration: opts.duration ?? Math.min(stepSec * 0.45, 0.15),
      ease: opts.ease ?? 'exp',
    });
  }
  return notes;
}
