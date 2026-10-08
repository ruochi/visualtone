import { midiToFrequency, mulberry32 } from '../synth.js';

export interface Engine {
  setRelease(ms: number): void;
  processSample(midi: number, size: number, lightness: number): [number, number];
}

interface PitchLifeSpec {
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

interface PitchLife {
  start(): void;
  /** Advance one sample. Sets `ratio` (frequency multiplier) and `gain`. */
  step(): void;
  ratio: number;
  gain: number;
}

/** Held notes from a player never sit on one frequency. Recordings show vibrato on strings and a few cents of drift on winds. */
function createPitchLife(sampleRate: number, spec: PitchLifeSpec, seed: number): PitchLife {
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

interface PluckString {
  buf: Float32Array;
  w: number;
  prev: number;
  apx: number;
  apy: number;
  bz1: number;
  bz2: number;
}

/** Karplus–Strong string. Fractional delay keeps the pitch; size moves the pluck toward the bridge. */
export function createPluck(sampleRate: number, hue: number, seed: number): Engine {
  const rng = mulberry32(seed || 1);
  const hueW = ((hue % 360) + 360) % 360;
  const bright = 1 - hueW / 360;
  // 0°–139° steel guitar, 140°–279° nylon, 280°–360° harp. Hue 70 stays the steel pluck.
  const family = hueW >= 280 ? 'harp' : hueW >= 140 ? 'nylon' : 'steel';
  const bodyHz = family === 'harp' ? 220 : family === 'nylon' ? 150 : 118;
  let left: PluckString | null = null;
  let right: PluckString | null = null;
  let rightZ = 0;
  let env = 0;
  let wasOn = false;
  let releaseLeft = 0;
  let releaseSamples = Math.floor(0.12 * sampleRate);
  let harpPole = 0.8;
  let harpLpL = 0;
  let harpLpR = 0;
  let periodSamp = 32;
  let delaySamp = 30;
  let frac = 0;
  let disp = -0.28;
  let avg = 0.5;

  const bodyW = (2 * Math.PI * bodyHz) / sampleRate;
  const bodyAlpha = Math.sin(bodyW) / 8;
  const bodyA0 = 1 + bodyAlpha;
  const bodyB0 = bodyAlpha / bodyA0;
  const bodyB2 = -bodyAlpha / bodyA0;
  const bodyA1 = (-2 * Math.cos(bodyW)) / bodyA0;
  const bodyA2 = (1 - bodyAlpha) / bodyA0;

  const excite = (beta: number, pole: number): Float32Array => {
    const L = Math.max(4, Math.floor(delaySamp) + 1);
    const burst = new Float32Array(L);
    let prev = 0;
    for (let i = 0; i < L; i++) {
      const n = rng() * 2 - 1;
      prev = n * (1 - pole) + prev * pole;
      burst[i] = prev;
    }
    prev = 0;
    for (let i = 0; i < L; i++) {
      prev = burst[i] * (1 - pole) + prev * pole;
      burst[i] = prev;
    }
    const comb = Math.max(1, Math.min(L - 2, Math.round(beta * L)));
    for (let i = L - 1; i >= comb; i--) burst[i] -= burst[i - comb];
    let e = 0;
    for (let i = 0; i < L; i++) e += burst[i] * burst[i];
    const scale = (0.45 + 0.4 * bright) / (Math.sqrt(e / L) + 1e-8);
    for (let i = 0; i < L; i++) burst[i] *= scale;
    return burst;
  };

  const make = (beta: number, pole: number): PluckString => ({
    buf: excite(beta, pole),
    w: 0,
    prev: 0,
    apx: 0,
    apy: 0,
    bz1: 0,
    bz2: 0,
  });

  const step = (s: PluckString, loss: number): number => {
    const L = s.buf.length;
    const age0 = Math.max(1, Math.floor(delaySamp));
    const i0 = (s.w - age0 + L * 8) % L;
    const i1 = (s.w - age0 - 1 + L * 8) % L;
    const delayed = s.buf[i0] * (1 - frac) + s.buf[i1] * frac;
    const y = disp * delayed + s.apx - disp * s.apy;
    s.apx = delayed;
    s.apy = y;
    const filtered = ((1 - avg) * y + avg * s.prev) * loss;
    s.prev = y;
    s.buf[s.w] = filtered;
    s.w = (s.w + 1) % L;
    const body = bodyB0 * delayed + s.bz1;
    s.bz1 = -bodyA1 * body + s.bz2;
    s.bz2 = bodyB2 * delayed - bodyA2 * body;
    return delayed + body * 0.18;
  };

  return {
    setRelease(ms: number) {
      releaseSamples = Math.max(1, Math.floor((ms / 1000) * sampleRate));
    },
    processSample(midi, size, lightness) {
      const on = size > 1e-5;
      if (on && !wasOn) {
        const freq = Math.min(sampleRate * 0.2, Math.max(30, midiToFrequency(midi)));
        periodSamp = sampleRate / freq;
        disp = family === 'harp' ? -0.02 : family === 'nylon' ? -0.12 : -0.18 - (1 - bright) * 0.22;
        // Less averaging keeps the upper partials alive, so a harder pluck stays bright.
        // Short loops need more averaging or harmonics alias and the note reads darker.
        const guard = Math.min(0.55, 20 / periodSamp);
        avg = Math.min(0.62, Math.max(guard, 0.78 - size * 0.78 - (lightness - 0.5) * 0.08));
        if (family === 'harp') avg = Math.min(0.78, Math.max(guard * 0.5, 0.66 - size * 0.16));
        if (family === 'nylon') avg = Math.min(0.68, avg + 0.08);
        const w0 = (2 * Math.PI) / periodSamp;
        const cos0 = Math.cos(w0);
        const b0 = 1 - avg;
        const b1 = avg;
        const avgDelay = (b1 * (b1 + b0 * cos0)) / (b0 * b0 + b1 * b1 + 2 * b0 * b1 * cos0);
        const dispDelay = (1 - disp * disp) / (1 + 2 * disp * cos0 + disp * disp);
        delaySamp = Math.max(2, periodSamp - avgDelay - dispDelay);
        frac = delaySamp - Math.floor(delaySamp);
        let beta = Math.min(0.48, Math.max(0.07, 0.47 - size * 0.36 - (lightness - 0.5) * 0.1));
        let pole = Math.min(0.92, Math.max(0.05, 0.72 - size * 0.7 + (1 - bright) * 0.2));
        // A harp is plucked nearer the center, so the octave is quieter and the ring is longer.
        if (family === 'harp') {
          beta = Math.min(0.48, 0.44 - size * 0.04);
          pole = Math.min(0.94, 0.86 - size * 0.12);
          harpPole = Math.exp((-2 * Math.PI * (380 + size * 420)) / sampleRate);
          harpLpL = 0;
          harpLpR = 0;
        } else if (family === 'nylon') {
          pole = Math.min(0.9, pole + 0.1);
        }
        left = make(beta, pole);
        right = make(Math.min(0.48, beta + 0.02), pole);
        rightZ = 0;
        env = size;
        releaseLeft = releaseSamples;
      }
      wasOn = on;
      if (!left || !right) return [0, 0];
      if (!on) {
        if (releaseLeft <= 0) return [0, 0];
        releaseLeft--;
      } else {
        releaseLeft = releaseSamples;
      }
      const loss =
        family === 'harp'
          ? 0.992 + Math.min(1, Math.max(0, lightness)) * 0.006
          : 0.982 + Math.min(1, Math.max(0, lightness)) * 0.014;
      const outL = step(left, loss);
      const rawR = step(right, loss);
      const outR = rightZ;
      rightZ = rawR;
      const g = env * (on ? 1 : releaseLeft / releaseSamples);
      if (family === 'harp') {
        const a = 1 - harpPole;
        harpLpL = outL * a + harpLpL * harpPole;
        harpLpR = outR * a + harpLpR * harpPole;
        return [harpLpL * g, harpLpR * g];
      }
      return [outL * g, outR * g];
    },
  };
}

/** Modal mallet. Hue picks the bar: marimba, xylophone, vibraphone, glockenspiel. */
interface MalletSpec {
  ratios: number[];
  /** Seconds at 220 Hz. Higher notes are shorter. The held fundamental is not replaced by release. */
  decays: number[];
  /** Upper-mode levels at a hard strike, before the pitch roll-off. */
  gains: number[];
  tremHz: number;
  /** Decay shortens as (f/220)^pitchPow. */
  pitchPow: number;
  /** First upper mode holds until this MIDI, then fades out by rollEnd. */
  rollStart: number;
  rollEnd: number;
  /** Extra level on the ~9–10× mode, full at lowMidi and gone lowWidth semitones higher. */
  lowMode: number;
  lowMidi: number;
  lowWidth: number;
  /** Short mallet tick, so the bar is not a pure sine. */
  noise: number;
  /** Highpassed knock, Hz. 0 skips it. Fades out by hissUntil. */
  hissHz: number;
  hissUntil: number;
  /** Metal bars: the second mode grows with pitch and the fifth shrinks. */
  glock: boolean;
}

function malletSpec(hue: number): MalletSpec {
  const h = ((hue % 360) + 360) % 360;
  if (h < 120) {
    // Rosewood: the ~4× mode sits under the fundamental, and the ~10× mode is only on the long bars.
    return {
      ratios: [1, 3.92, 10.08, 15.8],
      decays: [1.2, 0.36, 0.14, 0.06],
      gains: [0.55, 0.02, 0.05],
      tremHz: 0,
      pitchPow: 1.35,
      rollStart: 70,
      rollEnd: 77,
      lowMode: 1.05,
      lowMidi: 46,
      lowWidth: 10,
      noise: 0.4,
      hissHz: 1200,
      hissUntil: 96,
      glock: false,
    };
  }
  if (h < 200) {
    // Hardwood: a quiet third, fading to a sine at the top of the instrument.
    return {
      ratios: [1, 3, 6.05, 9.4],
      decays: [0.7, 0.22, 0.1, 0.05],
      gains: [0.16, 0.07, 0.03],
      tremHz: 0,
      pitchPow: 1.05,
      rollStart: 86,
      rollEnd: 98,
      lowMode: 0,
      lowMidi: 0,
      lowWidth: 0,
      noise: 0.28,
      hissHz: 600,
      hissUntil: 120,
      glock: false,
    };
  }
  if (h < 280) {
    // No recording in the catalog. Gains make up for the softer strike opening so the tremolo bar stays bright.
    return {
      ratios: [1, 3.97, 9.2, 14.6],
      decays: [1.8, 0.75, 0.28, 0.11],
      gains: [1.05, 0.46, 0.2],
      tremHz: 5.5,
      pitchPow: 0.75,
      rollStart: 96,
      rollEnd: 120,
      lowMode: 0,
      lowMidi: 0,
      lowWidth: 0,
      noise: 0.12,
      hissHz: 1600,
      hissUntil: 96,
      glock: false,
    };
  }
  // Steel: long ring. The 2.76 mode catches up to the fundamental as the bar shortens; 5.4 does the opposite.
  return {
    ratios: [1, 2.76, 5.4, 8.93],
    decays: [2.4, 1.6, 1.8, 0.6],
    gains: [0.85, 0.7, 0.2],
    tremHz: 0,
    pitchPow: 0.45,
    rollStart: 90,
    rollEnd: 108,
    lowMode: 0,
    lowMidi: 0,
    lowWidth: 0,
    noise: 0.22,
    hissHz: 0,
    hissUntil: 0,
    glock: true,
  };
}

export function createMarimba(sampleRate: number, hue: number, seed: number): Engine {
  const spec = malletSpec(hue);
  const rng = mulberry32(seed || 1);
  const n = spec.ratios.length;
  const phases = new Array(n).fill(0);
  const amps = new Array(n).fill(0);
  const taus = new Array(n).fill(0.2);
  let freq = 440;
  let wasOn = false;
  let alive = 0;
  let releaseSec = 0.18;
  let trem = 0;
  let tickLeft = 0;
  let tickTotal = 1;
  let tickAmp = 0;
  let tickLp = 0;
  let tickPole = 0.5;
  let hiss = 0;
  let hissTau = 0.05;
  let hissAmp = 0;
  let hissPole = 0.5;
  let hissHp = 0;

  return {
    setRelease(ms: number) {
      releaseSec = Math.max(0.04, ms / 1000);
    },
    processSample(midi, size, lightness) {
      const on = size > 1e-5;
      if (on && !wasOn) {
        freq = Math.max(40, midiToFrequency(midi));
        const pitchScale = Math.pow(freq / 220, spec.pitchPow);
        const strike = Math.min(1, Math.max(0, size));
        const light = Math.min(1, Math.max(0, lightness));
        // Soft hits lose the upper modes. The old linear open left them louder than the fundamental.
        const open = Math.pow(strike, 1.4) * (0.7 + light * 0.4);
        const span = Math.max(1, spec.rollEnd - spec.rollStart);
        const rollT = Math.min(1, Math.max(0, (midi - spec.rollStart) / span));
        const roll = 1 - Math.pow(rollT, 1.4);
        const hang = 0.35 + strike * 1.35;
        const high = Math.min(1, Math.max(0, (midi - 79) / 17));
        for (let m = 0; m < n; m++) {
          taus[m] = Math.max(0.025, (spec.decays[m] * (m === 0 ? 1 : hang)) / pitchScale);
          let rel = 1;
          if (m > 0) {
            const fade = m === 1 ? roll : roll * roll;
            rel = spec.gains[m - 1] * open * fade;
            if (m === 2 && spec.lowWidth > 0) {
              const low = Math.min(1, Math.max(0, (spec.lowMidi + spec.lowWidth - midi) / spec.lowWidth));
              rel += low * spec.lowMode;
            }
            if (spec.glock) {
              // 2.76 catches the fundamental on the short bars. 5.4 stays under it.
              // Below the recorded range both stay quiet: a hard low bar was locking to f/5.
              const strikeScale = Math.pow(Math.min(1.35, strike / 0.7), 1.2);
              const safe = Math.min(1, Math.max(0, (midi - 68) / 16));
              if (m === 1) rel = (0.1 + safe * (0.42 + high * high * 0.38)) * strikeScale;
              else if (m === 2) rel = (0.05 + safe * 0.12 * (1 - high)) * strikeScale;
              else rel = 0.05 * safe * (1 - high) * strikeScale;
            }
          }
          phases[m] = m === 0 ? 0 : rng() * 2 * Math.PI;
          amps[m] = size * rel;
        }
        tickTotal = Math.max(1, Math.round(0.012 * sampleRate));
        tickLeft = tickTotal;
        tickAmp = spec.noise * (0.25 + strike * 0.55);
        tickPole = Math.exp((-2 * Math.PI * (1600 + strike * 6000)) / sampleRate);
        tickLp = 0;
        // Low bars in the recordings carry a noisy knock for a few hundred milliseconds.
        const low = Math.min(1, Math.max(0, (58 - midi) / 14));
        const hissFade = Math.min(1, Math.max(0, (spec.hissUntil - midi) / 12));
        hiss = 1;
        hissTau = 0.025 + low * 0.05;
        hissAmp = spec.hissHz > 0 ? spec.noise * Math.pow(strike, 1.8) * (0.15 + low * 0.7) * hissFade : 0;
        const hissCut = spec.hissHz > 0 ? spec.hissHz + strike * 800 : 1000;
        hissPole = Math.exp((-2 * Math.PI * hissCut) / sampleRate);
        hissHp = 0;
        alive = Math.ceil(sampleRate * (spec.glock ? 8 : 4));
        trem = 0;
      }
      if (!on && wasOn) {
        const cap = releaseSec / 6;
        for (let m = 0; m < n; m++) taus[m] = Math.min(taus[m], cap);
      }
      wasOn = on;
      if (alive <= 0) return [0, 0];
      alive--;
      let l = 0;
      let r = 0;
      let peakAmp = 0;
      for (let m = 0; m < n; m++) {
        const f = freq * spec.ratios[m];
        if (f >= sampleRate * 0.45) {
          amps[m] = 0;
          continue;
        }
        phases[m] += (2 * Math.PI * f) / sampleRate;
        if (phases[m] > 2 * Math.PI) phases[m] -= 2 * Math.PI;
        amps[m] *= Math.exp(-1 / (taus[m] * sampleRate));
        peakAmp = Math.max(peakAmp, Math.abs(amps[m]));
        const s = Math.sin(phases[m]) * amps[m];
        const side = m % 2 === 0 ? 1.05 : 0.95;
        l += s * side;
        r += s * (2 - side);
      }
      if (tickLeft > 0 || hiss > 1e-4) {
        const white = rng() * 2 - 1;
        if (tickLeft > 0) {
          const u = tickLeft / tickTotal;
          tickLeft--;
          const env = Math.sin(Math.PI * (1 - u));
          tickLp = white * (1 - tickPole) + tickLp * tickPole;
          const hit = tickLp * env * tickAmp;
          l += hit;
          r += hit * 0.9;
        }
        if (hiss > 1e-4) {
          hiss *= Math.exp(-1 / (hissTau * sampleRate));
          const lp = white * (1 - hissPole) + hissHp * hissPole;
          hissHp = lp;
          const knock = (white - lp) * hiss * hissAmp;
          l += knock;
          r += knock * 0.92;
        }
      }
      if (peakAmp < 1e-5 && tickLeft <= 0 && hiss <= 1e-4) {
        alive = 0;
        return [0, 0];
      }
      let g = 0.42;
      if (spec.tremHz > 0) {
        trem += (2 * Math.PI * spec.tremHz) / sampleRate;
        g *= 1 + 0.1 * Math.sin(trem);
      }
      return [l * g, r * g];
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

/** Drawbar organ. Hue walks the registration; size and lightness open the upper stops. */
const ORGAN_RATIOS = [0.5, 1.5, 1, 2, 3, 4, 5, 6, 8];
// Stopped flute (8' + odd partials), open flute 8'+4'+2', full mixture. Hue 0 and 360 are dark; 180 is full.
const ORGAN_REG = [
  [0.04, 0.015, 1, 0.006, 0.32, 0.004, 0.08, 0, 0],
  [0.16, 0.06, 1, 0.78, 0.12, 0.62, 0.04, 0.08, 0.2],
  [0.34, 0.28, 0.9, 0.74, 0.58, 0.68, 0.36, 0.3, 0.46],
];

function organRegistration(hue: number): number[] {
  const wrapped = ((hue % 360) + 360) % 360;
  const x = (1 - Math.cos((wrapped * Math.PI) / 180)) / 2;
  // Stay on the stopped flute through the first part of the hue walk.
  const pos = Math.pow(x, 2.4) * 2;
  const i = Math.min(1, Math.floor(pos));
  const f = pos - i;
  const out = new Array<number>(ORGAN_RATIOS.length);
  for (let k = 0; k < out.length; k++) out[k] = ORGAN_REG[i][k] * (1 - f) + ORGAN_REG[i + 1][k] * f;
  return out;
}

export function createOrgan(sampleRate: number, hue: number, seed: number): Engine {
  const base = organRegistration(hue);
  const phases = new Array(ORGAN_RATIOS.length).fill(0);
  const amps = new Array(ORGAN_RATIOS.length).fill(0);
  let freq = 440;
  let env = 0;
  let perc = 0;
  let percPhase = 0;
  let wasOn = false;
  let heldSize = 0.5;
  let heldLight = 0.5;
  let releaseSec = 0.18;
  let attackCoeff = Math.exp(-1 / (0.03 * sampleRate));
  const ampCoeff = Math.exp(-1 / (0.015 * sampleRate));
  const stopBright = base[3] + base[5] + base[8];
  const percDecay = Math.exp(-1 / (0.16 * sampleRate));
  // Wind pressure moves the whole rank together, faster than a player's vibrato.
  const life = createPitchLife(
    sampleRate,
    { vibratoCents: 0, vibratoHz: 0, vibratoDelaySec: 0, wanderCents: 0, vibratoGain: 0, shimmerRms: 0.033 },
    seed,
  );

  const shape = (size: number, lightness: number, f0: number): number[] => {
    const open = Math.min(1.65, 0.15 + lightness * 0.7 + size * 1.05);
    const tilt = open * 0.9 - 0.55;
    // A stopped flute loses its upper odd partials as the pipe gets short.
    const stopped = base[3] + base[5] < 0.12;
    const high = Math.max(0, Math.min(1, (f0 - 90) / 700));
    const raw = new Array<number>(ORGAN_RATIOS.length);
    for (let i = 0; i < ORGAN_RATIOS.length; i++) {
      const ratio = ORGAN_RATIOS[i];
      const partial = f0 * ratio;
      const air = stopped ? Math.pow(0.22, high * Math.max(0, ratio - 1)) : 1;
      raw[i] = partial >= sampleRate * 0.45 ? 0 : base[i] * Math.pow(ratio, tilt) * air;
    }
    // The key's pitch is the 8' stop. A louder 16' makes the note read an octave low.
    if (raw[2] > 0 && raw[0] > raw[2] * 0.12) raw[0] = raw[2] * 0.12;
    const sumSq = raw.reduce((s, v) => s + v * v, 0);
    const norm = sumSq > 1e-10 ? 1 / Math.sqrt(sumSq) : 0;
    for (let i = 0; i < raw.length; i++) raw[i] *= norm;
    return raw;
  };

  return {
    setRelease(ms: number) {
      releaseSec = Math.max(0.008, ms / 1000);
    },
    processSample(midi, size, lightness) {
      const on = size > 1e-5;
      if (on) {
        freq = Math.max(20, midiToFrequency(midi));
        if (size > 0.02) {
          heldSize = size;
          heldLight = lightness;
        }
      }
      if (on && !wasOn) {
        life.start();
        const target = shape(size, lightness, freq);
        for (let i = 0; i < amps.length; i++) amps[i] = target[i];
        // A fresh note starts at zero amplitude, so aligning phases does not click.
        if (env < 1e-4) {
          phases.fill(0);
          percPhase = 0;
        }
        perc = Math.min(0.55, 0.06 + stopBright * 0.4);
        // A long pipe speaks more slowly than a short one.
        const low = Math.max(0, Math.min(1, (84 - midi) / 60));
        attackCoeff = Math.exp(-1 / ((0.016 + low * 0.055) * sampleRate));
      }
      wasOn = on;
      if (!on && env < 1e-5 && perc < 1e-4) return [0, 0];
      life.step();

      const target = shape(heldSize, heldLight, freq);
      for (let i = 0; i < amps.length; i++) amps[i] = amps[i] * ampCoeff + target[i] * (1 - ampCoeff);

      // `release` is the time to about −60 dB, so the tail is finished inside the render window.
      const releaseCoeff = Math.exp(-6.9 / (releaseSec * sampleRate));
      const dest = on ? size : 0;
      env = dest + (env - dest) * (dest > env ? attackCoeff : releaseCoeff);
      perc *= percDecay;

      let l = 0;
      let r = 0;
      for (let i = 0; i < ORGAN_RATIOS.length; i++) {
        const partial = freq * ORGAN_RATIOS[i];
        if (partial >= sampleRate * 0.45) continue;
        phases[i] += (2 * Math.PI * partial) / sampleRate;
        if (phases[i] > 2 * Math.PI) phases[i] -= 2 * Math.PI;
        const s = Math.sin(phases[i]) * amps[i];
        const side = i % 2 === 0 ? 1.06 : 0.94;
        l += s * side;
        r += s * (2 - side);
      }
      // Percussion is the 4' harmonic, gone before the sustain measurement settles.
      const percFreq = freq * 4;
      if (percFreq < sampleRate * 0.45) {
        percPhase += (2 * Math.PI * percFreq) / sampleRate;
        const s = Math.sin(percPhase) * perc * 0.22;
        l += s;
        r += s;
      }
      const g = env * 0.28 * life.gain;
      return [l * g, r * g];
    },
  };
}

/** Ideal circular-membrane modes, as multiples of the first Bessel zero. `order` is the angular index. */
const DRUM_MODES: { ratio: number; order: number }[] = [
  { ratio: 1, order: 0 },
  { ratio: 1.593, order: 1 },
  { ratio: 2.136, order: 2 },
  { ratio: 2.295, order: 0 },
  { ratio: 2.654, order: 3 },
  { ratio: 2.917, order: 1 },
  { ratio: 3.155, order: 4 },
  { ratio: 3.5, order: 2 },
  { ratio: 3.598, order: 0 },
  { ratio: 4.059, order: 3 },
  { ratio: 4.832, order: 1 },
  { ratio: 5.54, order: 0 },
  { ratio: 6.25, order: 2 },
];

interface DrumSpec {
  /** Fundamental decay in seconds at 180 Hz. */
  tau: number;
  noise: number;
  click: number;
  /** Beater pitch drop, semitones, finished in about 30 ms. */
  bend: number;
}

function drumSpec(hue: number): DrumSpec {
  const h = ((hue % 360) + 360) % 360;
  if (h < 45) return { tau: 0.18, noise: 0.08, click: 0.7, bend: 4 };
  if (h < 140) return { tau: 0.42, noise: 0.015, click: 0.35, bend: 0 };
  if (h < 230) return { tau: 0.22, noise: 0.28, click: 0.45, bend: 0 };
  if (h < 310) return { tau: 0.55, noise: 0.03, click: 0.3, bend: 0 };
  return { tau: 0.7, noise: 0.05, click: 0.25, bend: 0 };
}

/** Modal drum. Hue picks kick, tom, snare, conga, or frame drum. */
export function createDrum(sampleRate: number, hue: number, seed: number): Engine {
  const spec = drumSpec(hue);
  const rng = mulberry32(seed || 1);
  const n = DRUM_MODES.length;
  const phases = new Array(n).fill(0);
  const amps = new Array(n).fill(0);
  const taus = new Array(n).fill(0.1);
  let freq = 180;
  let wasOn = false;
  let alive = 0;
  let releaseSec = 0.18;
  let bendLeft = 0;
  let bendTotal = 0;
  let clickLeft = 0;
  let clickAmp = 0;
  let beaterLeft = 0;
  let beaterTotal = 1;
  let beaterMix = 0;
  let beaterPole = 0.5;
  let beaterLp = 0;
  let nz = 0;
  let nh = 0;
  let wireLp = 0;
  let wirePole = 0.5;
  let noiseLeak = 0.82;
  let strikeNow = 0.5;

  return {
    setRelease(ms: number) {
      releaseSec = Math.max(0.04, ms / 1000);
    },
    processSample(midi, size, lightness) {
      const on = size > 1e-5;
      if (on && !wasOn) {
        freq = Math.max(20, midiToFrequency(midi));
        const strike = Math.min(1, Math.max(0, size));
        const center = Math.min(1, Math.max(0, lightness));
        const pitchScale = Math.pow(freq / 180, 0.72);
        for (let i = 0; i < n; i++) {
          const mode = DRUM_MODES[i];
          phases[i] = 0;
          const fund = mode.ratio === 1;
          // Overtones stay well under the fundamental, or the pitch tracker locks to a subharmonic.
          const edge = mode.order === 0 ? 1 : 0.45 + (1 - center) * 0.7;
          const over = fund ? 1 : (0.12 + strike * 0.16) * edge * Math.exp(-0.62 * (mode.ratio - 1));
          amps[i] = size * over;
          const hang = fund ? 1 : (0.18 + strike * 0.16) / Math.pow(mode.ratio, 0.35);
          taus[i] = Math.max(0.008, (spec.tau * hang) / pitchScale);
        }
        bendTotal = spec.bend > 0 ? Math.round(0.018 * sampleRate) : 0;
        bendLeft = bendTotal;
        clickAmp = spec.click * Math.pow(strike, 1.7) * 0.28;
        clickLeft = Math.round(0.006 * sampleRate);
        beaterTotal = Math.max(1, Math.round((0.012 + strike * 0.04) * sampleRate));
        beaterLeft = beaterTotal;
        // A soft hit stays dark. Linear beater mix left the quiet note brighter than the loud one.
        beaterMix = 0.04 + Math.pow(strike, 1.65) * 0.85;
        strikeNow = strike;
        noiseLeak = 0.94 - strike * 0.45;
        // The beater is a thud, not a bright tick. Snare noise opens the cutoff; a kick stays near the shell.
        let cut = 180 + strike * (650 + spec.noise * 5200) + (1 - center) * 350;
        if (spec.bend > 0) cut *= 0.48;
        wirePole = Math.exp((-2 * Math.PI * (1600 + strike * 1800)) / sampleRate);
        wireLp = 0;
        beaterPole = Math.exp((-2 * Math.PI * cut) / sampleRate);
        beaterLp = 0;
        alive = Math.ceil(sampleRate * 3);
        nz = 0;
        nh = 0;
      }
      if (!on && wasOn) {
        const cap = releaseSec / 6;
        for (let i = 0; i < n; i++) taus[i] = Math.min(taus[i], cap);
      }
      wasOn = on;
      if (alive <= 0) return [0, 0];
      alive--;

      let f0 = freq;
      if (bendLeft > 0 && bendTotal > 0) {
        const e = bendLeft / bendTotal;
        f0 *= Math.pow(2, (spec.bend * e * e) / 12);
        bendLeft--;
      }

      let l = 0;
      let r = 0;
      let peakAmp = 0;
      for (let i = 0; i < n; i++) {
        const f = f0 * DRUM_MODES[i].ratio;
        if (f >= sampleRate * 0.45) {
          amps[i] = 0;
          continue;
        }
        phases[i] += (2 * Math.PI * f) / sampleRate;
        if (phases[i] > 2 * Math.PI) phases[i] -= 2 * Math.PI;
        amps[i] *= Math.exp(-1 / (taus[i] * sampleRate));
        peakAmp = Math.max(peakAmp, Math.abs(amps[i]));
        const s = Math.sin(phases[i]) * amps[i];
        const side = i % 2 === 0 ? 1.04 : 0.96;
        l += s * side;
        r += s * (2 - side);
      }

      const white = rng() * 2 - 1;
      nh = white - nz + noiseLeak * nh;
      nz = white;
      beaterLp = white * (1 - beaterPole) + beaterLp * beaterPole;
      if (clickLeft > 0) {
        clickLeft--;
        const c = beaterLp * clickAmp * (clickLeft / Math.max(1, 0.006 * sampleRate));
        l += c;
        r += c;
      }
      if (beaterLeft > 0) {
        beaterLeft--;
        const envB = beaterLeft / beaterTotal;
        const b = beaterLp * envB * envB * beaterMix;
        l += b;
        r += b;
      }
      wireLp = nh * (1 - wirePole) + wireLp * wirePole;
      const wires = spec.noise > 0.15 ? wireLp : beaterLp;
      const buzz = wires * spec.noise * (0.22 + strikeNow * 0.7) * (0.25 + peakAmp);
      l += buzz;
      r += buzz * 0.92;

      if (peakAmp < 1e-5 && clickLeft <= 0) {
        alive = 0;
        return [0, 0];
      }
      return [l * 0.38, r * 0.38];
    },
  };
}

/**
 * Blown bore. Hue below 180 is a flute (open pipe, all harmonics).
 * From 180 it is a clarinet: half-period delay and a sign flip, so the bore is odd.
 * Even partials are added after the bore: a little in the chalumeau, a lot above the break.
 * An odd saturation sits in the loop, so the zeros — and the pitch — stay on the delay.
 */
export function createWind(sampleRate: number, hue: number, seed: number): Engine {
  const clarinet = ((hue % 360) + 360) % 360 >= 180;
  const rng = mulberry32(seed || 1);
  const buf = new Float32Array(4096);
  let w = 0;
  let prev = 0;
  let delaySamp = 32;
  let frac = 0;
  let avg = 0.3;
  let env = 0;
  let wasOn = false;
  let releaseSec = 0.18;
  let attackCoeff = 0.02;
  let releaseCoeff = Math.exp(-6.9 / (releaseSec * sampleRate));
  let nz = 0;
  let noisePole = 0.5;
  let strike = 0.5;
  let jet = 1.4;
  let even = 0;
  let evenMix = 0;
  let evenDc = 0;
  let evenArm = false;
  let octPole = 0.2;
  let octState = 0;
  let sqAvg = 0;
  let evenLp = 0;
  let evenPole = 0.4;
  let alive = 0;
  let smoothPole = 0.5;
  const smooth = [0, 0, 0, 0];
  let loopDelay = 32;
  let filterDelay = 0;
  let boreHpPole = 0;
  let boreX = 0;
  let boreY = 0;
  const life = createPitchLife(
    sampleRate,
    { vibratoCents: 0, vibratoHz: 0, vibratoDelaySec: 0, wanderCents: clarinet ? 2 : 3, vibratoGain: 0, shimmerRms: clarinet ? 0.022 : 0.032 },
    seed,
  );
  const dcPole = Math.exp((-2 * Math.PI * 24) / sampleRate);
  let dcX = 0;
  let dcY = 0;
  let dcX2 = 0;
  let dcY2 = 0;

  return {
    setRelease(ms: number) {
      releaseSec = Math.max(0.02, ms / 1000);
      releaseCoeff = Math.exp(-6.9 / (releaseSec * sampleRate));
    },
    processSample(midi, size, lightness) {
      const on = size > 1e-5;
      if (on && !wasOn) {
        const freq = Math.min(sampleRate * 0.2, Math.max(50, midiToFrequency(midi)));
        const period = sampleRate / freq;
        strike = Math.min(1, Math.max(0, size));
        const light = Math.min(1, Math.max(0, lightness));
        avg = Math.min(0.72, Math.max(0.04, 0.52 - strike * 0.38 - (light - 0.5) * 0.1));
        // A high flute with the low-note loop loss never grows an octave, so the note stays dark.
        const fluteHigh = clarinet ? 0 : Math.max(0, Math.min(1, (midi - 70) / 18));
        const fluteLow = clarinet ? 0 : Math.max(0, Math.min(1, (64 - midi) / 28));
        if (!clarinet) avg = Math.min(0.62, Math.max(0.08, (0.36 - strike * 0.2) * (1 - fluteHigh * 0.5) + fluteLow * 0.2));
        // Sounding chalumeau stays nearly closed-pipe. Clarion and altissimo open even partials.
        const register = clarinet ? Math.max(0, Math.min(1, (midi - 62) / 22)) : 0;
        if (clarinet) avg = Math.min(0.8, avg + (1 - strike) * (1 - register) * 0.22);
        // A hard, short clarinet overblows to the twelfth. Extra loop loss keeps the written note.
        if (clarinet) avg = Math.min(0.8, Math.max(avg, Math.min(0.62, 28 / period)));
        const cos0 = Math.cos((2 * Math.PI) / period);
        const b0 = 1 - avg;
        const b1 = avg;
        const avgDelay = (b1 * (b1 + b0 * cos0)) / (b0 * b0 + b1 * b1 + 2 * b0 * b1 * cos0);
        const loop = clarinet ? period / 2 : period;
        // A hard jet on a long clarinet bore sounds sharp. Lengthen that loop a little.
        const lowTube = clarinet ? Math.max(0, Math.min(1, (period - 400) / 350)) : 0;
        const pull = 1 + strike * strike * 0.0021 * lowTube;
        // An open bore with a jet gain above 1 also amplifies DC, and the DC mode grows until tanh
        // saturates and the note dies. A highpass in the loop blocks it; its phase lead is paid back in delay.
        let hpLead = 0;
        boreHpPole = 0;
        if (!clarinet) {
          boreHpPole = Math.exp((-2 * Math.PI * freq * 0.08) / sampleRate);
          const wn = (2 * Math.PI) / period;
          const lead =
            Math.atan2(Math.sin(wn), 1 - Math.cos(wn)) - Math.atan2(boreHpPole * Math.sin(wn), 1 - boreHpPole * Math.cos(wn));
          hpLead = lead / wn;
        }
        boreX = 0;
        boreY = 0;
        // Without the DC bias the jet runs at full slope, and its saturation lags the loop by a few cents.
        const jetLag = clarinet ? 1 : Math.pow(2, -(8.5 + strike * 12) / 1200);
        delaySamp = Math.max(2, loop * pull * jetLag - avgDelay + hpLead);
        frac = delaySamp - Math.floor(delaySamp);
        loopDelay = delaySamp;
        filterDelay = avgDelay - hpLead;
        life.start();
        dcX = dcY = dcX2 = dcY2 = 0;
        buf.fill(0);
        w = 0;
        prev = 0;
        sqAvg = 0;
        const seeded = buf.length;
        for (let i = 0; i < seeded; i++) buf[i] = Math.sin((2 * Math.PI * i) / period) * 0.25;
        // Heavy saturation on a long flute pulls the pitch flat and grows a sharp edge.
        // A soft clarinet stays near the linear part of the reed; a hard one squares off.
        jet = clarinet ? 1.12 + strike * 0.22 + register * 0.08 : 1.06 + strike * 0.22 + fluteHigh * 0.04;
        // tanh is an odd function, so the open pipe needs an explicit even term.
        // A hard mid-register flute's octave is about as loud as the fundamental.
        // Low notes stay milder: a strong even jet there grows a click every period.
        even = clarinet ? 0 : (0.035 + strike * strike * 0.34) * (1 - fluteHigh * 0.5) * (1 - fluteLow * 0.5);
        // The inverting bore rejects even modes, so the octave is added on the way out.
        // Soft altissimo needs more mix: squaring gets quieter as the bore gets quieter.
        const altissimo = clarinet ? Math.max(0, Math.min(1, (midi - 70) / 14)) : 0;
        evenMix = clarinet ? 0.08 + strike * 0.1 + altissimo * 7.5 * (1 - strike * 0.55) : 0;
        evenDc = 0;
        evenArm = evenMix > 0;
        evenLp = 0;
        evenPole = Math.exp((-2 * Math.PI * freq * 5) / sampleRate);
        octPole = Math.exp((-2 * Math.PI * freq * 1.5) / sampleRate);
        octState = 0;
        noisePole = Math.exp((-2 * Math.PI * (450 + strike * 1800 + light * 300)) / sampleRate);
        nz = 0;
        const open = strike * strike * (0.55 + 0.45 * strike);
        const cut = clarinet
          ? 180 + open * 2500 + register * (900 + strike * 1800)
          : 1400 + strike * 2600 + fluteHigh * 2000 - fluteLow * 500;
        smoothPole = Math.exp((-2 * Math.PI * cut) / sampleRate);
        smooth[0] = smooth[1] = smooth[2] = smooth[3] = 0;
        attackCoeff = Math.exp(-1 / ((clarinet ? 0.016 : 0.028 + (1 - fluteHigh) * 0.02) * sampleRate));
        releaseCoeff = Math.exp(-6.9 / (releaseSec * sampleRate));
        env = 0;
        alive = Math.ceil(sampleRate * 3);
      }
      wasOn = on;
      if (alive <= 0 && env < 1e-5) return [0, 0];

      const dest = on ? size : 0;
      env = dest + (env - dest) * (dest > env ? attackCoeff : releaseCoeff);
      if (!on && env < 1e-5) {
        alive = 0;
        return [0, 0];
      }

      life.step();
      delaySamp = Math.max(2, (loopDelay + filterDelay) / life.ratio - filterDelay);
      frac = delaySamp - Math.floor(delaySamp);
      const L = buf.length;
      const age0 = Math.max(1, Math.floor(delaySamp));
      const i0 = (w - age0 + L * 4) % L;
      const i1 = (w - age0 - 1 + L * 4) % L;
      const delayed = buf[i0] * (1 - frac) + buf[i1] * frac;
      const filtered = (1 - avg) * delayed + avg * prev;
      prev = delayed;

      const white = rng() * 2 - 1;
      nz = white * (1 - noisePole) + nz * noisePole;
      const breath = nz * env * 0.0012;

      let bore = filtered;
      if (boreHpPole > 0) {
        bore = filtered - boreX + boreHpPole * boreY;
        boreX = filtered;
        boreY = bore;
      }
      const shaped = Math.tanh(jet * bore);
      const sq = shaped * shaped;
      sqAvg = sqAvg * 0.999 + sq * 0.001;
      const evenRaw = sq - sqAvg;
      evenLp = evenRaw * (1 - evenPole) + evenLp * evenPole;
      let flow = shaped + even * evenLp;
      if (flow > 1.8) flow = 1.8;
      if (flow < -1.8) flow = -1.8;
      const reflected = (clarinet ? -flow : flow) * 1.02;
      buf[w] = reflected + breath;
      w = (w + 1) % L;

      let out = filtered;
      const a = 1 - smoothPole;
      for (let i = 0; i < 4; i++) {
        smooth[i] = out * a + smooth[i] * smoothPole;
        out = smooth[i];
      }
      out *= env * 0.9;
      if (evenMix > 0) {
        octState += (out - octState) * (1 - octPole);
        const sq = octState * octState;
        if (evenArm) {
          evenDc = sq;
          evenArm = false;
        } else evenDc += (sq - evenDc) * 0.002;
        out += evenMix * (sq - evenDc);
      }
      // The even jet term and tanh both leave a DC offset in the bore. It carries no pitch.
      const hp1 = out - dcX + dcPole * dcY;
      dcX = out;
      dcY = hp1;
      const hp2 = hp1 - dcX2 + dcPole * dcY2;
      dcX2 = hp1;
      dcY2 = hp2;
      out = hp2;
      const air = nz * env * (0.008 + strike * 0.02);
      const g = life.gain;
      return [(out + air) * g, (out + air * 0.9) * g];
    },
  };
}

interface BowSpec {
  dark: number;
  attackSec: number;
  bodyHz: number;
  vibratoCents: number;
  vibratoHz: number;
  shimmerRms: number;
}

function bowSpec(hue: number): BowSpec {
  const h = ((hue % 360) + 360) % 360;
  if (h < 120) return { dark: 0, attackSec: 0.028, bodyHz: 290, vibratoCents: 12, vibratoHz: 5.6, shimmerRms: 0.05 };
  if (h < 240) return { dark: 0.04, attackSec: 0.04, bodyHz: 210, vibratoCents: 11, vibratoHz: 5.4, shimmerRms: 0.048 };
  return { dark: 0.1, attackSec: 0.055, bodyHz: 125, vibratoCents: 9, vibratoHz: 5.2, shimmerRms: 0.053 };
}

/** Helmholtz motion: harmonic partials of a bowed string. Hue picks violin, viola, or cello. */
export function createBow(sampleRate: number, hue: number, seed: number): Engine {
  const spec = bowSpec(hue);
  const rng = mulberry32(seed || 1);
  const N = 28;
  const phases = new Float64Array(N);
  const gains = new Float64Array(N);
  let freq = 440;
  let env = 0;
  let wasOn = false;
  let releaseSec = 0.18;
  const attackCoeff = Math.exp(-1 / (spec.attackSec * sampleRate));
  let nz = 0;
  let noisePole = 0.8;
  let noiseAmp = 0.02;
  const bodyW = (2 * Math.PI * spec.bodyHz) / sampleRate;
  const bodyAlpha = Math.sin(bodyW) / 8;
  const bodyA0 = 1 + bodyAlpha;
  const bodyB0 = bodyAlpha / bodyA0;
  const bodyB2 = -bodyAlpha / bodyA0;
  const bodyA1 = (-2 * Math.cos(bodyW)) / bodyA0;
  const bodyA2 = (1 - bodyAlpha) / bodyA0;
  let bz1 = 0;
  let bz2 = 0;
  let smoothPole = 0.5;
  const smooth = [0, 0, 0, 0];
  const life = createPitchLife(
    sampleRate,
    {
      vibratoCents: spec.vibratoCents,
      vibratoHz: spec.vibratoHz,
      vibratoDelaySec: 0.22,
      wanderCents: 2,
      vibratoGain: 0.05,
      shimmerRms: spec.shimmerRms,
    },
    seed,
  );

  return {
    setRelease(ms: number) {
      releaseSec = Math.max(0.02, ms / 1000);
    },
    processSample(midi, size, lightness) {
      const on = size > 1e-5;
      if (on && !wasOn) {
        freq = Math.min(sampleRate * 0.22, Math.max(40, midiToFrequency(midi)));
        const strike = Math.min(1, Math.max(0, size));
        const light = Math.min(1, Math.max(0, lightness));
        // A 1/n saw's flyback trips the click detector. An exponential slope stays rounded.
        // Real bows keep energy into the bridge hill, so the slope is shallower than a dark saw.
        const tilt = Math.max(0.06, spec.dark * 0.28 + 0.2 - strike * 0.09 - (light - 0.5) * 0.05);
        const cut = Math.max(800, 5600 + strike * 3200 - spec.dark * 1500 + (light - 0.5) * 400);
        smoothPole = Math.exp((-2 * Math.PI * cut) / sampleRate);
        smooth[0] = smooth[1] = smooth[2] = smooth[3] = 0;
        let energy = 0;
        for (let n = 1; n <= N; n++) {
          const f = freq * n;
          const g = f >= sampleRate * 0.45 ? 0 : Math.exp(-tilt * (n - 1));
          gains[n - 1] = g;
          energy += g * g;
          // Spread partial phases so a bright spectrum does not line up into a sawtooth corner.
          phases[n - 1] = n * n * 0.47;
        }
        const norm = energy > 1e-12 ? 1 / Math.sqrt(energy) : 0;
        for (let n = 0; n < N; n++) gains[n] *= norm;
        nz = 0;
        noisePole = Math.exp((-2 * Math.PI * (350 + strike * 2800)) / sampleRate);
        noiseAmp = 0.04 + strike * 0.09;
        bz1 = 0;
        bz2 = 0;
        env = 0;
        life.start();
      }
      wasOn = on;
      if (!on && env < 1e-5) return [0, 0];
      const releaseCoeff = Math.exp(-6.9 / (releaseSec * sampleRate));
      const dest = on ? size : 0;
      env = dest + (env - dest) * (dest > env ? attackCoeff : releaseCoeff);

      life.step();
      const step = (2 * Math.PI * freq * life.ratio) / sampleRate;
      let s = 0;
      for (let n = 0; n < N; n++) {
        if (gains[n] === 0) continue;
        phases[n] += step * (n + 1);
        if (phases[n] > Math.PI * 2) phases[n] -= Math.PI * 2;
        s += Math.sin(phases[n]) * gains[n];
      }
      const white = rng() * 2 - 1;
      nz = white * (1 - noisePole) + nz * noisePole;
      let bowed = s + nz * noiseAmp;
      const a = 1 - smoothPole;
      for (let i = 0; i < 4; i++) {
        smooth[i] = bowed * a + smooth[i] * smoothPole;
        bowed = smooth[i];
      }
      const body = bodyB0 * bowed + bz1;
      bz1 = -bodyA1 * body + bz2;
      bz2 = bodyB2 * bowed - bodyA2 * body;
      const out = (bowed + body * 0.16) * env * life.gain * 0.55;
      return [out * 1.03, out * 0.97];
    },
  };
}

/** Struck string. Partials follow f·n·√(1+B·n²), and higher notes and partials die sooner. Hue darkens the hammer. */
export function createPiano(sampleRate: number, hue: number, seed: number): Engine {
  const dark = ((hue % 360) + 360) % 360 / 360;
  const rng = mulberry32(seed || 1);
  const N = 24;
  const phases = new Float64Array(N);
  const phases2 = new Float64Array(N);
  const amps = new Float64Array(N);
  const taus = new Float64Array(N);
  const partialHz = new Float64Array(N);
  let wasOn = false;
  let alive = 0;
  let releaseSec = 0.18;
  let hammerLeft = 0;
  let hammerTotal = 1;
  let hammerMix = 0;
  let hammerPole = 0.5;
  let hammerLp = 0;
  let noiseAmp = 0;
  let noiseLp = 0;
  let noisePole = 0.8;
  let attack = 0;
  let attackInc = 1;
  const detune = Math.pow(2, 0.7 / 1200);

  return {
    setRelease(ms: number) {
      releaseSec = Math.max(0.04, ms / 1000);
    },
    processSample(midi, size, lightness) {
      const on = size > 1e-5;
      if (on && !wasOn) {
        const freq = Math.min(sampleRate * 0.2, Math.max(27, midiToFrequency(midi)));
        const strike = Math.min(1, Math.max(0, size));
        const light = Math.min(1, Math.max(0, lightness));
        const slope = Math.max(0.16, 0.64 + dark * 0.28 - strike * 0.3 - (light - 0.5) * 0.08);
        // Salamander's Yamaha C5: B rises from about 9e-5 at C2 to about 2.5e-3 at C6.
        const stiffness = 0.000088 * Math.pow(freq / 65.406, 1.15) * (0.9 + dark * 0.25);
        const pitchScale = Math.pow(freq / 220, 0.82);
        const hang = 0.3 + strike * 1.2;
        let energy = 0;
        const raw = new Float64Array(N);
        for (let i = 0; i < N; i++) {
          const n = i + 1;
          const fn = n * freq * Math.sqrt(1 + stiffness * n * n);
          partialHz[i] = fn;
          raw[i] = fn >= sampleRate * 0.45 ? 0 : Math.exp(-slope * (n - 1));
          energy += raw[i] * raw[i];
        }
        const norm = energy > 1e-12 ? size / Math.sqrt(energy) : 0;
        for (let i = 0; i < N; i++) {
          const n = i + 1;
          amps[i] = raw[i] * norm;
          const hold = n === 1 ? 1 : hang;
          taus[i] = Math.max(0.03, (2.4 * hold) / (pitchScale * Math.pow(n, 0.9)));
          phases[i] = 0;
          phases2[i] = 0.15;
        }
        hammerTotal = Math.max(1, Math.round((0.004 + strike * 0.007) * sampleRate));
        hammerLeft = hammerTotal;
        hammerMix = Math.pow(strike, 1.5) * 0.28;
        const cut = 400 + strike * 5500 + (1 - light) * 800;
        hammerPole = Math.exp((-2 * Math.PI * cut) / sampleRate);
        hammerLp = 0;
        noiseAmp = 0.04 + strike * 0.045;
        noisePole = Math.exp((-2 * Math.PI * (700 + strike * 1800)) / sampleRate);
        noiseLp = 0;
        attack = 0;
        attackInc = 1 / Math.max(1, 0.012 * sampleRate);
        alive = Math.ceil(sampleRate * 6);
      }
      if (!on && wasOn) {
        const cap = releaseSec / 6;
        for (let i = 0; i < N; i++) taus[i] = Math.min(taus[i], cap);
      }
      wasOn = on;
      if (alive <= 0) return [0, 0];
      alive--;

      let mix = 0;
      let peakAmp = 0;
      for (let i = 0; i < N; i++) {
        const fn = partialHz[i];
        if (fn <= 0 || fn >= sampleRate * 0.45) {
          amps[i] = 0;
          continue;
        }
        const step = (2 * Math.PI * fn) / sampleRate;
        phases[i] += step;
        phases2[i] += step * detune;
        if (phases[i] > Math.PI * 2) phases[i] -= Math.PI * 2;
        if (phases2[i] > Math.PI * 2) phases2[i] -= Math.PI * 2;
        amps[i] *= Math.exp(-1 / (taus[i] * sampleRate));
        peakAmp = Math.max(peakAmp, Math.abs(amps[i]));
        mix += Math.sin(phases[i]) * amps[i] + Math.sin(phases2[i]) * amps[i] * 0.7;
      }
      const white = rng() * 2 - 1;
      if (hammerLeft > 0) {
        hammerLeft--;
        const envB = hammerLeft / hammerTotal;
        hammerLp = white * (1 - hammerPole) + hammerLp * hammerPole;
        mix += hammerLp * envB * envB * hammerMix;
      }
      noiseLp = white * (1 - noisePole) + noiseLp * noisePole;
      mix += noiseLp * noiseAmp * (peakAmp + 0.015);
      mix *= attack;
      attack = Math.min(1, attack + attackInc);
      if (peakAmp < 1e-5 && hammerLeft <= 0) {
        alive = 0;
        return [0, 0];
      }
      return [mix * 0.34, mix * 0.34];
    },
  };
}

interface BrassSpec {
  /** Harmonic tilt at a soft note. About 8.7 dB per octave per unit. */
  soft: number;
  /** Tilt at a hard note. Loud trumpet is nearly flat. */
  loud: number;
  /** High notes stay darker by this much, even when loud. Horn does this; trumpet does not. */
  register: number;
  /** How fast the soft darkness lets go. A saxophone opens up by mezzo-forte. */
  shadePow: number;
  attackSec: number;
  bellHz: number;
  noise: number;
  shimmerRms: number;
}

function brassSpec(hue: number): BrassSpec {
  const h = ((hue % 360) + 360) % 360;
  if (h < 90) return { soft: 2.55, loud: 0.05, register: 0.02, shadePow: 1.35, attackSec: 0.05, bellHz: 1800, noise: 0.16, shimmerRms: 0.03 };
  if (h < 180) return { soft: 2.5, loud: 0.55, register: 1.15, shadePow: 1.35, attackSec: 0.06, bellHz: 480, noise: 0.05, shimmerRms: 0.025 };
  if (h < 240) return { soft: 2.05, loud: 0.15, register: 0.35, shadePow: 1.35, attackSec: 0.042, bellHz: 620, noise: 0.07, shimmerRms: 0.032 };
  if (h < 300) return { soft: 1.6, loud: 0.02, register: 1.25, shadePow: 1.35, attackSec: 0.07, bellHz: 220, noise: 0.03, shimmerRms: 0.048 };
  return { soft: 4.2, loud: 0.25, register: 0.25, shadePow: 2.2, attackSec: 0.038, bellHz: 1700, noise: 0.1, shimmerRms: 0.018 };
}

/**
 * Lip reed, as harmonics whose slope opens with loudness.
 * Hue: 0°–89° trumpet, 90°–179° horn, 180°–239° trombone, 240°–299° tuba, 300°–360° saxophone.
 */
export function createBrass(sampleRate: number, hue: number, seed: number): Engine {
  const spec = brassSpec(hue);
  const rng = mulberry32(seed || 1);
  const N = 28;
  const phases = new Float64Array(N);
  const gains = new Float64Array(N);
  let freq = 440;
  let env = 0;
  let wasOn = false;
  let releaseSec = 0.18;
  const attackCoeff = Math.exp(-1 / (spec.attackSec * sampleRate));
  let nz = 0;
  let noisePole = 0.8;
  let noiseAmp = 0.02;
  const bodyW = (2 * Math.PI * spec.bellHz) / sampleRate;
  const bodyAlpha = Math.sin(bodyW) / 7;
  const bodyA0 = 1 + bodyAlpha;
  const bodyB0 = bodyAlpha / bodyA0;
  const bodyB2 = -bodyAlpha / bodyA0;
  const bodyA1 = (-2 * Math.cos(bodyW)) / bodyA0;
  const bodyA2 = (1 - bodyAlpha) / bodyA0;
  let bz1 = 0;
  let bz2 = 0;
  let bellMix = 0.12;

  const life = createPitchLife(
    sampleRate,
    { vibratoCents: 0, vibratoHz: 0, vibratoDelaySec: 0, wanderCents: spec.bellHz < 300 ? 3 : 1.5, vibratoGain: 0, shimmerRms: spec.shimmerRms },
    seed,
  );
  return {
    setRelease(ms: number) {
      releaseSec = Math.max(0.02, ms / 1000);
    },
    processSample(midi, size, lightness) {
      const on = size > 1e-5;
      if (on && !wasOn) {
        freq = Math.min(sampleRate * 0.22, Math.max(40, midiToFrequency(midi)));
        const strike = Math.min(1, Math.max(0, size));
        const light = Math.min(1, Math.max(0, lightness));
        const high = Math.max(0, Math.min(1, (midi - 48) / 24));
        const shade = Math.pow(1 - strike, spec.shadePow);
        const tilt = Math.max(
          0.045,
          spec.loud + spec.register * high * 1.15 + (spec.soft + high * 0.25) * shade - (light - 0.5) * 0.06,
        );
        let energy = 0;
        for (let n = 1; n <= N; n++) {
          const f = freq * n;
          const g = f >= sampleRate * 0.45 ? 0 : Math.exp(-tilt * (n - 1));
          gains[n - 1] = g;
          energy += g * g;
          phases[n - 1] = n * n * 0.41;
        }
        const norm = energy > 1e-12 ? 1 / Math.sqrt(energy) : 0;
        for (let n = 0; n < N; n++) gains[n] *= norm;
        nz = 0;
        noisePole = Math.exp((-2 * Math.PI * (500 + strike * 3500)) / sampleRate);
        noiseAmp = (0.02 + strike * strike * spec.noise) * (0.7 + high * 0.3);
        bellMix = 0.08 + strike * 0.18;
        bz1 = 0;
        bz2 = 0;
        env = 0;
        life.start();
      }
      wasOn = on;
      if (!on && env < 1e-5) return [0, 0];
      const releaseCoeff = Math.exp(-6.9 / (releaseSec * sampleRate));
      const dest = on ? size : 0;
      env = dest + (env - dest) * (dest > env ? attackCoeff : releaseCoeff);
      life.step();
      const step = (2 * Math.PI * freq * life.ratio) / sampleRate;
      let s = 0;
      for (let n = 0; n < N; n++) {
        if (gains[n] === 0) continue;
        phases[n] += step * (n + 1);
        if (phases[n] > Math.PI * 2) phases[n] -= Math.PI * 2;
        s += Math.sin(phases[n]) * gains[n];
      }
      const white = rng() * 2 - 1;
      nz = white * (1 - noisePole) + nz * noisePole;
      const body = bodyB0 * s + bz1;
      bz1 = -bodyA1 * body + bz2;
      bz2 = bodyB2 * s - bodyA2 * body;
      const out = (s + body * bellMix + nz * noiseAmp) * env * life.gain * 0.48;
      return [out * 1.02, out * 0.98];
    },
  };
}

interface BassSpec {
  dark: number;
  attackSec: number;
  bodyHz: number;
  noise: number;
  /** Finger noise that dies after the attack. Electric bass has it; a bow does not. */
  pluck: number;
  shimmerRms: number;
}

function bassSpec(hue: number): BassSpec {
  const h = ((hue % 360) + 360) % 360;
  if (h < 180) return { dark: 0.12, attackSec: 0.05, bodyHz: 70, noise: 0.035, pluck: 0, shimmerRms: 0.043 };
  return { dark: 0.3, attackSec: 0.01, bodyHz: 92, noise: 0.015, pluck: 0.7, shimmerRms: 0 };
}

/**
 * Low string. Hue 0°–179° is a bowed contrabass. 180°–360° is an electric bass:
 * a round sustain plus a short finger attack.
 */
export function createBass(sampleRate: number, hue: number, seed: number): Engine {
  const spec = bassSpec(hue);
  const rng = mulberry32(seed || 1);
  const N = 40;
  const phases = new Float64Array(N);
  const gains = new Float64Array(N);
  const pluckGains = new Float64Array(N);
  let freq = 55;
  let env = 0;
  let pluckEnv = 0;
  let pluckDec = 0.99;
  let wasOn = false;
  let releaseSec = 0.22;
  const attackCoeff = Math.exp(-1 / (spec.attackSec * sampleRate));
  let nz = 0;
  let noisePole = 0.8;
  let noiseAmp = 0.02;
  let finger = 0;
  const bodyW = (2 * Math.PI * spec.bodyHz) / sampleRate;
  const bodyAlpha = Math.sin(bodyW) / 6;
  const bodyA0 = 1 + bodyAlpha;
  const bodyB0 = bodyAlpha / bodyA0;
  const bodyB2 = -bodyAlpha / bodyA0;
  const bodyA1 = (-2 * Math.cos(bodyW)) / bodyA0;
  const bodyA2 = (1 - bodyAlpha) / bodyA0;
  let bz1 = 0;
  let bz2 = 0;

  const life = createPitchLife(
    sampleRate,
    spec.pluck > 0
      ? { vibratoCents: 0, vibratoHz: 0, vibratoDelaySec: 0, wanderCents: 1.2, vibratoGain: 0, shimmerRms: 0 }
      : { vibratoCents: 6, vibratoHz: 4.9, vibratoDelaySec: 0.3, wanderCents: 2.5, vibratoGain: 0.04, shimmerRms: spec.shimmerRms },
    seed,
  );
  return {
    setRelease(ms: number) {
      releaseSec = Math.max(0.02, ms / 1000);
    },
    processSample(midi, size, lightness) {
      const on = size > 1e-5;
      if (on && !wasOn) {
        freq = Math.min(sampleRate * 0.2, Math.max(28, midiToFrequency(midi)));
        const strike = Math.min(1, Math.max(0, size));
        const light = Math.min(1, Math.max(0, lightness));
        const tilt = Math.max(0.08, spec.dark + 0.15 - strike * 0.15 - (light - 0.5) * 0.08);
        const brightTilt = Math.max(0.06, tilt - 0.35);
        let energy = 0;
        for (let n = 1; n <= N; n++) {
          const f = freq * n;
          const g = f >= sampleRate * 0.45 ? 0 : Math.exp(-tilt * (n - 1));
          const p = f >= sampleRate * 0.45 ? 0 : Math.exp(-brightTilt * (n - 1));
          gains[n - 1] = g;
          pluckGains[n - 1] = p;
          energy += g * g;
          phases[n - 1] = n * n * 0.37;
        }
        const norm = energy > 1e-12 ? 1 / Math.sqrt(energy) : 0;
        for (let n = 0; n < N; n++) {
          gains[n] *= norm;
          pluckGains[n] *= norm;
        }
        nz = 0;
        noisePole = Math.exp((-2 * Math.PI * (180 + strike * 900)) / sampleRate);
        noiseAmp = spec.noise * (0.4 + strike);
        finger = spec.pluck * (0.15 + strike * 0.55);
        pluckEnv = spec.pluck;
        pluckDec = Math.exp(-1 / (0.07 * sampleRate));
        bz1 = 0;
        bz2 = 0;
        env = 0;
        life.start();
      }
      wasOn = on;
      if (!on && env < 1e-5 && finger < 1e-4) return [0, 0];
      const releaseCoeff = Math.exp(-6.9 / (releaseSec * sampleRate));
      const dest = on ? size : 0;
      env = dest + (env - dest) * (dest > env ? attackCoeff : releaseCoeff);
      pluckEnv *= pluckDec;
      finger *= Math.exp(-1 / (0.018 * sampleRate));
      life.step();
      const step = (2 * Math.PI * freq * life.ratio) / sampleRate;
      let s = 0;
      let p = 0;
      for (let n = 0; n < N; n++) {
        if (gains[n] === 0 && pluckGains[n] === 0) continue;
        phases[n] += step * (n + 1);
        if (phases[n] > Math.PI * 2) phases[n] -= Math.PI * 2;
        const sine = Math.sin(phases[n]);
        s += sine * gains[n];
        p += sine * pluckGains[n];
      }
      const white = rng() * 2 - 1;
      nz = white * (1 - noisePole) + nz * noisePole;
      const bodyIn = s + p * pluckEnv;
      const body = bodyB0 * bodyIn + bz1;
      bz1 = -bodyA1 * body + bz2;
      bz2 = bodyB2 * bodyIn - bodyA2 * body;
      const out = (bodyIn + body * (spec.pluck > 0 ? 0.16 : 0.08) + nz * (noiseAmp + finger)) * env * life.gain * 0.5;
      return [out * 1.02, out * 0.98];
    },
  };
}

interface ReedSpec {
  soft: number;
  loud: number;
  formantHz: number;
  attackSec: number;
  noise: number;
  midMidi: number;
  shimmerRms: number;
}

function reedSpec(hue: number): ReedSpec {
  const h = ((hue % 360) + 360) % 360;
  if (h < 180) return { soft: 1.15, loud: 0.22, formantHz: 1500, attackSec: 0.032, noise: 0.04, midMidi: 72, shimmerRms: 0.025 };
  return { soft: 1.55, loud: 0.18, formantHz: 540, attackSec: 0.048, noise: 0.028, midMidi: 62, shimmerRms: 0.028 };
}

/**
 * Double reed. Hue 0°–179° oboe, 180°–360° bassoon.
 * A conical bore has every harmonic; the formant is what makes it nasal.
 */
export function createReed(sampleRate: number, hue: number, seed: number): Engine {
  const spec = reedSpec(hue);
  const rng = mulberry32(seed || 1);
  const N = 32;
  const phases = new Float64Array(N);
  const gains = new Float64Array(N);
  let freq = 440;
  let env = 0;
  let wasOn = false;
  let releaseSec = 0.16;
  const attackCoeff = Math.exp(-1 / (spec.attackSec * sampleRate));
  let nz = 0;
  let noisePole = 0.7;
  let noiseAmp = 0.02;
  const bodyW = (2 * Math.PI * spec.formantHz) / sampleRate;
  const bodyAlpha = Math.sin(bodyW) / 11;
  const bodyA0 = 1 + bodyAlpha;
  const bodyB0 = bodyAlpha / bodyA0;
  const bodyB2 = -bodyAlpha / bodyA0;
  const bodyA1 = (-2 * Math.cos(bodyW)) / bodyA0;
  const bodyA2 = (1 - bodyAlpha) / bodyA0;
  let bz1 = 0;
  let bz2 = 0;
  let formantMix = 0.2;

  const life = createPitchLife(
    sampleRate,
    { vibratoCents: 0, vibratoHz: 0, vibratoDelaySec: 0, wanderCents: 1.5, vibratoGain: 0, shimmerRms: spec.shimmerRms },
    seed,
  );
  return {
    setRelease(ms: number) {
      releaseSec = Math.max(0.02, ms / 1000);
    },
    processSample(midi, size, lightness) {
      const on = size > 1e-5;
      if (on && !wasOn) {
        freq = Math.min(sampleRate * 0.22, Math.max(32, midiToFrequency(midi)));
        const strike = Math.min(1, Math.max(0, size));
        const light = Math.min(1, Math.max(0, lightness));
        // Below its middle register the formant sits over many harmonics, so the slope runs flatter.
        const low = Math.max(0, Math.min(1, (spec.midMidi - midi) / 24));
        const tilt = Math.max(
          0.1,
          (spec.loud + (spec.soft - spec.loud) * Math.pow(1 - strike, 1.25)) * (1 - low * 0.55) - (light - 0.5) * 0.08,
        );
        let energy = 0;
        for (let n = 1; n <= N; n++) {
          const f = freq * n;
          const g = f >= sampleRate * 0.45 ? 0 : Math.exp(-tilt * (n - 1));
          gains[n - 1] = g;
          energy += g * g;
          phases[n - 1] = n * n * 0.33;
        }
        const norm = energy > 1e-12 ? 1 / Math.sqrt(energy) : 0;
        for (let n = 0; n < N; n++) gains[n] *= norm;
        nz = 0;
        noisePole = Math.exp((-2 * Math.PI * (700 + strike * 2200)) / sampleRate);
        noiseAmp = spec.noise * (0.5 + strike * 0.8);
        formantMix = 0.28 + strike * 0.22;
        bz1 = 0;
        bz2 = 0;
        env = 0;
        life.start();
      }
      wasOn = on;
      if (!on && env < 1e-5) return [0, 0];
      const releaseCoeff = Math.exp(-6.9 / (releaseSec * sampleRate));
      const dest = on ? size : 0;
      env = dest + (env - dest) * (dest > env ? attackCoeff : releaseCoeff);
      life.step();
      const step = (2 * Math.PI * freq * life.ratio) / sampleRate;
      let s = 0;
      for (let n = 0; n < N; n++) {
        if (gains[n] === 0) continue;
        phases[n] += step * (n + 1);
        if (phases[n] > Math.PI * 2) phases[n] -= Math.PI * 2;
        s += Math.sin(phases[n]) * gains[n];
      }
      const white = rng() * 2 - 1;
      nz = white * (1 - noisePole) + nz * noisePole;
      const body = bodyB0 * s + bz1;
      bz1 = -bodyA1 * body + bz2;
      bz2 = bodyB2 * s - bodyA2 * body;
      const out = (s + body * formantMix + nz * noiseAmp) * env * life.gain * 0.46;
      return [out * 1.03, out * 0.97];
    },
  };
}

/**
 * Unpitched metal. Hue 0°–119° closed hi-hat, 120°–199° open hi-hat, 200°–360° crash.
 * Midi picks the cymbal size: a higher note is a smaller, brighter plate.
 */
export function createCymbal(sampleRate: number, hue: number, seed: number): Engine {
  const h = ((hue % 360) + 360) % 360;
  const closed = h < 120;
  const openHat = h >= 120 && h < 200;
  const rng = mulberry32(seed || 1);
  const N = 18;
  const phases = new Float64Array(N);
  const amps = new Float64Array(N);
  const ratios = new Float64Array(N);
  const taus = new Float64Array(N);
  for (let i = 0; i < N; i++) ratios[i] = Math.pow(i + 1, 1.18) * (0.9 + ((i * 5) % 4) * 0.045);
  let base = 400;
  let alive = 0;
  let wasOn = false;
  let attack = 1;
  let attackInc = 1;
  let nz = 0;
  let noiseAmp = 0;
  let noiseTau = 0.05;
  let noisePole = 0.4;
  let lp = 0;
  let prev = 0;

  return {
    setRelease(ms: number) {
      const cap = Math.max(0.02, ms / 1000);
      for (let i = 0; i < N; i++) taus[i] = Math.min(taus[i] || cap, cap);
      noiseTau = Math.min(noiseTau, cap);
    },
    processSample(midi, size, lightness) {
      const on = size > 1e-5;
      if (on && !wasOn) {
        const strike = Math.min(1, Math.max(0, size));
        const light = Math.min(1, Math.max(0, lightness));
        const center = midiToFrequency(Math.min(96, Math.max(36, midi)));
        base = closed ? center * 6.5 : openHat ? center * 4.2 : center * 2.4;
        const hang = closed ? 0.055 + strike * 0.03 : openHat ? 0.22 + strike * 0.28 : 0.7 + strike * 1.1;
        let energy = 0;
        for (let i = 0; i < N; i++) {
          const f = base * ratios[i];
          const g = f >= sampleRate * 0.45 ? 0 : Math.exp(-0.22 * i) * (0.25 + strike * (0.4 + i / N));
          amps[i] = g;
          energy += g * g;
          phases[i] = rng() * Math.PI * 2;
          taus[i] = hang / (1 + i * (closed ? 0.35 : 0.12));
        }
        const norm = energy > 1e-8 ? 0.35 / Math.sqrt(energy) : 0;
        for (let i = 0; i < N; i++) amps[i] *= norm * (0.55 + light * 0.2);
        noiseAmp = (closed ? 0.22 : openHat ? 0.16 : 0.2) * (0.35 + strike);
        noiseTau = hang * (closed ? 0.45 : 0.7);
        noisePole = Math.exp((-2 * Math.PI * (2500 + strike * 6000 + (closed ? 2000 : 0))) / sampleRate);
        nz = 0;
        lp = 0;
        prev = 0;
        attack = 0;
        attackInc = 1 / (0.003 * sampleRate);
        alive = Math.ceil(sampleRate * (hang + 0.35));
      }
      wasOn = on;
      if (!on && alive > 0) {
        for (let i = 0; i < N; i++) taus[i] = Math.min(taus[i], closed ? 0.02 : 0.08);
        noiseTau = Math.min(noiseTau, closed ? 0.015 : 0.05);
      }
      if (alive <= 0) return [0, 0];
      alive--;
      let s = 0;
      let peak = 0;
      for (let i = 0; i < N; i++) {
        if (amps[i] === 0) continue;
        const f = base * ratios[i];
        phases[i] += (2 * Math.PI * f) / sampleRate;
        if (phases[i] > Math.PI * 2) phases[i] -= Math.PI * 2;
        amps[i] *= Math.exp(-1 / (taus[i] * sampleRate));
        s += Math.sin(phases[i]) * amps[i];
        peak = Math.max(peak, Math.abs(amps[i]));
      }
      const white = rng() * 2 - 1;
      nz = white * (1 - noisePole) + nz * noisePole;
      noiseAmp *= Math.exp(-1 / (Math.max(0.01, noiseTau) * sampleRate));
      attack = Math.min(1, attack + attackInc);
      const mixed = (s + nz * noiseAmp) * attack;
      const hp = mixed - prev;
      prev = mixed;
      lp = hp * 0.2 + lp * 0.8;
      if (peak < 1e-5 && noiseAmp < 1e-4) {
        alive = 0;
        return [0, 0];
      }
      return [lp * 3.4, lp * 2.8 + hp * 0.6];
    },
  };
}

export type AcousticEngine =
  | 'pluck'
  | 'marimba'
  | 'epiano'
  | 'organ'
  | 'drum'
  | 'wind'
  | 'bow'
  | 'piano'
  | 'brass'
  | 'bass'
  | 'reed'
  | 'cymbal';

export function isAcousticEngine(name: string | undefined): name is AcousticEngine {
  return (
    name === 'pluck' ||
    name === 'marimba' ||
    name === 'epiano' ||
    name === 'organ' ||
    name === 'drum' ||
    name === 'wind' ||
    name === 'bow' ||
    name === 'piano' ||
    name === 'brass' ||
    name === 'bass' ||
    name === 'reed' ||
    name === 'cymbal'
  );
}

export function createEngine(name: AcousticEngine, sampleRate: number, hue: number, seed: number): Engine {
  if (name === 'pluck') return createPluck(sampleRate, hue, seed);
  if (name === 'marimba') return createMarimba(sampleRate, hue, seed);
  if (name === 'organ') return createOrgan(sampleRate, hue, seed);
  if (name === 'drum') return createDrum(sampleRate, hue, seed);
  if (name === 'wind') return createWind(sampleRate, hue, seed);
  if (name === 'bow') return createBow(sampleRate, hue, seed);
  if (name === 'piano') return createPiano(sampleRate, hue, seed);
  if (name === 'brass') return createBrass(sampleRate, hue, seed);
  if (name === 'bass') return createBass(sampleRate, hue, seed);
  if (name === 'reed') return createReed(sampleRate, hue, seed);
  if (name === 'cymbal') return createCymbal(sampleRate, hue, seed);
  return createEpiano(sampleRate, hue, seed);
}
