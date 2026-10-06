import {
  applyMacros,
  hueToTimbreVector,
  lightnessToCutoff,
  hashSeed,
  type TimbreVector,
  type TimbreOverride,
} from './timbre.js';
import { buildWavetable, readWavetable } from './wavetable.js';

export {
  hueToTimbreVector,
  hueToTimbreVector as hueToTimbre,
  hashSeed,
  applyMacros,
  lightnessToCutoff,
} from './timbre.js';
export type { TimbreVector, TimbreParams, TimbreOverride } from './timbre.js';

/** @deprecated */
export function hueToSynthParams(hue: number) {
  const t = hueToTimbreVector(hue);
  return { brightness: 1 - t.noise * 0.3, thickness: 1 - t.tilt * 0.2, noise: t.noise };
}

export function midiToFrequency(midiNote: number): number {
  return 440 * Math.pow(2, (midiNote - 69) / 12);
}

export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class SvfLowpass {
  private z1 = 0;
  private z2 = 0;

  process(input: number, cutoff: number, resonance: number, sampleRate: number): number {
    const fc = Math.min(Math.max(80, cutoff), sampleRate * 0.45);
    const g = Math.tan((Math.PI * fc) / sampleRate);
    const k = 2 - 2 * resonance * 0.95;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = input - this.z2;
    const v1 = a1 * this.z1 + a2 * v3;
    const v2 = this.z2 + a2 * this.z1 + a3 * v3;
    this.z1 = 2 * v1 - this.z1;
    this.z2 = 2 * v2 - this.z2;
    return v2;
  }

  reset() {
    this.z1 = 0;
    this.z2 = 0;
  }
}

class SvfBandpass {
  private z1 = 0;
  private z2 = 0;

  process(input: number, center: number, sampleRate: number): number {
    const fc = Math.min(Math.max(80, center), sampleRate * 0.45);
    const g = Math.tan((Math.PI * fc) / sampleRate);
    const k = 2;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = input - this.z2;
    const v1 = a1 * this.z1 + a2 * v3;
    const v2 = this.z2 + a2 * this.z1 + a3 * v3;
    this.z1 = 2 * v1 - this.z1;
    this.z2 = 2 * v2 - this.z2;
    return v1;
  }
}

export class Voice {
  private readonly vector: TimbreVector;
  private readonly wt;
  private readonly rng: () => number;
  private readonly gainSmoothCoeff: number;
  private readonly unisonPhases: number[];
  private readonly unisonPanL: number[];
  private readonly unisonPanR: number[];
  private readonly filterL: SvfLowpass;
  private readonly filterR: SvfLowpass;
  private readonly noiseBp: SvfBandpass;
  private smoothGain = 0;
  private wasSilent = true;
  private filterEnvLeft = 0;
  private pitchEnvLeft = 0;
  private pitchEnvTotal = 0;
  private attackLeft = 0;
  private transientLeft = 0;
  private releaseSamples = 0;
  private releaseLeft = 0;
  private lastMidi = 60;
  private lastLight = 0.5;
  private lastSize = 0;
  private notePeak = 0;
  private onsetSize = 0.7;
  private onsetCutoff = 1;
  private readonly velocity: number;
  private readonly driftAmount: number;
  private readonly drift: number[];
  private readonly driftCoeff: number;

