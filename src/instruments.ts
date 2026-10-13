/**
 * Lite instruments: a two-oscillator subtractive synth with presets,
 * plus a synthesized drum kit. Each note renders to a mono buffer.
 */
import { type Adsr, Osc, Svf, adsrAt, midiToHz, type Wave } from './dsp.js';
import type { Note } from './schema.js';

export interface SynthPreset {
  kind: 'synth';
  waves: [Wave, Wave];
  /** Level of the second oscillator, 0..1. */
  mix: number;
  /** Second oscillator offset in semitones (+ fine detune in cents below). */
  interval: number;
  detuneCents: number;
  amp: Adsr;
  /** Filter cutoff as a multiple of the note frequency, at lightness 0.5. */
  cutoff: number;
  q: number;
  /** Extra cutoff multiple at the filter envelope peak. */
  filterEnv: number;
  filterDecay: number;
  /** Seconds of tail rendered after note-off. */
  tail: number;
}

export interface DrumPreset {
  kind: 'drums';
}

export type Preset = SynthPreset | DrumPreset;

const synth = (p: Omit<SynthPreset, 'kind'>): SynthPreset => ({ kind: 'synth', ...p });

export const INSTRUMENTS: Record<string, Preset> = {
  lead: synth({ waves: ['saw', 'saw'], mix: 0.7, interval: 0, detuneCents: 9, amp: { attack: 0.005, decay: 0.2, sustain: 0.75, release: 0.15 }, cutoff: 9, q: 1.2, filterEnv: 8, filterDecay: 0.25, tail: 0.3 }),
  bass: synth({ waves: ['saw', 'square'], mix: 0.3, interval: 0, detuneCents: 0, amp: { attack: 0.003, decay: 0.15, sustain: 0.8, release: 0.06 }, cutoff: 4, q: 1.8, filterEnv: 7, filterDecay: 0.1, tail: 0.1 }),
  sub: synth({ waves: ['sine', 'triangle'], mix: 0.25, interval: 0, detuneCents: 0, amp: { attack: 0.004, decay: 0.1, sustain: 0.9, release: 0.08 }, cutoff: 4, q: 0.7, filterEnv: 0, filterDecay: 0.1, tail: 0.12 }),
  pluck: synth({ waves: ['saw', 'square'], mix: 0.4, interval: 12, detuneCents: 5, amp: { attack: 0.002, decay: 0.25, sustain: 0, release: 0.15 }, cutoff: 2, q: 2, filterEnv: 14, filterDecay: 0.12, tail: 0.3 }),
  pad: synth({ waves: ['saw', 'saw'], mix: 0.9, interval: 0, detuneCents: 14, amp: { attack: 0.4, decay: 0.6, sustain: 0.8, release: 0.9 }, cutoff: 3, q: 0.8, filterEnv: 2, filterDecay: 1.2, tail: 1.2 }),
  keys: synth({ waves: ['triangle', 'sine'], mix: 0.5, interval: 12, detuneCents: 3, amp: { attack: 0.003, decay: 0.6, sustain: 0.35, release: 0.3 }, cutoff: 5, q: 0.7, filterEnv: 4, filterDecay: 0.3, tail: 0.5 }),
  drums: { kind: 'drums' },
};

/** Hue picks the waveform pair: 0 sine, 90 triangle, 180 square, 270 saw (wraps). */
function waveForHue(hue: number): [Wave, Wave] {
  const ring: Wave[] = ['sine', 'triangle', 'square', 'saw'];
  const i = Math.round((((hue % 360) + 360) % 360) / 90) % 4;
  return [ring[i], ring[(i + 1) % 4]];
}

export interface RenderOptions {
  sampleRate: number;
  hue?: number;
  lightness?: number;
  rand: () => number;
}

