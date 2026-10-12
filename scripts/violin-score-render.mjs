// Render one score once per seed, for the violin scorecard.
//
//   node scripts/violin-score-render.mjs <score.json> <outDir> <name> <seed> [<seed> ...] [--dist dir]
//
// The seed replaces the score seed and every track seed, so vibrato jitter,
// wander, and bow noise draw new numbers while the preset stays the same.
// `--dist` renders with another build, for scoring an older commit.
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const distAt = args.indexOf('--dist');
const dist = resolve(distAt >= 0 ? args.splice(distAt, 2)[1] : new URL('../dist', import.meta.url).pathname);
const [scorePath, outDir, name, ...seeds] = args;
if (!scorePath || !outDir || !name || seeds.length === 0) {
  console.error('usage: violin-score-render.mjs <score.json> <outDir> <name> <seed> [...] [--dist dir]');
  process.exit(1);
}

const { loadScoreFile } = await import(pathToFileURL(join(dist, 'load-score.js')).href);
const { render } = await import(pathToFileURL(join(dist, 'renderer.js')).href);
const { writeWavFile } = await import(pathToFileURL(join(dist, 'wav.js')).href);

for (const seed of seeds.map(Number)) {
  const loaded = loadScoreFile(scorePath);
  const score = { ...loaded.score, seed, tracks: loaded.score.tracks.map((t) => ({ ...t, seed })) };
  const rendered = render(score, { clips: loaded.clips });
  const out = join(outDir, `${name}-${seed}.wav`);
  writeFileSync(out, writeWavFile(rendered.buffers, rendered.sampleRate, { bitDepth: 16 }));
  console.log('wrote', out);
}
