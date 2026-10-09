// Copy a fitted non-harmonic preset back into src/engines/acoustic.ts when the holdout improved.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BAR_PRESETS,
  DRUM_PRESETS,
  EPIANO_PRESETS,
  ORGAN_REG,
  PIANO_PRESETS,
  PLUCK_PRESETS,
  WIND_PRESETS,
} from '../dist/engines/acoustic.js';

const root = new URL('..', import.meta.url).pathname;
const sourcePath = join(root, 'src/engines/acoustic.ts');

const jobs = [
  ['marimba', BAR_PRESETS.marimba, '  marimba:'],
  ['xylophone', BAR_PRESETS.xylophone, '  xylophone:'],
  ['glockenspiel', BAR_PRESETS.glockenspiel, '  glockenspiel:'],
  ['vibraphone', BAR_PRESETS.vibraphone, '  vibraphone:'],
  ['tom', DRUM_PRESETS.tom, '  tom:'],
  ['piano', PIANO_PRESETS.piano, '  piano:'],
  ['harp', PLUCK_PRESETS.harp, '  harp:'],
  ['flute', WIND_PRESETS.flute, '  flute:'],
  ['clarinet', WIND_PRESETS.clarinet, '  clarinet:'],
  ['electric-piano', EPIANO_PRESETS['electric-piano'], "  'electric-piano':"],
];

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
  if (typeof value === 'number') return String(tidy(value));
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map((v) => emit(v, indent)).join(', ')}]`;
  const pad = ' '.repeat(indent);
  const inner = ' '.repeat(indent + 2);
  const lines = Object.entries(value).map(([key, item]) => {
    const name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : `'${key}'`;
    return `${inner}${name}: ${emit(item, indent + 2)},`;
  });
  return `{\n${lines.join('\n')}\n${pad}}`;
}

let source = readFileSync(sourcePath, 'utf8');
const landed = [];
const skipped = [];
for (const [id, base, key] of jobs) {
  const report = JSON.parse(readFileSync(join(root, 'references/fit', `${id}.json`), 'utf8'));
  const before = report.before.holdoutExcess;
  const after = report.after.holdoutExcess;
  if (!(after < before - 0.005)) {
    skipped.push(`${id} ${before} -> ${after}`);
    continue;
  }
  const preset = structuredClone(base);
  for (const [path, value] of Object.entries(report.after.params)) setPath(preset, path, value);
  const block = `${key} ${emit(preset, 2)},`;
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const oneLine = new RegExp(`${esc} \\{[^\\n]*\\},`);
  const multi = new RegExp(`${esc} \\{[\\s\\S]*?\\n  \\},`);
  const re = oneLine.test(source) ? oneLine : multi;
  if (!re.test(source)) throw new Error(`could not find ${id}`);
  source = source.replace(re, block);
  landed.push(`${id} ${before} -> ${after}`);
}

const organReportPath = join(root, 'references/fit/organ.json');
{
  const report = JSON.parse(readFileSync(organReportPath, 'utf8'));
  const before = report.before.holdoutExcess;
  const after = report.after.holdoutExcess;
  if (after < before - 0.005) {
    const stops = ORGAN_REG[0].slice();
    for (const [path, value] of Object.entries(report.after.params)) {
      const index = Number(path.split('.')[1]);
      stops[index] = value;
    }
    const line = `  [${stops.map((n) => tidy(n)).join(', ')}],`;
    source = source.replace(/export const ORGAN_REG = \[\n  \[[^\]]+\],/, `export const ORGAN_REG = [\n${line}`);
    landed.push(`organ ${before} -> ${after}`);
  } else skipped.push(`organ ${before} -> ${after}`);
}

writeFileSync(sourcePath, source);
console.log('landed');
for (const line of landed) console.log(' ', line);
console.log('kept');
for (const line of skipped) console.log(' ', line);
