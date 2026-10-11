// Render the oracle control score (L2) and the written menuet (L3).
import { writeFileSync } from 'node:fs';
import { loadScoreFile } from '../dist/load-score.js';
import { render } from '../dist/renderer.js';
import { writeWavFile } from '../dist/wav.js';

const outDir = process.argv[2] ?? '/tmp/violin-solo/oracle';
const jobs = [
  [`${outDir}/l2-score.json`, `${outDir}/l2.wav`],
  ['examples/violin-minuet.json', `${outDir}/l3.wav`],
];

for (const [scorePath, wavPath] of jobs) {
  const loaded = loadScoreFile(scorePath);
  const rendered = render(loaded.score);
  const mix = rendered.buffers;
  writeFileSync(wavPath, writeWavFile(mix, rendered.sampleRate, { bitDepth: 16 }));
  let peak = 0;
  for (const b of mix) {
    for (let i = 0; i < b.length; i++) peak = Math.max(peak, Math.abs(b[i]));
  }
  console.log('wrote', wavPath, 'sec', rendered.duration.toFixed(2), 'peak', peak.toFixed(3));
}
