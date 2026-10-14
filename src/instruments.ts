/**
 * Instrument catalog. Names stay stable when the synth changes.
 * Each preset carries a range (for the report), a default level, pan and reverb,
 * so a score that only names instruments is already balanced.
 */
import { type Adsr, Osc, Svf, adsrAt, midiToHz, type Wave } from './dsp.js';

export const DRUM_NAMES = ['kick', 'snare', 'clap', 'rim', 'hat', 'openhat', 'tom-low', 'tom-mid', 'tom-high', 'crash', 'ride', 'shaker'] as const;
export type DrumName = (typeof DRUM_NAMES)[number];

export const DRUM_MIDI: Record<DrumName, number> = {
  kick: 36, snare: 38, clap: 39, rim: 37, hat: 42, openhat: 46,
  'tom-low': 45, 'tom-mid': 47, 'tom-high': 50, crash: 49, ride: 51, shaker: 70,
};

const MIDI_DRUM: Record<number, DrumName> = {
  35: 'kick', 36: 'kick', 37: 'rim', 38: 'snare', 40: 'snare', 39: 'clap',
  42: 'hat', 44: 'hat', 46: 'openhat', 41: 'tom-low', 43: 'tom-low', 45: 'tom-low',
  47: 'tom-mid', 48: 'tom-high', 50: 'tom-high', 49: 'crash', 57: 'crash',
  51: 'ride', 53: 'ride', 59: 'ride', 69: 'shaker', 70: 'shaker', 82: 'shaker',
};

export function drumFromMidi(midi: number): DrumName {
  if (MIDI_DRUM[midi]) return MIDI_DRUM[midi];
  if (midi <= 37) return 'kick';
  if (midi === 39) return 'clap';
  if (midi <= 40) return 'snare';
  if (midi <= 44) return 'hat';
  if (midi === 46) return 'openhat';
  if (midi <= 48) return 'tom-mid';
  if (midi <= 52) return 'crash';
  return 'ride';
}

export interface SynthPreset {
  waves: [Wave, Wave];
  mix: number;
  interval: number;
  detuneCents: number;
  amp: Adsr;
  /** Filter cutoff as a multiple of the note, at brightness 0.5. */
  cutoff: number;
  q: number;
  filterEnv: number;
  filterDecay: number;
  tail: number;
}

export interface InstrumentInfo {
  kind: 'synth' | 'drums';
  /** Playable midi range. Notes outside it are reported, not moved. */
  range: [number, number];
  /** Where chord degrees sit when the part doesn't name an octave. */
  center: number;
  /** dB added before the track's own gain. 0 on the track means "use this". */
  gain: number;
  pan: number;
  /** Default reverb send, 0 dry → 1 wet. */
  space: number;
  /** How hard to scoop the vocal range when a voice track is present. */
  vocalDip: number;
  /** Fixed high-pass, Hz. Keeps mud out without a score field. */
  lowCut?: number;
  tail: number;
  synth?: SynthPreset;
}

const synth = (p: SynthPreset): SynthPreset => p;

const PRESETS: Record<string, SynthPreset> = {
  bass: synth({ waves: ['saw', 'square'], mix: 0.3, interval: 0, detuneCents: 0, amp: { attack: 0.003, decay: 0.15, sustain: 0.8, release: 0.06 }, cutoff: 4, q: 1.8, filterEnv: 7, filterDecay: 0.1, tail: 0.1 }),
  sub: synth({ waves: ['sine', 'triangle'], mix: 0.25, interval: 0, detuneCents: 0, amp: { attack: 0.004, decay: 0.1, sustain: 0.9, release: 0.08 }, cutoff: 3, q: 0.7, filterEnv: 0, filterDecay: 0.1, tail: 0.12 }),
  'synth-bass': synth({ waves: ['saw', 'square'], mix: 0.5, interval: 0, detuneCents: 6, amp: { attack: 0.004, decay: 0.18, sustain: 0.65, release: 0.08 }, cutoff: 5, q: 2.4, filterEnv: 12, filterDecay: 0.12, tail: 0.12 }),
  piano: synth({ waves: ['triangle', 'sine'], mix: 0.35, interval: 12, detuneCents: 2, amp: { attack: 0.002, decay: 0.55, sustain: 0.15, release: 0.28 }, cutoff: 6, q: 0.6, filterEnv: 3, filterDecay: 0.22, tail: 0.45 }),
  epiano: synth({ waves: ['triangle', 'sine'], mix: 0.6, interval: 12, detuneCents: 4, amp: { attack: 0.003, decay: 0.4, sustain: 0.28, release: 0.3 }, cutoff: 4.2, q: 1.3, filterEnv: 6, filterDecay: 0.25, tail: 0.45 }),
  organ: synth({ waves: ['square', 'sine'], mix: 0.35, interval: 12, detuneCents: 3, amp: { attack: 0.015, decay: 0.08, sustain: 0.9, release: 0.06 }, cutoff: 5, q: 0.5, filterEnv: 0, filterDecay: 0.2, tail: 0.12 }),
  pad: synth({ waves: ['saw', 'saw'], mix: 0.9, interval: 0, detuneCents: 14, amp: { attack: 0.35, decay: 0.5, sustain: 0.8, release: 0.8 }, cutoff: 3, q: 0.8, filterEnv: 2, filterDecay: 1.1, tail: 1.1 }),
  strings: synth({ waves: ['saw', 'saw'], mix: 0.85, interval: 0, detuneCents: 11, amp: { attack: 0.18, decay: 0.4, sustain: 0.85, release: 0.55 }, cutoff: 3.2, q: 0.7, filterEnv: 1.4, filterDecay: 0.7, tail: 0.7 }),
  pluck: synth({ waves: ['saw', 'square'], mix: 0.4, interval: 12, detuneCents: 5, amp: { attack: 0.002, decay: 0.22, sustain: 0, release: 0.12 }, cutoff: 2.2, q: 2, filterEnv: 14, filterDecay: 0.1, tail: 0.25 }),
  lead: synth({ waves: ['saw', 'saw'], mix: 0.7, interval: 0, detuneCents: 8, amp: { attack: 0.006, decay: 0.18, sustain: 0.72, release: 0.14 }, cutoff: 8, q: 1.2, filterEnv: 7, filterDecay: 0.22, tail: 0.25 }),
  bell: synth({ waves: ['sine', 'sine'], mix: 0.4, interval: 12, detuneCents: 3, amp: { attack: 0.002, decay: 0.9, sustain: 0, release: 0.6 }, cutoff: 14, q: 0.5, filterEnv: 0, filterDecay: 0.2, tail: 1 }),
  marimba: synth({ waves: ['sine', 'triangle'], mix: 0.35, interval: 12, detuneCents: 1, amp: { attack: 0.001, decay: 0.22, sustain: 0, release: 0.1 }, cutoff: 7, q: 1.6, filterEnv: 5, filterDecay: 0.07, tail: 0.2 }),
};

