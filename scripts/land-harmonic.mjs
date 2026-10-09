// Copy fitted harmonic numbers back into src/engines/harmonic.ts when the holdout improved.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARMONIC_PRESETS } from '../dist/engines/harmonic.js';

const root = new URL('..', import.meta.url).pathname;
const ids = ['violin', 'viola', 'cello', 'contrabass', 'trumpet', 'horn', 'trombone', 'tuba', 'saxophone', 'oboe', 'bassoon'];

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
  cur[parts[parts.length - 1]] = value;
}

function tidy(n) {
  return Number(n.toFixed(5));
}

function emit(value, indent) {
  if (typeof value === 'number') return tidy(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => emit(v, indent)).join(', ')}]`;
  const pad = ' '.repeat(indent);
  const inner = ' '.repeat(indent + 2);
  const lines = Object.entries(value).map(([key, item]) => `${inner}${key}: ${emit(item, indent + 2)},`);
  return `{\n${lines.join('\n')}\n${pad}}`;
}

let source = readFileSync(join(root, 'src/engines/harmonic.ts'), 'utf8');
const landed = [];
const skipped = [];
for (const id of ids) {
  const report = JSON.parse(readFileSync(join(root, 'references/fit', `${id}.json`), 'utf8'));
  const before = report.before.holdoutExcess;
  const after = report.after.holdoutExcess;
  if (!(after < before - 0.005)) {
    skipped.push(`${id} ${before} -> ${after}`);
    continue;
  }
  const preset = structuredClone(HARMONIC_PRESETS[id]);
  for (const [path, value] of Object.entries(report.after.params)) setPath(preset, path, value);
  const block = `  ${id}: ${emit(preset, 2)},`;
  const re = new RegExp(`  ${id}: \\{[\\s\\S]*?\\n  \\},`);
  if (!re.test(source)) throw new Error(`could not find preset block for ${id}`);
  source = source.replace(re, block);
  landed.push(`${id} ${before} -> ${after}`);
}
writeFileSync(join(root, 'src/engines/harmonic.ts'), source);
console.log('landed');
for (const line of landed) console.log(' ', line);
console.log('kept');
for (const line of skipped) console.log(' ', line);
