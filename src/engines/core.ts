import { mulberry32 } from '../synth.js';

export interface Engine {
  setRelease(ms: number): void;
  processSample(midi: number, size: number, lightness: number): [number, number];
}

export interface PitchLifeSpec {
  /** Vibrato depth in cents once it has grown in. */
  vibratoCents: number;
  vibratoHz: number;
  /** A player starts the note straight and leans into vibrato after this long. */
  vibratoDelaySec: number;
  /** Slow random pitch motion, standard deviation in cents. */
  wanderCents: number;
  /** Bow pressure follows the vibrato, so the level moves with it by this fraction. */
  vibratoGain: number;
  /** RMS of irregular loudness motion between 8 and 20 Hz. 0.032 reads as about −30 dB. */
  shimmerRms: number;
}

export interface PitchLife {
  start(): void;
  /** Advance one sample. Sets `ratio` (frequency multiplier) and `gain`. */
  step(): void;
  ratio: number;
  gain: number;
}

/** Held notes from a player never sit on one frequency. Recordings show vibrato on strings and a few cents of drift on winds. */
export function createPitchLife(sampleRate: number, spec: PitchLifeSpec, seed: number): PitchLife {
  const rng = mulberry32(((seed || 1) * 2654435761) >>> 0 || 7);
  const gauss = () => (rng() + rng() + rng() - 1.5) * 2;
  const wanderAmp = spec.wanderCents * 1.25;
  const wanderInc = 1 / (0.3 * sampleRate);
  const rampSec = 0.35;
  const shimmerHz = [8.6, 11.4, 14.2, 17.5];
  const shimmerPhase = [0, 0, 0, 0];
  const shimmerFreq = [0, 0, 0, 0];
  let t = 0;
  let phase = 0;
  let w0 = 0;
  let w1 = 0;
  let wPos = 0;
  const life: PitchLife = {
    ratio: 1,
    gain: 1,
    start() {
      t = 0;
      phase = 0;
      w0 = 0;
      w1 = gauss();
      wPos = 0;
      for (let i = 0; i < shimmerHz.length; i++) {
        shimmerPhase[i] = rng() * Math.PI * 2;
        shimmerFreq[i] = Math.min(19.2, Math.max(8.2, shimmerHz[i] * (0.94 + rng() * 0.12)));
      }
    },
    step() {
      wPos += wanderInc;
      if (wPos >= 1) {
        wPos -= 1;
        w0 = w1;
        w1 = gauss();
      }
      const k = 0.5 - 0.5 * Math.cos(Math.PI * wPos);
      const wander = w0 + (w1 - w0) * k;
      let cents = wander * wanderAmp;
      let vib = 0;
      if (spec.vibratoCents > 0) {
        const grow = Math.max(0, Math.min(1, (t - spec.vibratoDelaySec) / rampSec));
        const depth = spec.vibratoCents * grow * grow * (3 - 2 * grow);
        phase += (2 * Math.PI * spec.vibratoHz * (1 + wander * 0.03)) / sampleRate;
        if (phase > Math.PI * 2) phase -= Math.PI * 2;
        vib = Math.sin(phase) * (depth / Math.max(1e-9, spec.vibratoCents));
        cents += vib * spec.vibratoCents;
      }
      t += 1 / sampleRate;
      life.ratio = Math.exp(cents * (Math.LN2 / 1200));
      // A handful of incommensurate rates, so this is not a tremolo. Recorded notes move here; a fixed loop does not.
      let shimmer = 1;
      if (spec.shimmerRms > 0) {
        let s = 0;
        for (let i = 0; i < shimmerHz.length; i++) {
          shimmerPhase[i] += (2 * Math.PI * shimmerFreq[i]) / sampleRate;
          if (shimmerPhase[i] > Math.PI * 2) shimmerPhase[i] -= Math.PI * 2;
          s += Math.sin(shimmerPhase[i]);
        }
        shimmer = 1 + spec.shimmerRms * (s / Math.SQRT2);
      }
      life.gain = (1 + vib * spec.vibratoGain) * shimmer;
    },
  };
  return life;
}
