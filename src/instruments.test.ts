import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isAcousticEngine } from './engines/acoustic.js';
import { harmonicInstrumentFor, HARMONIC_PRESETS } from './engines/harmonic.js';
import { INSTRUMENTS, INSTRUMENT_IDS, MODELS, type InstrumentId } from './instruments.js';
import { render } from './renderer.js';
import { EngineSchema, ScoreSchema } from './schema.js';

test('every engine belongs to exactly one model, and every model has an instrument', () => {
  for (const engine of EngineSchema.options) {
    const owners = Object.entries(MODELS).filter(([, m]) => (m.engines as readonly string[]).includes(engine));
    assert.equal(owners.length, 1, `${engine} is in ${owners.length} models`);
  }
  for (const [id, model] of Object.entries(MODELS)) {
    assert.ok(
      Object.values(INSTRUMENTS).some((i) => i.model === id),
      `${id} has no instrument`,
    );
    for (const e of model.engines) assert.ok(e === 'wavetable' || isAcousticEngine(e));
  }
  for (const [id, inst] of Object.entries(INSTRUMENTS)) {
    assert.ok((MODELS[inst.model].engines as readonly string[]).includes(inst.engine), `${id}: ${inst.engine} is outside ${inst.model}`);
  }
});

test('harmonic instruments select their own preset', () => {
  for (const [id, inst] of Object.entries(INSTRUMENTS)) {
    if (inst.model !== 'harmonic') continue;
    assert.ok(id in HARMONIC_PRESETS, `${id} has no preset`);
    assert.equal(harmonicInstrumentFor(inst.engine as 'bow' | 'brass' | 'reed' | 'bass', inst.hue), id);
  }
  assert.equal(
    Object.values(INSTRUMENTS).filter((i) => i.model === 'harmonic').length,
    Object.keys(HARMONIC_PRESETS).length,
  );
});

test('instrument references match the recordings they were scored against', () => {
  const catalog = JSON.parse(readFileSync('references/catalog.json', 'utf8')) as {
    sets: { id: string; engine?: string; hue?: number }[];
  };
  const byId = new Map(catalog.sets.map((s) => [s.id, s]));
  for (const [id, inst] of Object.entries(INSTRUMENTS)) {
    if (!('reference' in inst)) continue;
    const set = byId.get(inst.reference);
    assert.ok(set, `${id}: ${inst.reference} is not in the catalog`);
    assert.equal(set.engine, inst.engine, id);
    assert.equal(set.hue, inst.hue, id);
  }
});

test('an instrument name renders the same samples as its engine and hue', () => {
  const note = [{ t: 0.01, y: 57, size: 0.7, duration: 0.15 }];
  const renderTrack = (track: Record<string, unknown>) =>
    render(
      ScoreSchema.parse({
        sampleRate: 22050,
        duration: 0.25,
        seed: 3,
        master: { loudness: -20, drive: 0 },
        tracks: [{ id: 'n', channel: [0, 1], notes: note, ...track }],
      }),
    ).buffers[0];
  for (const id of INSTRUMENT_IDS) {
    const inst = INSTRUMENTS[id as InstrumentId];
    const named = renderTrack({ instrument: id });
    const plain = renderTrack({ engine: inst.engine, hue: inst.hue });
    assert.equal(named.length, plain.length);
    let peak = 0;
    for (let i = 0; i < named.length; i++) {
      assert.equal(named[i], plain[i], `${id} sample ${i}`);
      peak = Math.max(peak, Math.abs(named[i]));
    }
    assert.ok(peak > 1e-4, `${id} is silent`);
  }
});

test('instrument cannot be combined with engine or hue', () => {
  const base = { sampleRate: 22050, duration: 0.1, tracks: [] as unknown[] };
  const notes = [{ t: 0, y: 60, size: 0.5, duration: 0.05 }];
  assert.throws(() => ScoreSchema.parse({ ...base, tracks: [{ id: 'a', instrument: 'violin', engine: 'bow', notes }] }));
  assert.throws(() => ScoreSchema.parse({ ...base, tracks: [{ id: 'a', instrument: 'violin', hue: 40, notes }] }));
  assert.throws(() => ScoreSchema.parse({ ...base, tracks: [{ id: 'a', instrument: 'theremin', notes }] }));
  const ok = ScoreSchema.parse({ ...base, tracks: [{ id: 'a', instrument: 'cello', notes }] });
  assert.equal(ok.tracks[0].engine, 'bow');
  assert.equal(ok.tracks[0].hue, 300);
});
