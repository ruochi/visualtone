import type { AcousticEngine } from './engines/acoustic.js';

/**
 * How a sound is generated. Instruments that share a method and a parameter set
 * share one model; they differ only in numbers.
 */
export type SynthesisMethod = 'additive' | 'modal' | 'waveguide' | 'fm' | 'subtractive' | 'wavetable';

export interface ModelInfo {
  method: SynthesisMethod;
  /** Engine names that select this model. */
  engines: readonly (AcousticEngine | 'wavetable')[];
  how: string;
  /** What an instrument preset sets. */
  params: readonly string[];
  /** What a note's size and lightness move. */
  controls: string;
}

export const MODELS = {
  harmonic: {
    method: 'additive',
    engines: ['bow', 'brass', 'reed', 'bass'],
    how: 'Harmonics on an exponential slope that opens with loudness, one resonance, filtered breath or bow noise, and a player’s vibrato, drift, and 8–20 Hz level motion.',
    params: ['harmonic slope (soft, loud, register, low-note flattening)', 'lowpass', 'resonance Hz, Q, mix', 'noise band and level', 'finger transient', 'held decay', 'attack and release', 'vibrato, drift, level motion'],
    controls: 'size flattens the slope and raises the noise; lightness brightens a little',
  },
  drawbar: {
    method: 'additive',
    engines: ['organ'],
    how: 'Nine pipe ranks at fixed footages, mixed by a registration, with a short 4′ percussion and level motion from the wind supply.',
    params: ['registration (nine levels)', 'pipe speech time by length', 'percussion', 'level motion'],
    controls: 'size and lightness open the upper ranks',
  },
  bar: {
    method: 'modal',
    engines: ['marimba'],
    how: 'Four bar modes at fixed ratios, each decaying at its own rate, plus a mallet tick and a low knock.',
    params: ['mode ratios', 'mode decays and their pitch scaling', 'upper-mode levels', 'upper-mode roll-off range', 'mallet noise', 'tremolo'],
    controls: 'size opens the upper modes; lightness brightens them',
  },
  membrane: {
    method: 'modal',
    engines: ['drum'],
    how: 'Thirteen circular-membrane modes at Bessel-zero ratios, a beater pitch drop, beater noise, and snare wires.',
    params: ['fundamental decay', 'wire noise', 'beater click', 'pitch drop'],
    controls: 'size excites the upper modes and the beater; lightness near 1 is a center strike',
  },
  'stiff-string': {
    method: 'modal',
    engines: ['piano'],
    how: 'Partials at n·√(1+B·n²) on two strings 0.7 cents apart, with hammer noise and a soundboard hiss that decays with the string.',
    params: ['stiffness B by pitch', 'partial decay by pitch and order', 'hammer hardness', 'string detune'],
    controls: 'size hardens the hammer; hue toward 360 darkens it',
  },
  plate: {
    method: 'modal',
    engines: ['cymbal'],
    how: 'Eighteen inharmonic plate modes and bright noise, highpassed. Releasing a closed hat chokes it.',
    params: ['plate size from midi', 'ring time', 'noise level and band', 'choke'],
    controls: 'size raises the upper modes and the noise',
  },
  'plucked-string': {
    method: 'waveguide',
    engines: ['pluck'],
    how: 'Karplus–Strong delay loop with fractional delay and dispersion, excited once by a filtered noise burst, then a body resonance.',
    params: ['pluck position', 'loop loss', 'dispersion', 'body resonance', 'output lowpass'],
    controls: 'size moves the pluck toward the bridge; lightness lengthens the ring',
  },
  'blown-bore': {
    method: 'waveguide',
    engines: ['wind'],
    how: 'Delay-line bore with a saturating jet or reed inside the loop, so the note sustains itself. An open bore is a flute; a closed, inverting bore is a clarinet.',
    params: ['open or closed bore', 'jet or reed gain', 'even-harmonic term', 'loop filter', 'breath noise', 'drift and level motion'],
    controls: 'size raises the breath and opens the loop filter',
  },
  'two-operator': {
    method: 'fm',
    engines: ['epiano'],
    how: 'One sine modulates another; the index and the level decay.',
    params: ['modulator ratio', 'index', 'decay'],
    controls: 'size is the level; lightness raises the index',
  },
  'virtual-analog': {
    method: 'subtractive',
    engines: ['sub'],
    how: 'Band-limited harmonics, saturation, and a four-pole lowpass, with a pitch dip and a filter envelope.',
    params: ['wave (sub, two detuned saws, pluck)', 'drive', 'cutoff and its envelope', 'pitch dip', 'detune'],
    controls: 'size squares the wave and opens the lowpass',
  },
  'hue-ring': {
    method: 'wavetable',
    engines: ['wavetable'],
    how: 'A wavetable that morphs around the hue ring, shaped by the score’s ADSR, unison, and drift.',
    params: ['hue position', 'timbre overrides', 'unison', 'drift'],
    controls: 'size is the level; lightness opens the filter',
  },
} as const satisfies Record<string, ModelInfo>;

