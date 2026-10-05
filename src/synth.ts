import { hueToTimbre, lightnessToCutoff, hashSeed, type TimbreParams } from './timbre.js';

export { hueToTimbre, hashSeed } from './timbre.js';
export type { TimbreParams } from './timbre.js';

/** @deprecated use hueToTimbre */
export function hueToSynthParams(hue: number) {
  const t = hueToTimbre(hue);
  return {
    brightness: 1 - t.noise * 0.3,
    thickness: t.saw,
    noise: t.noise,
  };
}

export function midiToFrequency(midiNote: number): number {
  return 440 * Math.pow(2, (midiNote - 69) / 12);
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Voice {
  private phase = 0;
  private phase2 = 0;
  private rng: () => number;
  private svfLp = 0;
  private svfHp = 0;
  private smoothGain = 0;
  private onsetSamplesLeft = 0;
  private filterEnvLeft = 0;
  private pitchDropLeft = 0;
  private pitchDropTotal = 0;
  private pitchDropSemis = 0;
  private wasSilent = true;
  private timbre: TimbreParams;
  private readonly gainSmoothCoeff: number;

  constructor(
    private readonly sampleRate: number,
    hue: number,
    seed: number,
  ) {
    this.timbre = hueToTimbre(hue);
    this.rng = mulberry32(seed);
    const smoothMs = 2;
    this.gainSmoothCoeff = Math.exp(-1 / (sampleRate * (smoothMs / 1000)));
  }

  private polyBlepSaw(phase: number, freq: number): number {
    const t = phase / (2 * Math.PI);
    let s = 2 * t - 1;
    const dt = freq / this.sampleRate;
    if (t < dt) {
      const x = t / dt;
      s -= x + x * x - x * x * x - 1;
    } else if (t > 1 - dt) {
      const x = (t - 1) / dt;
      s -= x * x * x + x * x + x + 1;
    }
    return s;
  }

  private polyBlepSquare(phase: number, freq: number): number {
    const t = phase / (2 * Math.PI);
    let s = t < 0.5 ? 1 : -1;
    const dt = freq / this.sampleRate;
    if (t < dt) {
      s += (t / dt) * 2 - (t / dt) * (t / dt) - 1;
    } else if (t > 0.5 - dt && t < 0.5 + dt) {
      const x = (t - 0.5) / dt;
      s -= x * x;
    } else if (t > 1 - dt) {
      const x = (t - 1) / dt;
      s -= x * x + 2 * x + 1;
    }
    return s;
  }

  private svfLowpass(input: number, cutoff: number): number {
    const g = Math.tan((Math.PI * cutoff) / this.sampleRate);
    const k = 2 - 2 * g;
    const a1 = 1 / (1 + g);
    const hp = a1 * (input - this.svfLp * k - this.svfHp);
    const bp = hp + this.svfHp;
    const lp = bp + this.svfLp;
    this.svfHp = hp;
    this.svfLp = lp;
    return lp;
  }

  private triggerOnset() {
    const sr = this.sampleRate;
    this.onsetSamplesLeft = Math.max(1, (this.timbre.attackMs / 1000) * sr);
    this.filterEnvLeft = Math.max(1, (this.timbre.decayMs / 1000) * sr);
    this.pitchDropTotal = Math.max(0, (this.timbre.pitchDropMs / 1000) * sr);
    this.pitchDropLeft = this.pitchDropTotal;
    this.pitchDropSemis = this.timbre.pitchDropSemitones;
  }

  /** Render one sample. Returns mono sample * gain already applied via size. */
  processSample(midiY: number, size: number, lightness: number): number {
    const silent = size <= 1e-6;
    if (!silent && this.wasSilent) {
      this.triggerOnset();
    }
    this.wasSilent = silent;
    if (silent) {
      this.smoothGain *= this.gainSmoothCoeff;
      return 0;
    }

    let freq = midiToFrequency(midiY);
    if (this.pitchDropLeft > 0 && this.pitchDropTotal > 0) {
      const t = 1 - this.pitchDropLeft / this.pitchDropTotal;
      freq *= Math.pow(2, (-this.pitchDropSemis * t) / 12);
      this.pitchDropLeft--;
    }

    const detune = Math.pow(2, this.timbre.detuneCents / 1200);
    const f1 = freq;
    const f2 = freq * detune;

    const omega1 = (2 * Math.PI * f1) / this.sampleRate;
    const omega2 = (2 * Math.PI * f2) / this.sampleRate;
    this.phase += omega1;
    this.phase2 += omega2;
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
    if (this.phase2 > 2 * Math.PI) this.phase2 -= 2 * Math.PI;

    const sine = Math.sin(this.phase);
    const saw = this.polyBlepSaw(this.phase, f1);
    const square = this.polyBlepSquare(this.phase, f1);
    const saw2 = this.polyBlepSaw(this.phase2, f2) * 0.5;
    const inharm =
      Math.sin(this.phase * (2 + this.timbre.inharmonic * 0.5)) * this.timbre.inharmonic;

    let osc =
      sine * this.timbre.sine +
      saw * this.timbre.saw +
      square * this.timbre.square +
      saw2 * 0.3 +
      inharm * 0.25;

    let noise = (this.rng() * 2 - 1) * this.timbre.noise;
    if (this.onsetSamplesLeft > 0) {
      noise *= 1.5;
      this.onsetSamplesLeft--;
    }

    let mix = osc * (1 - this.timbre.noise * 0.5) + noise * 0.35;

    let cutoff = lightnessToCutoff(lightness, freq);
    if (this.filterEnvLeft > 0) {
      const envT = this.filterEnvLeft / ((this.timbre.decayMs / 1000) * this.sampleRate);
      const boost = 1 + this.timbre.filterEnvAmount * (1 - envT);
      cutoff *= boost;
      this.filterEnvLeft--;
    }

    mix = this.svfLowpass(mix, Math.max(80, cutoff));

    this.smoothGain = this.smoothGain * this.gainSmoothCoeff + size * (1 - this.gainSmoothCoeff);
    return mix * this.smoothGain;
  }

  reset() {
    this.phase = 0;
    this.phase2 = 0;
    this.svfLp = 0;
    this.svfHp = 0;
    this.smoothGain = 0;
    this.wasSilent = true;
    this.onsetSamplesLeft = 0;
    this.filterEnvLeft = 0;
    this.pitchDropLeft = 0;
  }
}

/** @deprecated */
export class SimpleSynth {
  private voice: Voice;
  constructor(sampleRate: number, seed = 0) {
    this.voice = new Voice(sampleRate, 180, seed);
  }
  synthesize(frequency: number, gain: number, _params: unknown, numSamples: number): Float32Array {
    const buf = new Float32Array(numSamples);
    const midi = 69 + 12 * Math.log2(frequency / 440);
    for (let i = 0; i < numSamples; i++) {
      buf[i] = this.voice.processSample(midi, gain, 0.5);
    }
    return buf;
  }
  reset() {
    this.voice.reset();
  }
}

export type SynthParams = { brightness: number; thickness: number; noise: number };
