import { mulberry32 } from './synth.js';

/** 16 / 24 = integer PCM, 32 = IEEE float. */
export type BitDepth = 16 | 24 | 32;

export interface WavOptions {
  bitDepth?: BitDepth;
  /** TPDF dither for integer formats (default true). Exact digital silence stays silent. */
  dither?: boolean;
  /** Dither noise seed, so output stays deterministic. */
  seed?: number;
}

export function writeWavFile(
  buffers: Float32Array[],
  sampleRate: number,
  options: WavOptions = {},
): Buffer {
  const bitDepth = options.bitDepth ?? 16;
  const isFloat = bitDepth === 32;
  const dither = !isFloat && (options.dither ?? true);
  const numChannels = buffers.length;
  const numSamples = buffers[0]?.length ?? 0;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;

  // Float WAV needs the 18-byte fmt chunk (cbSize) and a fact chunk.
  const fmtSize = isFloat ? 18 : 16;
  const factSize = isFloat ? 12 : 0;
  const headerSize = 12 + 8 + fmtSize + factSize + 8;
  const buffer = Buffer.alloc(headerSize + dataSize);

  let o = 0;
  buffer.write('RIFF', o);
  buffer.writeUInt32LE(headerSize - 8 + dataSize, o + 4);
  buffer.write('WAVE', o + 8);
  o += 12;

  buffer.write('fmt ', o);
  buffer.writeUInt32LE(fmtSize, o + 4);
  buffer.writeUInt16LE(isFloat ? 3 : 1, o + 8);
  buffer.writeUInt16LE(numChannels, o + 10);
  buffer.writeUInt32LE(sampleRate, o + 12);
  buffer.writeUInt32LE(byteRate, o + 16);
  buffer.writeUInt16LE(blockAlign, o + 20);
  buffer.writeUInt16LE(bitDepth, o + 22);
  if (isFloat) buffer.writeUInt16LE(0, o + 24);
  o += 8 + fmtSize;

  if (isFloat) {
    buffer.write('fact', o);
    buffer.writeUInt32LE(4, o + 4);
    buffer.writeUInt32LE(numSamples, o + 8);
    o += 12;
  }

  buffer.write('data', o);
  buffer.writeUInt32LE(dataSize, o + 4);
  o += 8;

  const rng = mulberry32(options.seed ?? 0x5eed);
  const maxInt = Math.pow(2, bitDepth - 1) - 1;
  const minInt = -maxInt - 1;

  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const x = buffers[ch][i];
      if (isFloat) {
        buffer.writeFloatLE(Math.max(-1, Math.min(1, x)), o);
      } else {
        let v = Math.max(-1, Math.min(1, x)) * maxInt;
        if (dither && x !== 0) v += rng() - rng();
        const q = Math.max(minInt, Math.min(maxInt, Math.round(v)));
        if (bitDepth === 16) buffer.writeInt16LE(q, o);
        else buffer.writeIntLE(q, o, 3);
      }
      o += bytesPerSample;
    }
  }

  return buffer;
}