export const INSTRUMENTS: Record<string, InstrumentInfo> = {
  drums: { kind: 'drums', range: [0, 127], center: 36, gain: -3, pan: 0, space: 0.06, vocalDip: 0, lowCut: 28, tail: 0.6 },
  bass: { kind: 'synth', range: [28, 60], center: 36, gain: -2, pan: 0, space: 0.04, vocalDip: 0, lowCut: 32, tail: 0.1, synth: PRESETS.bass },
  sub: { kind: 'synth', range: [24, 48], center: 31, gain: -4, pan: 0, space: 0, vocalDip: 0, lowCut: 28, tail: 0.12, synth: PRESETS.sub },
  'synth-bass': { kind: 'synth', range: [28, 62], center: 38, gain: -3, pan: 0, space: 0.08, vocalDip: 0, lowCut: 30, tail: 0.12, synth: PRESETS['synth-bass'] },
  piano: { kind: 'synth', range: [21, 108], center: 60, gain: -8, pan: -0.12, space: 0.22, vocalDip: 0.28, tail: 0.45, synth: PRESETS.piano },
  epiano: { kind: 'synth', range: [40, 84], center: 60, gain: -8, pan: -0.18, space: 0.28, vocalDip: 0.32, tail: 0.45, synth: PRESETS.epiano },
  organ: { kind: 'synth', range: [36, 84], center: 60, gain: -11, pan: 0.08, space: 0.34, vocalDip: 0.4, tail: 0.12, synth: PRESETS.organ },
  pad: { kind: 'synth', range: [36, 84], center: 55, gain: -13, pan: 0, space: 0.48, vocalDip: 0.5, tail: 1.1, synth: PRESETS.pad },
  strings: { kind: 'synth', range: [36, 86], center: 55, gain: -11, pan: 0.16, space: 0.4, vocalDip: 0.42, tail: 0.7, synth: PRESETS.strings },
  pluck: { kind: 'synth', range: [48, 88], center: 64, gain: -7, pan: 0.26, space: 0.18, vocalDip: 0.16, tail: 0.25, synth: PRESETS.pluck },
  lead: { kind: 'synth', range: [48, 88], center: 72, gain: -5, pan: 0.2, space: 0.3, vocalDip: 0.22, tail: 0.25, synth: PRESETS.lead },
  bell: { kind: 'synth', range: [60, 96], center: 84, gain: -12, pan: -0.32, space: 0.4, vocalDip: 0.12, tail: 1, synth: PRESETS.bell },
  marimba: { kind: 'synth', range: [48, 84], center: 60, gain: -7, pan: 0.14, space: 0.22, vocalDip: 0.14, tail: 0.2, synth: PRESETS.marimba },
};

export const INSTRUMENT_NAMES = Object.keys(INSTRUMENTS);

/** Old names a model still writes, and the current catalog name. */
export const INSTRUMENT_ALIASES: Record<string, string> = {
  keys: 'epiano',
  rhodes: 'epiano',
  'e-piano': 'epiano',
  synthbass: 'synth-bass',
  'synth bass': 'synth-bass',
  drum: 'drums',
  kit: 'drums',
  violin: 'strings',
  guitar: 'pluck',
};

