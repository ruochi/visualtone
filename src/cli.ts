#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { baseDirOf, render } from './render.js';
import { parseScore } from './schema.js';
import { encodeWav } from './wav.js';

const [cmd, input, output] = process.argv.slice(2);

function usage(): never {
  console.error('usage: visualtone render <score.json> [out.wav]\n       visualtone validate <score.json>');
  process.exit(1);
}

if (!cmd || !input) usage();

let score;
try {
  score = parseScore(JSON.parse(readFileSync(input, 'utf8')));
} catch (e) {
  console.error(`${input}: ${(e as Error).message}`);
  process.exit(1);
}

if (cmd === 'validate') {
  console.log(`${input}: ok, ${score.tracks.length} tracks`);
} else if (cmd === 'render') {
  const out = output ?? input.replace(/\.json$/, '') + '.wav';
  const t0 = performance.now();
  const r = render(score, { baseDir: baseDirOf(input) });
  writeFileSync(out, encodeWav(r.left, r.right, r.sampleRate));
  const { duration, loudnessDb, peakDb, limiterDb } = r.report;
  console.log(
    `${out}: ${duration.toFixed(1)}s, loudness ${loudnessDb.toFixed(1)} dBFS, peak ${peakDb.toFixed(1)} dBFS, ` +
      `limiter ${limiterDb.toFixed(1)} dB, rendered in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
  );
} else usage();