/** Render one synth note. The returned buffer starts at note-on. */
export function renderSynthNote(p: SynthPreset, note: Note, midi: number, o: RenderOptions): Float32Array {
  const sr = o.sampleRate;
  const len = Math.ceil((note.duration + p.tail) * sr);
  const out = new Float32Array(len);
  const waves = o.hue === undefined ? p.waves : waveForHue(o.hue);
  const a = new Osc(waves[0], o.rand());
  const b = new Osc(waves[1], o.rand());
  const f1 = midiToHz(midi);
  const f2 = midiToHz(midi + p.interval + p.detuneCents / 100);
  const filter = new Svf(sr);
  // lightness 0.5 keeps the preset; each 0.1 step moves the cutoff about 40%.
  const bright = Math.pow(2, ((o.lightness ?? 0.5) - 0.5) * 5);
  const vel = 0.4 + 0.6 * note.size;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const env = adsrAt(p.amp, t, note.duration);
    if (env < 1e-5 && t > note.duration) break;
    const fEnv = p.filterEnv * Math.exp(-t / p.filterDecay) * note.size;
    const cutoff = Math.max(30, f1 * (p.cutoff + fEnv) * bright);
    const x = a.next(f1 / sr) + p.mix * b.next(f2 / sr);
    out[i] = filter.process(x, cutoff, p.q)[0] * env * vel * 0.5;
  }
  return out;
}

/**
 * Drum kit, General MIDI numbers: 36 kick, 38 snare, 39 clap,
 * 42 closed hat, 46 open hat, 45/47/50 toms. Other numbers fall back to the nearest voice.
 */
export function renderDrumNote(note: Note, midi: number, o: RenderOptions): Float32Array {
  const sr = o.sampleRate;
  const voice = midi <= 37 ? 'kick' : midi === 39 ? 'clap' : midi <= 40 ? 'snare' : midi === 42 || midi === 44 ? 'hat' : midi === 46 ? 'openhat' : 'tom';
  const lenSec = { kick: 0.5, snare: 0.3, clap: 0.35, hat: 0.08, openhat: 0.45, tom: 0.5 }[voice];
  const len = Math.ceil(lenSec * sr);
  const out = new Float32Array(len);
  const hp = new Svf(sr);
  const bp = new Svf(sr);
  let phase = 0;
  const tomHz = midiToHz(midi) / 2;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const noise = o.rand() * 2 - 1;
    let y = 0;
    switch (voice) {
      case 'kick': {
        const f = 45 + 110 * Math.exp(-t / 0.035);
        phase += f / sr;
        y = Math.sin(2 * Math.PI * phase) * Math.exp(-t / 0.11) + hp.process(noise, 3000, 0.7)[2] * 0.5 * Math.exp(-t / 0.003);
        y = Math.tanh(y * 1.6);
        break;
      }
      case 'snare': {
        phase += (180 + 60 * Math.exp(-t / 0.02)) / sr;
        const body = Math.sin(2 * Math.PI * phase) * Math.exp(-t / 0.05);
        const wires = hp.process(noise, 2500, 0.7)[2] * Math.exp(-t / 0.11);
        y = body * 0.55 + wires * 0.9;
        break;
      }
      case 'clap': {
        // Three quick bursts then a short tail.
        const burst = [0, 0.011, 0.022].reduce((s, d) => s + (t >= d ? Math.exp(-(t - d) / 0.006) : 0), 0);
        const tail = t > 0.022 ? Math.exp(-(t - 0.022) / 0.08) : 0;
        y = bp.process(noise, 1400, 1.5)[1] * (burst + tail) * 2;
        break;
      }
      case 'hat':
      case 'openhat': {
        const decay = voice === 'hat' ? 0.02 : 0.15;
        y = hp.process(noise, 8000, 0.8)[2] * Math.exp(-t / decay) * 1.1;
        break;
      }
      case 'tom': {
        phase += (tomHz * (1 + 0.5 * Math.exp(-t / 0.03))) / sr;
        y = Math.sin(2 * Math.PI * phase) * Math.exp(-t / 0.22);
        break;
      }
    }
    out[i] = y * note.size;
  }
  return out;
}
