import { parentPort, workerData } from 'node:worker_threads';
import { analyzeNote } from '../dist/analysis/timbre.js';
import { HARMONIC_PRESETS } from '../dist/engines/harmonic.js';
import { loadWav, scoreAgainst } from './lib/score-note.mjs';

const preset = HARMONIC_PRESETS[workerData.instrument];
if (!preset) throw new Error(`no harmonic preset ${workerData.instrument}`);

const notes = workerData.notes.map((note) => {
  const refBuf = loadWav(note.path);
  const refOpts = { midi: note.midi };
  if (note.timing?.hold !== undefined) refOpts.noteOff = note.timing.hold;
  return { ...note, refBuf, ref: analyzeNote(refBuf.mono, refBuf.sampleRate, refOpts) };
});

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

parentPort.postMessage({ ready: true });

parentPort.on('message', (msg) => {
  if (msg.clearRing) delete preset.ring;
  for (const [path, value] of Object.entries(msg.values)) {
    if (msg.clearRing && path.startsWith('ring.')) continue;
    setPath(preset, path, value);
  }
  if (!msg.clearRing && preset.ring && preset.ring.refHz === undefined) preset.ring.refHz = msg.refHz ?? 55;
  const want = new Set(msg.splits);
  const rows = [];
  for (const note of notes) {
    if (!want.has(note.split)) continue;
    const { ours, cmp } = scoreAgainst(
      note.refBuf,
      note.engine,
      note.hue,
      note.midi,
      note.size,
      note.kind,
      note.timing,
      workerData.floor,
      note.ref,
    );
    let penalty = 0;
    if (ours.centsOff !== null && Math.abs(ours.centsOff) > 8) penalty += (Math.abs(ours.centsOff) - 8) / 4;
    if (ours.artifacts.clicks > 0) penalty += Math.min(8, ours.artifacts.clicks) * 0.25;
    const worst = [...cmp.metrics].sort((a, b) => b.error / Math.max(1, workerData.floor?.[b.id] ?? 1) - a.error / Math.max(1, workerData.floor?.[a.id] ?? 1))[0];
    rows.push({
      file: note.file,
      split: note.split,
      midi: note.midi,
      size: note.size,
      excess: cmp.excess ?? cmp.distance,
      distance: cmp.distance,
      penalty,
      cents: ours.centsOff,
      clicks: ours.artifacts.clicks,
      worst: worst ? `${worst.label} ${worst.error.toFixed(2)}` : '',
    });
  }
  parentPort.postMessage({ rows });
});
