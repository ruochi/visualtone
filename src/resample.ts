/** Windowed-sinc resampler used by clip tracks. Same rate returns the same array. */

function sinc(x: number): number {
  if (Math.abs(x) < 1e-8) return 1;
  const p = Math.PI * x;
  return Math.sin(p) / p;
}

export function resampleBuffer(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  if (fromRate <= 0 || toRate <= 0) throw new Error(`无效采样率 ${fromRate} -> ${toRate}`);
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);
  const taps = 32;
  const cutoff = Math.min(1, ratio);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    let acc = 0;
    const iCenter = Math.floor(srcPos);
    for (let k = -taps + 1; k <= taps; k++) {
      const idx = iCenter + k;
      const x = idx >= 0 && idx < input.length ? input[idx] : 0;
      const d = (srcPos - idx) * cutoff;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * (k - (srcPos - iCenter))) / taps);
      acc += x * sinc(d) * cutoff * w;
    }
    out[i] = acc;
  }
  return out;
}

export function resampleChannels(buffers: Float32Array[], fromRate: number, toRate: number): Float32Array[] {
  return buffers.map((b) => resampleBuffer(b, fromRate, toRate));
}