export interface PlayNote {
  duration: number;
  velocity: number;
  drum?: DrumName;
}

export interface NoteRender {
  sampleRate: number;
  brightness: number;
  rand: () => number;
}

function brightMul(brightness: number): number {
  return Math.pow(2, (brightness - 0.5) * 5);
}

export function renderSynthNote(info: InstrumentInfo, note: PlayNote, midi: number, o: NoteRender): Float32Array {
  const p = info.synth!;
  const sr = o.sampleRate;
  const len = Math.ceil((note.duration + p.tail) * sr);
  const out = new Float32Array(len);
  const a = new Osc(p.waves[0], o.rand());
  const b = new Osc(p.waves[1], o.rand());
  const f1 = midiToHz(midi);
  const f2 = midiToHz(midi + p.interval + p.detuneCents / 100);
  const filter = new Svf(sr);
  const bright = brightMul(o.brightness);
  const vel = 0.4 + 0.6 * note.velocity;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const env = adsrAt(p.amp, t, note.duration);
    if (env < 1e-5 && t > note.duration) break;
    const fEnv = p.filterEnv * Math.exp(-t / p.filterDecay) * note.velocity;
    const cutoff = Math.max(30, f1 * (p.cutoff + fEnv) * bright);
    const x = a.next(f1 / sr) + p.mix * b.next(f2 / sr);
    out[i] = filter.process(x, cutoff, p.q)[0] * env * vel * 0.5;
  }
  return out;
}

const DRUM_LEN: Record<DrumName, number> = {
  kick: 0.45, snare: 0.28, clap: 0.32, rim: 0.08, hat: 0.07, openhat: 0.4,
  'tom-low': 0.45, 'tom-mid': 0.38, 'tom-high': 0.3, crash: 0.9, ride: 0.7, shaker: 0.09,
};

export function renderDrumNote(note: PlayNote, o: NoteRender): Float32Array {
  const voice = note.drum ?? 'snare';
  const sr = o.sampleRate;
  const len = Math.ceil(DRUM_LEN[voice] * sr);
  const out = new Float32Array(len);
  const hp = new Svf(sr);
  const bp = new Svf(sr);
  const bright = brightMul(o.brightness);
  let phase = 0;
  const tomHz = { 'tom-low': 90, 'tom-mid': 140, 'tom-high': 200 } as const;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const noise = o.rand() * 2 - 1;
    let y = 0;
    switch (voice) {
      case 'kick': {
        phase += (45 + 120 * Math.exp(-t / 0.03)) / sr;
        y = Math.sin(2 * Math.PI * phase) * Math.exp(-t / 0.12) + hp.process(noise, 2500 * bright, 0.7)[2] * 0.45 * Math.exp(-t / 0.003);
        y = Math.tanh(y * 1.5);
        break;
      }
      case 'snare': {
        phase += (180 + 70 * Math.exp(-t / 0.02)) / sr;
        y = Math.sin(2 * Math.PI * phase) * Math.exp(-t / 0.05) * 0.55 + hp.process(noise, 2800 * bright, 0.7)[2] * Math.exp(-t / 0.1) * 0.85;
        break;
      }
      case 'clap': {
        const burst = [0, 0.011, 0.023].reduce((s, d) => s + (t >= d ? Math.exp(-(t - d) / 0.006) : 0), 0);
        const tail = t > 0.023 ? Math.exp(-(t - 0.023) / 0.08) : 0;
        y = bp.process(noise, 1500 * bright, 1.4)[1] * (burst + tail) * 1.8;
        break;
      }
      case 'rim': {
        phase += 680 / sr;
        y = (Math.sin(2 * Math.PI * phase) * 0.4 + noise * 0.6) * Math.exp(-t / 0.012);
        break;
      }
      case 'hat':
      case 'openhat': {
        const decay = voice === 'hat' ? 0.018 : 0.14;
        y = hp.process(noise, 7000 * bright, 0.7)[2] * Math.exp(-t / decay);
        break;
      }
      case 'tom-low':
      case 'tom-mid':
      case 'tom-high': {
        const base = tomHz[voice];
        phase += (base * (1 + 0.6 * Math.exp(-t / 0.03))) / sr;
        y = Math.tanh(Math.sin(2 * Math.PI * phase) * 1.4) * Math.exp(-t / (voice === 'tom-low' ? 0.22 : 0.16));
        break;
      }
      case 'crash':
        y = hp.process(noise, 6000 * bright, 0.6)[2] * Math.exp(-t / 0.35) * 0.9;
        break;
      case 'ride': {
        const ping = t % 0.02 < 0.004 ? 1 : Math.exp(-((t % 0.02) - 0.004) / 0.03);
        y = bp.process(noise, 4500 * bright, 2.2)[1] * Math.exp(-t / 0.4) * (0.35 + ping);
        break;
      }
      case 'shaker':
        y = hp.process(noise, 8000 * bright, 0.8)[2] * Math.exp(-t / 0.02) * 0.7;
        break;
    }
    out[i] = y * (0.55 + 0.45 * note.velocity);
  }
  return out;
}
