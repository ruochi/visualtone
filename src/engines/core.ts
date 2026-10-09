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
  /**
   * Depth at `vibratoHighMidi`. Between `vibratoLowMidi` and that note, depth
   * ramps from `vibratoCents`. Unset keeps one depth for every pitch.
   */
  vibratoHighCents?: number;
  vibratoLowMidi?: number;
  vibratoHighMidi?: number;
  /**
   * Each vibrato cycle aims for a new depth, this fraction above or below the mean.
   * 0.1 is about ±10%. Unset keeps a steady sine, sample for sample.
   */
  vibratoDepthJitter?: number;
  /** Same, for the vibrato rate. */
  vibratoRateJitter?: number;
}

export interface PitchLife {
  /** Call on note-on so a pitch ramp can pick the depth. A no-op when the ramp is unset. */
  pitch(midi: number): void;
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
  let depthCents = spec.vibratoCents;
  const depthJitter = spec.vibratoDepthJitter ?? 0;
  const rateJitter = spec.vibratoRateJitter ?? 0;
  const jittered = depthJitter > 0 || rateJitter > 0;
  let depthScale = 1;
  let rateScale = 1;
  let depthTarget = 1;
  let rateTarget = 1;
  const life: PitchLife = {
    ratio: 1,
    gain: 1,
    pitch(midi: number) {
      const high = spec.vibratoHighCents;
      if (high === undefined) return;
      const lo = spec.vibratoLowMidi ?? 48;
      const hi = spec.vibratoHighMidi ?? 84;
      const span = hi - lo;
      const u = span === 0 ? 1 : Math.max(0, Math.min(1, (midi - lo) / span));
      depthCents = spec.vibratoCents + (high - spec.vibratoCents) * u;
    },
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
      if (depthCents > 0) {
        const grow = Math.max(0, Math.min(1, (t - spec.vibratoDelaySec) / rampSec));
        const depth = depthCents * grow * grow * (3 - 2 * grow);
        const rate = spec.vibratoHz * (1 + wander * 0.03) * (jittered ? rateScale : 1);
        phase += (2 * Math.PI * rate) / sampleRate;
        if (phase > Math.PI * 2) {
          phase -= Math.PI * 2;
          if (jittered) {
            if (depthJitter > 0) depthTarget = 1 + (rng() * 2 - 1) * depthJitter;
            if (rateJitter > 0) rateTarget = 1 + (rng() * 2 - 1) * rateJitter;
          }
        }
        if (jittered) {
          const follow = 1 - Math.exp(-1 / (0.12 * sampleRate));
          depthScale += (depthTarget - depthScale) * follow;
          rateScale += (rateTarget - rateScale) * follow;
        }
        const used = jittered ? depth * depthScale : depth;
        vib = Math.sin(phase) * (used / Math.max(1e-9, depthCents));
        cents += vib * depthCents;
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
