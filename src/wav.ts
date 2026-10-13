/** 16-bit stereo WAV writer and a PCM/float WAV reader for clips. */

export function encodeWav(l: Float32Array, r: Float32Array, sampleRate: number): Buffer {
  const n = l.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, l[i])) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, r[i])) * 32767), 46 + i * 4);
  }
  return buf;
}

export interface DecodedWav {
  sampleRate: number;
  channels: Float32Array[];
}

/** Reads 16/24/32-bit PCM and 32-bit float WAV. */
export function decodeWav(buf: Buffer): DecodedWav {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
  let pos = 12;
  let format = 0, channels = 0, sampleRate = 0, bits = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
      if (format === 0xfffe) format = buf.readUInt16LE(body + 24);
    } else if (id === 'data') {
      const bytes = bits / 8;
      const frames = Math.floor(Math.min(size, buf.length - body) / (bytes * channels));
      const out = Array.from({ length: channels }, () => new Float32Array(frames));
      for (let f = 0; f < frames; f++) {
        for (let c = 0; c < channels; c++) {
          const o = body + (f * channels + c) * bytes;
          let v: number;
          if (format === 3 && bits === 32) v = buf.readFloatLE(o);
          else if (bits === 16) v = buf.readInt16LE(o) / 32768;
          else if (bits === 24) v = buf.readIntLE(o, 3) / 8388608;
          else if (bits === 32) v = buf.readInt32LE(o) / 2147483648;
          else throw new Error(`Unsupported WAV: ${bits}-bit format ${format}`);
          out[c][f] = v;
        }
      }
      return { sampleRate, channels: out };
    }
    pos = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}
