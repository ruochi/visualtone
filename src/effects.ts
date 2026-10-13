/** Master effects: Schroeder/Freeverb-style reverb, ping-pong delay, limiter. */

class Comb {
  private buf: Float32Array;
  private i = 0;
  private store = 0;
  constructor(size: number, private feedback: number, private damp: number) {
    this.buf = new Float32Array(size);
  }
  process(x: number): number {
    const y = this.buf[this.i];
    this.store = y * (1 - this.damp) + this.store * this.damp;
    this.buf[this.i] = x + this.store * this.feedback;
    this.i = (this.i + 1) % this.buf.length;
    return y;
  }
}

class Allpass {
  private buf: Float32Array;
  private i = 0;
  constructor(size: number) {
    this.buf = new Float32Array(size);
  }
  process(x: number): number {
    const b = this.buf[this.i];
    this.buf[this.i] = x + b * 0.5;
    this.i = (this.i + 1) % this.buf.length;
    return b - x;
  }
}

const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];
const STEREO_SPREAD = 23;

/** Freeverb. Writes a wet-only stereo signal into outL/outR. */
export function reverb(inL: Float32Array, inR: Float32Array, size: number, damping: number, sampleRate: number): [Float32Array, Float32Array] {
  const scale = sampleRate / 44100;
  const fb = 0.7 + 0.28 * size;
  const make = (offset: number) => ({
    combs: COMBS.map((n) => new Comb(Math.round((n + offset) * scale), fb, damping)),
    aps: ALLPASSES.map((n) => new Allpass(Math.round((n + offset) * scale))),
  });
  const l = make(0);
  const r = make(STEREO_SPREAD);
  const outL = new Float32Array(inL.length);
  const outR = new Float32Array(inR.length);
  for (let i = 0; i < inL.length; i++) {
    const x = (inL[i] + inR[i]) * 0.015;
    let yl = 0;
    let yr = 0;
    for (const c of l.combs) yl += c.process(x);
    for (const c of r.combs) yr += c.process(x);
    for (const a of l.aps) yl = a.process(yl);
    for (const a of r.aps) yr = a.process(yr);
    outL[i] = yl;
    outR[i] = yr;
  }
  return [outL, outR];
}

/** Ping-pong delay, wet only. */
export function delay(inL: Float32Array, inR: Float32Array, time: number, feedback: number, sampleRate: number): [Float32Array, Float32Array] {
  const n = Math.max(1, Math.round(time * sampleRate));
  const bl = new Float32Array(n);
  const br = new Float32Array(n);
  const outL = new Float32Array(inL.length);
  const outR = new Float32Array(inR.length);
  let lp = 0;
  for (let i = 0; i < inL.length; i++) {
    const j = i % n;
    const dl = bl[j];
    const dr = br[j];
    outL[i] = dl;
    outR[i] = dr;
    // Darken each repeat a little.
    lp += 0.4 * (dr - lp);
    bl[j] = (inL[i] + inR[i]) * 0.5 + lp * feedback;
    br[j] = dl * feedback;
  }
  return [outL, outR];
}

/** Lookahead peak limiter (5 ms) with smooth release. Operates in place. */
export function limit(l: Float32Array, r: Float32Array, ceilingDb: number, sampleRate: number): number {
  const ceiling = Math.pow(10, ceilingDb / 20);
  const look = Math.round(0.005 * sampleRate);
  const release = Math.exp(-1 / (0.08 * sampleRate));
  const n = l.length;
  // Required gain per sample, then a running minimum over the lookahead window.
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = Math.max(Math.abs(l[i]), Math.abs(r[i]));
    need[i] = p > ceiling ? ceiling / p : 1;
  }
  let gain = 1;
  let maxReduction = 0;
  for (let i = 0; i < n; i++) {
    let target = 1;
    for (let k = i; k < Math.min(n, i + look); k++) if (need[k] < target) target = need[k];
    gain = target < gain ? target : target - (target - gain) * release;
    l[i] *= gain;
    r[i] *= gain;
    maxReduction = Math.max(maxReduction, -20 * Math.log10(gain));
  }
  return maxReduction;
}
