import { Biquad } from '../mix.js';
import type { Score } from '../schema.js';
import { trackClips } from '../schema.js';
import type { MaskingReport } from './masking.js';

export function roleOf(score: Score | undefined, id: string): 'voice' | 'sfx' | 'music' | undefined {
  const track = score?.tracks.find((t) => t.id === id);
  if (track?.role === 'voice' || track?.role === 'sfx' || track?.role === 'music') return track.role;
  return undefined;
}

function mixMono(stems: { l: Float32Array; r: Float32Array }[]): Float32Array | null {
  if (stems.length === 0) return null;
  const n = stems[0].l.length;
  const out = new Float32Array(n);
  for (const s of stems) {
    for (let i = 0; i < n; i++) out[i] += (s.l[i] + s.r[i]) * 0.5;
  }
  return out;
}

/** RMS of 1–4 kHz in hops of `hop` samples. */
function presenceEnvelope(mono: Float32Array, sampleRate: number, hop: number): Float32Array {
  const hp = new Biquad('highpass', sampleRate, 1000);
  const lp = new Biquad('lowpass', sampleRate, 4000);
  const frames = Math.ceil(mono.length / hop);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const a = f * hop;
    const b = Math.min(mono.length, a + hop);
    for (let i = a; i < b; i++) {
      const v = lp.process(hp.process(mono[i]));
      sum += v * v;
    }
    out[f] = Math.sqrt(sum / Math.max(1, b - a));
  }
  return out;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function sfxEventTimes(score: Score): number[] {
  const times: number[] = [];
  for (const t of score.tracks) {
    if (t.role !== 'sfx') continue;
    for (const n of t.notes ?? []) times.push(n.t);
    for (const c of trackClips(t)) times.push(c.at);
    if ((t.notes?.length ?? 0) === 0 && trackClips(t).length === 0) {
      const first = t.points?.find((p) => p.size > 1e-4);
      if (first) times.push(first.t);
    }
  }
  times.sort((a, b) => a - b);
  const clustered: number[] = [];
  for (const t of times) {
    if (clustered.length === 0 || t - clustered[clustered.length - 1] > 0.03) clustered.push(t);
  }
  return clustered;
}

export function measureVoiceover(args: {
  stems: { id: string; l: Float32Array; r: Float32Array }[] | undefined;
  sampleRate: number;
  duration: number;
  score?: Score;
  masking?: MaskingReport;
}): {
  presenceGapDb: number | null;
  sfxOverlap: number | null;
  sfxPer10s: number | null;
  sfxMinGapSec: number | null;
} | undefined {
  const { score, stems, sampleRate, duration, masking } = args;
  const hasVoice = score?.tracks.some((t) => t.role === 'voice');
  const hasSfx = score?.tracks.some((t) => t.role === 'sfx');
  if (!hasVoice && !hasSfx) return undefined;

  let presenceGapDb: number | null = null;
  if (hasVoice && stems && stems.length > 0) {
    const voice = stems.filter((s) => roleOf(score, s.id) === 'voice');
    const music = stems.filter((s) => roleOf(score, s.id) !== 'voice' && roleOf(score, s.id) !== 'sfx' && !s.id.startsWith('bus:'));
    const vMono = mixMono(voice);
    const mMono = mixMono(music);
    if (vMono && mMono) {
      const hop = Math.max(1, Math.floor(0.02 * sampleRate));
      const vEnv = presenceEnvelope(vMono, sampleRate, hop);
      const mEnv = presenceEnvelope(mMono, sampleRate, hop);
      let peak = 0;
      for (const v of vEnv) peak = Math.max(peak, v);
      const gate = Math.max(1e-4, peak * 0.2);
      const gaps: number[] = [];
      for (let i = 0; i < vEnv.length; i++) {
        if (vEnv[i] < gate) continue;
        gaps.push(20 * Math.log10((vEnv[i] + 1e-9) / (mEnv[i] + 1e-9)));
      }
      presenceGapDb = median(gaps);
    }
  }

  let sfxOverlap: number | null = null;
  if (hasSfx && masking && score) {
    let worst = 0;
    let found = false;
    for (const pair of masking.pairs) {
      const ra = roleOf(score, pair.a);
      const rb = roleOf(score, pair.b);
      const sfxMusic = (ra === 'sfx' && rb !== 'sfx' && rb !== 'voice') || (rb === 'sfx' && ra !== 'sfx' && ra !== 'voice');
      if (!sfxMusic) continue;
      found = true;
      worst = Math.max(worst, pair.overlap);
    }
    sfxOverlap = found ? worst : 0;
  }

  let sfxPer10s: number | null = null;
  let sfxMinGapSec: number | null = null;
  if (hasSfx && score) {
    const times = sfxEventTimes(score);
    sfxPer10s = duration > 0 ? (times.length / duration) * 10 : times.length;
    if (times.length >= 2) {
      let min = Infinity;
      for (let i = 1; i < times.length; i++) min = Math.min(min, times[i] - times[i - 1]);
      sfxMinGapSec = min;
    } else {
      sfxMinGapSec = null;
    }
  }

  return { presenceGapDb, sfxOverlap, sfxPer10s, sfxMinGapSec };
}