export type ModelId = keyof typeof MODELS;

export interface InstrumentInfo {
  model: ModelId;
  engine: AcousticEngine | 'wavetable';
  /** Inside the engine's range for this instrument. Reference recordings were scored at this hue. */
  hue: number;
  /** Set id in references/catalog.json. */
  reference?: string;
}

export const INSTRUMENTS = {
  violin: { model: 'harmonic', engine: 'bow', hue: 40, reference: 'tinysol-violin' },
  viola: { model: 'harmonic', engine: 'bow', hue: 160, reference: 'tinysol-viola' },
  cello: { model: 'harmonic', engine: 'bow', hue: 300, reference: 'tinysol-cello' },
  contrabass: { model: 'harmonic', engine: 'bass', hue: 40, reference: 'tinysol-bass' },
  'electric-bass': { model: 'harmonic', engine: 'bass', hue: 270, reference: 'nsynth-electric-bass' },
  trumpet: { model: 'harmonic', engine: 'brass', hue: 40, reference: 'tinysol-trumpet' },
  horn: { model: 'harmonic', engine: 'brass', hue: 130, reference: 'tinysol-horn' },
  trombone: { model: 'harmonic', engine: 'brass', hue: 210, reference: 'tinysol-trombone' },
  tuba: { model: 'harmonic', engine: 'brass', hue: 270, reference: 'tinysol-tuba' },
  saxophone: { model: 'harmonic', engine: 'brass', hue: 300, reference: 'tinysol-sax' },
  oboe: { model: 'harmonic', engine: 'reed', hue: 40, reference: 'tinysol-oboe' },
  bassoon: { model: 'harmonic', engine: 'reed', hue: 220, reference: 'tinysol-bassoon' },
  organ: { model: 'drawbar', engine: 'organ', hue: 40, reference: 'vsco-organ' },
  'organ-full': { model: 'drawbar', engine: 'organ', hue: 180 },
  marimba: { model: 'bar', engine: 'marimba', hue: 50, reference: 'vsco-marimba' },
  xylophone: { model: 'bar', engine: 'marimba', hue: 160, reference: 'vsco-xylophone' },
  vibraphone: { model: 'bar', engine: 'marimba', hue: 240, reference: 'nsynth-vibraphone' },
  glockenspiel: { model: 'bar', engine: 'marimba', hue: 320, reference: 'vsco-glock' },
  kick: { model: 'membrane', engine: 'drum', hue: 20, reference: 'vsco-kick' },
  tom: { model: 'membrane', engine: 'drum', hue: 80, reference: 'vsco-timpani' },
  snare: { model: 'membrane', engine: 'drum', hue: 180, reference: 'vsco-snare' },
  conga: { model: 'membrane', engine: 'drum', hue: 260, reference: 'vsco-conga' },
  'frame-drum': { model: 'membrane', engine: 'drum', hue: 335 },
  piano: { model: 'stiff-string', engine: 'piano', hue: 30, reference: 'salamander-piano' },
  'hihat-closed': { model: 'plate', engine: 'cymbal', hue: 40 },
  'hihat-open': { model: 'plate', engine: 'cymbal', hue: 155 },
  crash: { model: 'plate', engine: 'cymbal', hue: 270 },
  'steel-guitar': { model: 'plucked-string', engine: 'pluck', hue: 70 },
  'nylon-guitar': { model: 'plucked-string', engine: 'pluck', hue: 200 },
  harp: { model: 'plucked-string', engine: 'pluck', hue: 310, reference: 'vsco-harp' },
  flute: { model: 'blown-bore', engine: 'wind', hue: 40, reference: 'tinysol-flute' },
  clarinet: { model: 'blown-bore', engine: 'wind', hue: 220, reference: 'tinysol-clarinet' },
  'electric-piano': { model: 'two-operator', engine: 'epiano', hue: 0, reference: 'nsynth-electric-piano' },
  'sub-bass': { model: 'virtual-analog', engine: 'sub', hue: 40 },
  'reese-bass': { model: 'virtual-analog', engine: 'sub', hue: 160 },
  'offbeat-bass': { model: 'virtual-analog', engine: 'sub', hue: 300 },
  'synth-pluck': { model: 'hue-ring', engine: 'wavetable', hue: 70 },
  'synth-lead': { model: 'hue-ring', engine: 'wavetable', hue: 160 },
  'synth-pad': { model: 'hue-ring', engine: 'wavetable', hue: 210 },
} as const satisfies Record<string, InstrumentInfo>;

export type InstrumentId = keyof typeof INSTRUMENTS;

export const INSTRUMENT_IDS = Object.keys(INSTRUMENTS) as [InstrumentId, ...InstrumentId[]];

export function instrumentInfo(id: InstrumentId): InstrumentInfo {
  return INSTRUMENTS[id];
}
