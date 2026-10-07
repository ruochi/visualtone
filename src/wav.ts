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

export interface DecodedWav {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  buffers: Float32Array[];
}

/** Read 16-bit PCM, 24-bit PCM, or 32-bit float WAV. */
export function readWavFile(data: Buffer): DecodedWav {
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }
  let offset = 12;
  let audioFormat = 1;
  let channels = 1;
  let sampleRate = 44100;
  let bits = 16;
  let dataOff = -1;
  let dataSize = 0;
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      audioFormat = data.readUInt16LE(body);
      channels = data.readUInt16LE(body + 2);
      sampleRate = data.readUInt32LE(body + 4);
      bits = data.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first field of the sub-GUID.
      if (audioFormat === 0xfffe && body + 26 <= data.length) {
        audioFormat = data.readUInt16LE(body + 24);
      }
    } else if (id === 'data') {
      dataOff = body;
      dataSize = Math.min(size, data.length - body);
      break;
    }
    offset = body + size + (size & 1);
  }
  if (dataOff < 0) throw new Error('WAV has no data chunk');
  if (![16, 24, 32].includes(bits)) throw new Error(`Unsupported bit depth ${bits}`);
  const bytesPerSample = bits / 8;
  const numSamples = Math.floor(dataSize / (channels * bytesPerSample));
  const buffers = Array.from({ length: channels }, () => new Float32Array(numSamples));
  let o = dataOff;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < channels; ch++) {
      let v: number;
      if (audioFormat === 3 || (bits === 32 && audioFormat !== 1)) {
        v = data.readFloatLE(o);
      } else if (bits === 16) {
        v = data.readInt16LE(o) / 32768;
      } else if (bits === 24) {
        v = data.readIntLE(o, 3) / 8388608;
      } else {
        v = data.readInt32LE(o) / 2147483648;
      }
      buffers[ch][i] = v;
      o += bytesPerSample;
    }
  }
  return { sampleRate, channels, bitDepth: bits, buffers };
}
