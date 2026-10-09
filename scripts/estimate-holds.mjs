// Write the release point of each sustained recording onto the catalog note.
// Hold is the time the level stays within 6 dB of the middle-section plateau.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWavFile } from '../dist/wav.js';
import { recordedFile } from './lib/score-note.mjs';

const root = new URL('..', import.meta.url).pathname;
const catalogPath = join(root, 'references/catalog.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));

function monoOf(path) {
  const wav = readWavFile(readFileSync(path));
  const n = wav.buffers[0].length;
  const mono = new Float32Array(n);
  for (const buffer of wav.buffers) for (let i = 0; i < n; i++) mono[i] += buffer[i] / wav.buffers.length;
  return { mono, sampleRate: wav.sampleRate };
}

function median(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Seconds from the start of the file until the sustain falls 6 dB. */
export function estimateHold(mono, sampleRate) {
  const hop = Math.round(0.01 * sampleRate);
  const win = hop * 2;
  const db = [];
  for (let i = 0; i + win < mono.length; i += hop) {
    let energy = 0;
    for (let j = 0; j < win; j++) energy += mono[i + j] * mono[i + j];
    db.push(20 * Math.log10(Math.sqrt(energy / win) + 1e-12));
  }
  const n = db.length;
  const a = Math.floor(n * 0.2);
  const b = Math.max(a + 1, Math.floor(n * 0.45));
  const plateau = median(db.slice(a, b));
  const thresh = plateau - 6;
  const stay = Math.max(3, Math.round(0.08 * sampleRate / hop));
  let hit = -1;
  for (let i = b; i < n - stay; i++) {
    let held = true;
    for (let k = 0; k < stay; k++) {
      if (db[i + k] > thresh) {
        held = false;
        break;
      }
    }
    if (held) {
      hit = i;
      break;
    }
  }
  const duration = mono.length / sampleRate;
  let sec = hit < 0 ? duration * 0.7 : (hit * hop) / sampleRate;
  sec = Math.min(duration - 0.12, Math.max(0.4, sec));
  const tail = Math.min(1.2, Math.max(0.2, duration - sec));
  return { hold: Number(sec.toFixed(3)), tail: Number(tail.toFixed(3)) };
}

let written = 0;
for (const set of catalog.sets) {
  if (set.kind !== 'sustain' || set.hold !== undefined) continue;
  const dir = join(root, 'references/recorded', set.id);
  for (const note of set.notes) {
    const file = recordedFile(note);
    const { mono, sampleRate } = monoOf(join(dir, file));
    const est = estimateHold(mono, sampleRate);
    note.hold = est.hold;
    note.tail = est.tail;
    written++;
  }
  const holds = set.notes.map((n) => n.hold);
  console.log(set.id, 'holds', Math.min(...holds).toFixed(2), '–', Math.max(...holds).toFixed(2), 'n=' + holds.length);
}
writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
console.log('wrote holds on', written, 'notes');
