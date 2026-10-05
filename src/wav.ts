export function writeWavFile(
  buffers: Float32Array[],
  sampleRate: number,
): Buffer {
  const numChannels = buffers.length;
  const numSamples = buffers[0].length;
  const bytesPerSample = 2;
  const byteRate = sampleRate * numChannels * bytesPerSample;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numSamples * numChannels * bytesPerSample;
  
  const buffer = Buffer.alloc(44 + dataSize);
  
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, buffers[ch][i]));
      const intValue = Math.round(sample * 32767);
      buffer.writeInt16LE(intValue, offset);
      offset += 2;
    }
  }
  
  return buffer;
}
