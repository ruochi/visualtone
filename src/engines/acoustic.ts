import { midiToFrequency, mulberry32 } from '../synth.js';

export interface Engine {
  setRelease(ms: number): void;
  processSample(midi: number, size: number, lightness: number): [number, number];
}

/** Karplus–Strong plucked string. Hue darkens the excitation; lightness lengthens the ring. */
export function createPluck(sampleRate: number, hue: number, seed: number): Engine {
  const rng = mulberry32(seed || 1);
  let bufL: Float32Array | null = null;
  let bufR: Float32Array | null = null;
  let iL = 0;
  let iR = 0;
  let prevL = 0;
  let prevR = 0;
  let env = 0;
  let wasOn = false;
  let releaseLeft = 0;
  let releaseSamples = Math.floor(0.12 * sampleRate);

  return {
    setRelease(ms: number) {
      releaseSamples = Math.max(1, Math.floor((ms / 1000) * sampleRate));
    },
    processSample(midi, size, lightness) {
      const on = size > 1e-5;
      if (on && !wasOn) {
        const freq = Math.max(30, midiToFrequency(midi));
        const n = Math.max(8, Math.round(sampleRate / freq));
        bufL = new Float32Array(n);
        bufR = new Float32Array(n + 2);
        const bright = 1 - hue / 360;
        for (let i = 0; i < n; i++) {
          const noise = rng() * 2 - 1;
          bufL[i] = noise * (0.4 + 0.6 * bright);
        }
        for (let i = 0; i < bufR.length; i++) bufR[i] = (rng() * 2 - 1) * (0.4 + 0.6 * bright);
        // A short average takes the edge off darker hues.
        if (bright < 0.7) {
          for (let i = 1; i < bufL.length; i++) bufL[i] = bufL[i] * 0.6 + bufL[i - 1] * 0.4;
        }
        iL = 0;
        iR = 0;
        prevL = 0;
        prevR = 0;
        env = size;
        releaseLeft = releaseSamples;
      }
      wasOn = on;
      if (!bufL || !bufR) return [0, 0];
      if (!on) {
        if (releaseLeft <= 0) return [0, 0];
        releaseLeft--;
      } else {
        releaseLeft = releaseSamples;
      }
      const loss = 0.94 + Math.min(1, Math.max(0, lightness)) * 0.055;
      const step = (buf: Float32Array, idx: number, prev: number): [number, number] => {
        const out = buf[idx];
        const next = ((out + prev) * 0.5) * loss;
        buf[idx] = next;
        return [out, (idx + 1) % buf.length];
      };
      const [outL, nL] = step(bufL, iL, prevL);
      const [outR, nR] = step(bufR, iR, prevR);
      prevL = outL;
      prevR = outR;
      iL = nL;
      iR = nR;
      const g = env * (on ? 1 : releaseLeft / releaseSamples);
      return [outL * g, outR * g];
    },
  };
}

/** Modal mallet. Hue scales the upper modes; lightness scales how loud they start. */
export function createMarimba(sampleRate: number, hue: number, _seed: number): Engine {
  const ratios = [1, 3.92, 9.15, 15.8];
  const decays = [0.55, 0.18, 0.07, 0.035];
  const phases = [0, 0, 0, 0];
  const amps = [0, 0, 0, 0];
  let freq = 440;
  let wasOn = false;
  let alive = 0;

  return {
    setRelease(ms: number) {
      decays[0] = Math.max(0.2, ms / 1000);
    },
    processSample(midi, size, lightness) {
      const on = size > 1e-5;
      if (on && !wasOn) {
        freq = Math.max(40, midiToFrequency(midi));
        const tilt = 0.25 + (hue / 360) * 0.75;
        const open = 0.35 + lightness * 0.9;
        for (let m = 0; m < ratios.length; m++) {
          phases[m] = 0;
          amps[m] = size * (m === 0 ? 1 : (open * tilt) / (m + 1));
        }
        alive = sampleRate * 2;
      }
      wasOn = on;
      if (alive <= 0) return [0, 0];
      alive--;
      let l = 0;
      let r = 0;
      for (let m = 0; m < ratios.length; m++) {
        const f = freq * ratios[m];
        if (f > sampleRate * 0.45) continue;
        phases[m] += (2 * Math.PI * f) / sampleRate;
        amps[m] *= Math.exp(-1 / (decays[m] * sampleRate));
        const s = Math.sin(phases[m]) * amps[m];
        l += s;
        r += s * (m % 2 === 0 ? 1 : 0.85);
      }
      return [l * 0.45, r * 0.45];
    },
  };
}

/** Two-operator FM electric piano. Hue picks the modulator ratio. */
export function createEpiano(sampleRate: number, hue: number, _seed: number): Engine {
  let car = 0;
  let mod = 0;
  let index = 0;
  let env = 0;
  let wasOn = false;
  let freq = 440;
  const ratio = 1 + Math.round((hue / 360) * 6);

  return {
    setRelease() {},
    processSample(midi, size, lightness) {
      const on = size > 1e-5;
      if (on && !wasOn) {
        freq = Math.max(30, midiToFrequency(midi));
        index = 1.2 + lightness * 3.5;
        env = size;
        car = 0;
        mod = 0;
      }
      wasOn = on;
      if (env < 1e-5 && index < 1e-4) return [0, 0];
      env *= Math.exp(-1 / (0.55 * sampleRate));
      index *= Math.exp(-1 / ((0.18 + lightness * 0.25) * sampleRate));
      mod += (2 * Math.PI * freq * ratio) / sampleRate;
      car += (2 * Math.PI * freq) / sampleRate;
      const s = Math.sin(car + Math.sin(mod) * index) * env;
      const s2 = Math.sin(car * 1.003 + Math.sin(mod + 0.2) * index) * env;
      return [s * 0.4, s2 * 0.4];
    },
  };
}

export function createEngine(
  name: 'pluck' | 'marimba' | 'epiano',
  sampleRate: number,
  hue: number,
  seed: number,
): Engine {
  if (name === 'pluck') return createPluck(sampleRate, hue, seed);
  if (name === 'marimba') return createMarimba(sampleRate, hue, seed);
  return createEpiano(sampleRate, hue, seed);
}