  constructor(
    private readonly sampleRate: number,
    hue: number,
    seed: number,
    trackLightness = 0.5,
    saturation = 1,
    override?: TimbreOverride & { velocity?: number; drift?: number },
  ) {
    this.vector = applyMacros(hueToTimbreVector(hue), trackLightness, saturation, override);
    this.velocity = override?.velocity ?? 0;
    this.driftAmount = override?.drift ?? 0;
    this.wt = buildWavetable(this.vector);
    this.rng = mulberry32(seed);
    this.gainSmoothCoeff = Math.exp(-1 / (sampleRate * 0.002));
    this.filterL = new SvfLowpass();
    this.filterR = new SvfLowpass();
    this.noiseBp = new SvfBandpass();
    const n = this.vector.unison;
    this.unisonPhases = new Array(n).fill(0);
    this.unisonPanL = new Array(n);
    this.unisonPanR = new Array(n);
    this.drift = new Array(n).fill(0);
    this.driftCoeff = 1 - Math.exp((-2 * Math.PI * 0.3) / sampleRate);
    for (let i = 0; i < n; i++) {
      const pan = n === 1 ? 0 : (i / (n - 1) - 0.5) * 2 * this.vector.spread;
      const angle = (pan + 1) * 0.25 * Math.PI;
      this.unisonPanL[i] = Math.cos(angle);
      this.unisonPanR[i] = Math.sin(angle);
    }
  }

  setRelease(ms: number) {
    this.releaseSamples = Math.max(0, (ms / 1000) * this.sampleRate);
  }

  private triggerOnset(size: number) {
    this.filterEnvLeft = Math.max(1, (this.vector.filterDecayMs / 1000) * this.sampleRate);
    this.pitchEnvTotal = Math.max(0, (this.vector.pitchEnvMs / 1000) * this.sampleRate);
    this.pitchEnvLeft = this.pitchEnvTotal;
    this.attackLeft = Math.max(1, (this.vector.attackMs / 1000) * this.sampleRate);
    this.transientLeft = Math.max(1, 0.008 * this.sampleRate);
    this.onsetSize = size;
    this.onsetCutoff = 1;
    if (this.driftAmount > 0) {
      this.onsetCutoff = 1 + (this.rng() * 2 - 1) * 0.15 * this.driftAmount;
      for (let u = 0; u < this.unisonPhases.length; u++) this.unisonPhases[u] = this.rng() * 2 * Math.PI;
    }
  }

  private softDrive(x: number): number {
    const d = 1 + this.vector.drive * 4;
    return Math.tanh(x * d) / Math.tanh(d);
  }

