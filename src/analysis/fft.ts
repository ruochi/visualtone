/** Radix-2 FFT with cached twiddles. Length must be a power of two. */

interface Plan {
  rev: Uint32Array;
  cos: Float64Array;
  sin: Float64Array;
}

const plans = new Map<number, Plan>();

function planFor(n: number): Plan {
  let p = plans.get(n);
  if (p) return p;
  const rev = new Uint32Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    rev[i] = j;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    const ang = (-2 * Math.PI * k) / n;
    cos[k] = Math.cos(ang);
    sin[k] = Math.sin(ang);
  }
  p = { rev, cos, sin };
  plans.set(n, p);
  return p;
}

export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  const { rev, cos, sin } = planFor(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const step = n / len;
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const tw = k * step;
        const wr = cos[tw];
        const wi = inverse ? -sin[tw] : sin[tw];
        const a = i + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}