  /** Returns stereo sample before external gain. */
  processSample(midiY: number, size: number, lightness: number): [number, number] {
    let silent = size <= 1e-6;
    // The note curve fades to zero in about 20 ms. Take over from the peak so the tail is audible.
    if (!silent && this.releaseSamples > 0 && this.notePeak > 0.05 && size < this.notePeak * 0.25) silent = true;
    let playMidi = midiY;
    let playSize = size;
    let playLight = lightness;
    if (!silent) {
      if (this.wasSilent) {
        this.triggerOnset(size);
        this.notePeak = 0;
        this.releaseLeft = 0;
      }
      this.wasSilent = false;
      this.lastMidi = midiY;
      this.lastLight = lightness;
      this.lastSize = size;
      if (size > this.notePeak) this.notePeak = size;
    } else if (this.releaseSamples > 0 && this.notePeak > 1e-3) {
      if (this.releaseLeft <= 0) {
        this.releaseLeft = this.releaseSamples;
        this.lastSize = Math.max(this.lastSize, this.notePeak);
      }
      this.releaseLeft--;
      if (this.releaseLeft <= 0) {
        this.notePeak = 0;
        this.wasSilent = true;
        this.smoothGain *= this.gainSmoothCoeff;
        return [0, 0];
      }
      playMidi = this.lastMidi;
      playLight = this.lastLight;
      playSize = this.lastSize * (this.releaseLeft / this.releaseSamples);
    } else {
      this.wasSilent = true;
      this.releaseLeft = 0;
      this.notePeak = 0;
      this.smoothGain *= this.gainSmoothCoeff;
      return [0, 0];
    }

    let freq = midiToFrequency(playMidi);
    if (this.pitchEnvLeft > 0 && this.pitchEnvTotal > 0) {
      const env = this.pitchEnvLeft / this.pitchEnvTotal;
      freq *= Math.pow(2, (this.vector.pitchEnvSemis * env * env) / 12);
      this.pitchEnvLeft--;
    }

    let attackGain = 1;
    if (this.attackLeft > 0) {
      attackGain = 1 - this.attackLeft / ((this.vector.attackMs / 1000) * this.sampleRate);
      this.attackLeft--;
    }

    let l = 0;
    let r = 0;
    const spread = this.vector.detuneCents;
    for (let u = 0; u < this.vector.unison; u++) {
      if (this.driftAmount > 0) {
        this.drift[u] += (this.rng() * 2 - 1 - this.drift[u]) * this.driftCoeff;
      }
      const detune =
        (this.vector.unison === 1 ? 0 : spread * (u / (this.vector.unison - 1) - 0.5) * 2) +
        this.drift[u] * 6 * this.driftAmount;
      const f = freq * Math.pow(2, detune / 1200);
      const omega = (2 * Math.PI * f) / this.sampleRate;
      this.unisonPhases[u] += omega;
      if (this.unisonPhases[u] > 2 * Math.PI) this.unisonPhases[u] -= 2 * Math.PI;
      const osc = readWavetable(this.wt, this.unisonPhases[u], f, this.sampleRate);
      l += osc * this.unisonPanL[u];
      r += osc * this.unisonPanR[u];
    }
    const norm = this.vector.unison > 0 ? 1 / Math.sqrt(this.vector.unison) : 1;
    l *= norm;
    r *= norm;

    const noiseIn = (this.rng() * 2 - 1) * this.vector.noise;
    const nCenter = 200 + this.vector.noiseColor * 10000;
    const noise = this.noiseBp.process(noiseIn, nCenter, this.sampleRate);
    let mixL = l * (1 - this.vector.noise * 0.6) + noise * 0.5;
    let mixR = r * (1 - this.vector.noise * 0.6) + noise * 0.5;

    if (this.transientLeft > 0) {
      const click = (this.rng() * 2 - 1) * this.vector.transient;
      mixL += click;
      mixR += click;
      this.transientLeft--;
    }

    const vel = Math.pow(2, this.velocity * (this.onsetSize - 0.7) * 2);
    let cutoff = lightnessToCutoff(playLight, freq) * this.onsetCutoff * vel;
    if (this.filterEnvLeft > 0) {
      const envT = this.filterEnvLeft / ((this.vector.filterDecayMs / 1000) * this.sampleRate);
      cutoff *= 1 + this.vector.filterEnv * vel * envT * envT * 3;
      this.filterEnvLeft--;
    }

    mixL = this.filterL.process(mixL, cutoff, this.vector.resonance, this.sampleRate);
    mixR = this.filterR.process(mixR, cutoff, this.vector.resonance, this.sampleRate);

    mixL = this.softDrive(mixL);
    mixR = this.softDrive(mixR);

    this.smoothGain = this.smoothGain * this.gainSmoothCoeff + playSize * (1 - this.gainSmoothCoeff);
    const g = this.smoothGain * attackGain;
    return [mixL * g, mixR * g];
  }

  reset() {
    this.smoothGain = 0;
    this.wasSilent = true;
    this.unisonPhases.fill(0);
    this.filterL.reset();
    this.filterR.reset();
    this.filterEnvLeft = 0;
    this.pitchEnvLeft = 0;
    this.attackLeft = 0;
    this.transientLeft = 0;
  }
}

/** @deprecated */
export class SimpleSynth {
  private voice: Voice;
  constructor(sampleRate: number, seed = 0) {
    this.voice = new Voice(sampleRate, 180, seed);
  }
  synthesize(frequency: number, gain: number, _p: unknown, n: number): Float32Array {
    const buf = new Float32Array(n);
    const midi = 69 + 12 * Math.log2(frequency / 440);
    for (let i = 0; i < n; i++) {
      const [l, r] = this.voice.processSample(midi, gain, 0.5);
      buf[i] = (l + r) * 0.5;
    }
    return buf;
  }
  reset() {
    this.voice.reset();
  }
}

export type SynthParams = { brightness: number; thickness: number; noise: number };
