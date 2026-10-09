import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeNote, compareTimbre } from './timbre.js';
import { analyzeProbe, probeLayout } from '../probe.js';

const SR = 48000;

interface ToneSpec {
  f0: number;
  amps: number[];
  seconds: number;
  /** Stiffness: f_n = n·f0·√(1 + B·n²). */
  B?: number;
  /** dB per second per partial. */
  decays?: number[];
  attackSec?: number;
  vibrato?: { rate: number; cents: number };
  noise?: number;
  extra?: { hz: number; amp: number }[];
  lead?: number;
  /** Whole-note amplitude modulation: multiply by 1 + depth·sin. */
  am?: { hz: number; depth: number };
  /** One partial wanders on its own. index is 0-based. */
  flutterPartial?: { index: number; hz: number; depth: number };
  /** Partials from the 5th up take this long to fade in. */
  highAttackSec?: number;
  /**
   * Each partial's level follows the vibrato as a peak swing in dB.
   * Signs alternate when `alternate` is set, the way a body resonance does.
   */
  partialAm?: { depthDb: number; alternate?: boolean };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function tone(spec: ToneSpec, sr = SR): Float32Array {
  const lead = Math.floor((spec.lead ?? 0) * sr);
  const n = lead + Math.floor(spec.seconds * sr);
  const out = new Float32Array(n);
  const phases = spec.amps.map(() => 0);
  const extraPh = (spec.extra ?? []).map(() => 0);
  const rand = rng(7);
  for (let i = lead; i < n; i++) {
    const t = (i - lead) / sr;
    const vib = spec.vibrato ? Math.pow(2, (spec.vibrato.cents * Math.sin(2 * Math.PI * spec.vibrato.rate * t)) / 1200) : 1;
    const att = spec.attackSec ? Math.min(1, t / spec.attackSec) : 1;
    let v = 0;
    spec.amps.forEach((a, k) => {
      const h = k + 1;
      const f = h * spec.f0 * Math.sqrt(1 + (spec.B ?? 0) * h * h) * vib;
      if (f >= sr * 0.45) return;
      phases[k] += (2 * Math.PI * f) / sr;
      const d = spec.decays ? Math.pow(10, (-(spec.decays[k] ?? 0) * t) / 20) : 1;
      const own = spec.flutterPartial && spec.flutterPartial.index === k
        ? 1 + spec.flutterPartial.depth * Math.sin(2 * Math.PI * spec.flutterPartial.hz * t)
        : 1;
      const locked = spec.partialAm && spec.vibrato
        ? Math.pow(10, (((spec.partialAm.alternate && k % 2 === 1 ? -1 : 1) * spec.partialAm.depthDb * Math.sin(2 * Math.PI * spec.vibrato.rate * t)) / 20))
        : 1;
      const rise = spec.highAttackSec && k >= 4 ? Math.min(1, t / spec.highAttackSec) : 1;
      v += a * d * own * locked * rise * Math.sin(phases[k]);
    });
    (spec.extra ?? []).forEach((e, k) => {
      extraPh[k] += (2 * Math.PI * e.hz) / sr;
      v += e.amp * Math.sin(extraPh[k]);
    });
    if (spec.noise) v += spec.noise * (rand() * 2 - 1);
    const am = spec.am ? 1 + spec.am.depth * Math.sin(2 * Math.PI * spec.am.hz * t) : 1;
    out[i] = v * att * am * 0.3;
  }
  return out;
}

const saw = (count: number) => Array.from({ length: count }, (_, i) => 1 / (i + 1));

test('timbre: pitch and partial shape of a sawtooth', () => {
  const f = analyzeNote(tone({ f0: 220, amps: saw(20), seconds: 1 }), SR, { midi: 57 });
  assert.ok(f.centsOff !== null && Math.abs(f.centsOff) < 1, `cents ${f.centsOff}`);
  assert.ok(Math.abs(f.harmonics.amplitudesDb[1]! + 6.02) < 0.5, `h2 ${f.harmonics.amplitudesDb[1]}`);
  assert.ok(Math.abs(f.harmonics.amplitudesDb[3]! + 12.04) < 0.5, `h4 ${f.harmonics.amplitudesDb[3]}`);
  assert.ok(Math.abs(f.harmonics.slopeDbPerOct! + 6.02) < 0.5, `slope ${f.harmonics.slopeDbPerOct}`);
  assert.ok(Math.abs(f.harmonics.oddEvenDb! + 2.75) < 0.5, `odd/even ${f.harmonics.oddEvenDb}`);
  assert.ok(f.harmonics.hnrDb! > 40, `hnr ${f.harmonics.hnrDb}`);
  assert.ok((f.harmonics.inharmonicity ?? 0) < 2e-6, `B ${f.harmonics.inharmonicity}`);
  assert.ok(f.harmonics.spuriousDb === null || f.harmonics.spuriousDb < -60, `spurious ${f.harmonics.spuriousDb}`);
  assert.equal(f.artifacts.clicks, 0);
});

test('timbre: odd partials only reads as hollow', () => {
  const amps = saw(15).map((a, i) => (i % 2 === 0 ? a : 0));
  const f = analyzeNote(tone({ f0: 196, amps, seconds: 1 }), SR);
  assert.ok(f.harmonics.oddEvenDb! > 30, `odd/even ${f.harmonics.oddEvenDb}`);
});

test('timbre: stiff-string inharmonicity B is recovered', () => {
  const f = analyzeNote(tone({ f0: 110, amps: saw(24), seconds: 1.5, B: 4e-4 }), SR);
  const B = f.harmonics.inharmonicity!;
  assert.ok(Math.abs(B - 4e-4) / 4e-4 < 0.1, `B ${B}`);
  assert.ok(f.harmonics.freqRatios[9]! > 10.1, `ratio 10 ${f.harmonics.freqRatios[9]}`);
});

test('timbre: per-partial and overall decay rates', () => {
  const decays = Array.from({ length: 8 }, (_, i) => 8 * (i + 1));
  const f = analyzeNote(tone({ f0: 330, amps: saw(8), seconds: 2.5, decays, attackSec: 0.002 }), SR);
  for (let n = 1; n <= 6; n++) {
    const got = f.harmonics.decayDbPerSec[n - 1]!;
    assert.ok(Math.abs(got - 8 * n) / (8 * n) < 0.1, `partial ${n}: ${got}`);
  }
  const single = analyzeNote(tone({ f0: 440, amps: [1], seconds: 3, decays: [20] }), SR);
  assert.ok(Math.abs(single.envelope.decayDbPerSec! - 20) < 1.5, `decay ${single.envelope.decayDbPerSec}`);
  assert.ok(Math.abs(single.envelope.t60Sec! - 3) < 0.25, `t60 ${single.envelope.t60Sec}`);
});

test('timbre: attack time and onset', () => {
  const f = analyzeNote(tone({ f0: 440, amps: [1], seconds: 0.6, attackSec: 0.02, lead: 0.1 }), SR);
  assert.ok(Math.abs(f.envelope.attackMs - 16) < 2.5, `attack ${f.envelope.attackMs}`);
  assert.ok(Math.abs(f.onsetSec - 0.102) < 0.003, `onset ${f.onsetSec}`);
});

test('timbre: vibrato rate and depth', () => {
  const f = analyzeNote(tone({ f0: 262, amps: saw(6), seconds: 2, vibrato: { rate: 5.5, cents: 30 } }), SR);
  assert.ok(Math.abs(f.pitch.vibratoRateHz! - 5.5) < 0.3, `rate ${f.pitch.vibratoRateHz}`);
  assert.ok(Math.abs(f.pitch.vibratoDepthCents! - 30) < 6, `depth ${f.pitch.vibratoDepthCents}`);
  const still = analyzeNote(tone({ f0: 262, amps: saw(6), seconds: 2 }), SR);
  assert.equal(still.pitch.vibratoDepthCents, null);
});

test('timbre: noise lowers HNR and raises flatness', () => {
  const clean = analyzeNote(tone({ f0: 300, amps: saw(10), seconds: 1 }), SR);
  const noisy = analyzeNote(tone({ f0: 300, amps: saw(10), seconds: 1, noise: 0.2 }), SR);
  assert.ok(clean.harmonics.hnrDb! - noisy.harmonics.hnrDb! > 15, `${clean.harmonics.hnrDb} vs ${noisy.harmonics.hnrDb}`);
  assert.ok(noisy.spectrum.flatnessSustain! > clean.spectrum.flatnessSustain! * 10);
});

test('timbre: marimba-like mode ratios show up as peaks', () => {
  const sig = new Float32Array(SR);
  const modes = [
    { r: 1, a: 1, d: 6 },
    { r: 3.92, a: 0.5, d: 15 },
    { r: 9.15, a: 0.3, d: 30 },
  ];
  for (let i = 0; i < sig.length; i++) {
    const t = i / SR;
    for (const m of modes) sig[i] += m.a * Math.pow(10, (-m.d * t) / 20) * Math.sin(2 * Math.PI * 220 * m.r * t) * 0.3;
  }
  const f = analyzeNote(sig, SR);
  const ratios = f.peaks.map((p) => p.ratio ?? 0);
  assert.ok(ratios.some((r) => Math.abs(r - 3.92) < 0.02), `ratios ${ratios}`);
  assert.ok(ratios.some((r) => Math.abs(r - 9.15) < 0.05), `ratios ${ratios}`);
});

test('timbre: aliasing-like component is reported as spurious', () => {
  const f = analyzeNote(tone({ f0: 220, amps: saw(12), seconds: 1, extra: [{ hz: 220 * 4.37, amp: 0.0316 }] }), SR);
  assert.ok(f.harmonics.spuriousDb !== null && Math.abs(f.harmonics.spuriousDb + 30) < 3, `spurious ${f.harmonics.spuriousDb}`);
});

test('timbre: hard cut clicks, a fade does not; release time', () => {
  const cut = tone({ f0: 440, amps: [1], seconds: 1 });
  cut.fill(0, Math.floor(0.6 * SR));
  const hard = analyzeNote(cut, SR);
  assert.ok(hard.artifacts.clicks >= 1);
  assert.ok(Math.abs(hard.artifacts.clickTimes[0] - 0.6) < 0.002, `at ${hard.artifacts.clickTimes[0]}`);

  const faded = tone({ f0: 440, amps: [1], seconds: 1 });
  const a = Math.floor(0.6 * SR);
  const fade = Math.floor(0.02 * SR);
  for (let i = a; i < faded.length; i++) faded[i] *= i < a + fade ? 0.5 + 0.5 * Math.cos((Math.PI * (i - a)) / fade) : 0;
  assert.equal(analyzeNote(faded, SR).artifacts.clicks, 0);

  const rel = tone({ f0: 440, amps: [1], seconds: 1.2 });
  const off = Math.floor(0.5 * SR);
  for (let i = off; i < rel.length; i++) rel[i] *= Math.pow(10, (-200 * ((i - off) / SR)) / 20);
  const f = analyzeNote(rel, SR, { noteOff: 0.5 });
  assert.ok(f.envelope.releaseMs !== null && Math.abs(f.envelope.releaseMs - 150) < 20, `release ${f.envelope.releaseMs}`);
});

test('timbre: a steady tone is flat, and modulation is measured', () => {
  const steady = analyzeNote(tone({ f0: 440, amps: saw(8), seconds: 1.6 }), SR);
  assert.ok(steady.envelope.shimmerDb !== null && steady.envelope.shimmerDb < -35, `shimmer ${steady.envelope.shimmerDb}`);
  assert.ok(steady.harmonics.flutterDb !== null && steady.harmonics.flutterDb < 0.6, `flutter ${steady.harmonics.flutterDb}`);
  assert.ok(steady.pitch.jitterCents !== null && steady.pitch.jitterCents < 2, `jitter ${steady.pitch.jitterCents}`);

  const am = analyzeNote(tone({ f0: 440, amps: saw(8), seconds: 1.6, am: { hz: 12, depth: 0.3 } }), SR);
  assert.ok(am.envelope.shimmerDb! > steady.envelope.shimmerDb! + 15, `am shimmer ${am.envelope.shimmerDb}`);

  const wandered = analyzeNote(tone({ f0: 330, amps: saw(6), seconds: 1.6, flutterPartial: { index: 2, hz: 3, depth: 0.9 } }), SR);
  assert.ok(wandered.harmonics.flutterDb! > steady.harmonics.flutterDb! + 0.5, `flutter ${steady.harmonics.flutterDb} -> ${wandered.harmonics.flutterDb}`);

  const late = analyzeNote(tone({ f0: 220, amps: saw(12), seconds: 0.8, highAttackSec: 0.1 }), SR);
  const together = analyzeNote(tone({ f0: 220, amps: saw(12), seconds: 0.8, attackSec: 0.004 }), SR);
  assert.ok(
    late.spectrum.brightnessLagMs! > together.spectrum.brightnessLagMs! + 15,
    `lag ${together.spectrum.brightnessLagMs} -> ${late.spectrum.brightnessLagMs}`,
  );
});

test('compareTimbre: identical passes, a faster decay is named first', () => {
  const spec: ToneSpec = { f0: 262, amps: saw(10), seconds: 2, decays: Array.from({ length: 10 }, (_, i) => 6 + 3 * i), attackSec: 0.003 };
  const ref = analyzeNote(tone(spec), SR);
  const same = compareTimbre(analyzeNote(tone(spec), SR), ref);
  assert.equal(same.findings.length, 0, JSON.stringify(same.findings));
  assert.equal(same.passed, same.total);

  const fast = analyzeNote(tone({ ...spec, decays: spec.decays!.map((d) => d * 3) }), SR);
  const cmp = compareTimbre(fast, ref);
  assert.ok(cmp.findings.length > 0);
  assert.ok(/decay/i.test(cmp.findings[0].id), cmp.findings.map((f) => f.id).join(','));
  assert.ok(cmp.distance > same.distance);
  assert.equal(same.excess, null);

  const decay = cmp.metrics.find((m) => m.id === 'decay')!;
  assert.ok(decay.error > 1);
  const absorbed = compareTimbre(fast, ref, { decay: decay.error, 'decay.early': 50, 'decay.late': 50, partialDecay: 50, envelope: 50 });
  assert.ok(!absorbed.findings.some((f) => f.metric === 'decay'), absorbed.findings.map((f) => f.metric).join(','));
  assert.ok(absorbed.excess !== null && absorbed.excess < cmp.distance);
});

test('timbre: partial levels locked to vibrato, with mixed signs', () => {
  const locked = analyzeNote(
    tone({
      f0: 880,
      amps: saw(8),
      seconds: 2.2,
      vibrato: { rate: 5.5, cents: 25 },
      partialAm: { depthDb: 4, alternate: true },
    }),
    SR,
  );
  assert.ok(Math.abs(locked.motion.vibratoAmDb! - 4) < 1.5, `am ${locked.motion.vibratoAmDb}`);
  assert.ok(locked.motion.amCorr! < 0.45, `corr ${locked.motion.amCorr}`);
  assert.ok(locked.motion.amOpposite! > 0.3 && locked.motion.amOpposite! < 0.75, `opposite ${locked.motion.amOpposite}`);
  assert.ok(locked.pitch.vibratoDepthCv !== null && locked.pitch.vibratoDepthCv < 0.2, `depth cv ${locked.pitch.vibratoDepthCv}`);

  const together = analyzeNote(tone({ f0: 880, amps: saw(8), seconds: 2.2, am: { hz: 6, depth: 0.35 } }), SR);
  assert.ok(together.motion.amCorr! > 0.85, `together ${together.motion.amCorr}`);
  assert.ok(together.motion.vibratoAmDb !== null && together.motion.vibratoAmDb < 0.8, `unlocked ${together.motion.vibratoAmDb}`);
});

test('timbre: a straight ladder is smooth, and gap noise is measured', () => {
  const straight = analyzeNote(tone({ f0: 220, amps: saw(20), seconds: 1.4 }), SR);
  assert.ok(straight.motion.ladderJagDb! < 1.5, `straight ${straight.motion.ladderJagDb}`);
  const jaggedAmps = saw(20).map((a, i) => a * (i % 2 === 0 ? 2 : 0.5));
  const jagged = analyzeNote(tone({ f0: 220, amps: jaggedAmps, seconds: 1.4 }), SR);
  assert.ok(jagged.motion.ladderJagDb! > 4, `jagged ${jagged.motion.ladderJagDb}`);

  const quiet = analyzeNote(tone({ f0: 400, amps: [1], seconds: 1.2 }), SR);
  const known = analyzeNote(tone({ f0: 400, amps: [1], seconds: 1.2, extra: [{ hz: 600, amp: 0.1 }] }), SR);
  const band = known.motion.gapNoiseDb[0];
  assert.ok(band !== null && Math.abs(band - -20) < 1.5, `gap ${known.motion.gapNoiseDb} quiet ${quiet.motion.gapNoiseDb}`);
  assert.ok(quiet.motion.gapNoiseDb[0]! < band! - 10, `quiet gap ${quiet.motion.gapNoiseDb[0]}`);

  const full = analyzeNote(tone({ f0: 1000, amps: saw(16), seconds: 1.2 }), SR);
  const few = analyzeNote(tone({ f0: 1000, amps: saw(3), seconds: 1.2 }), SR);
  assert.ok(full.motion.topPartialFrac! > 0.75, `full ${full.motion.topPartialFrac}`);
  assert.ok(few.motion.topPartialFrac! < 0.35, `few ${few.motion.topPartialFrac}`);
});

test('timbre: band share hears a 3 kHz peak and low rumble', () => {
  const plain = analyzeNote(tone({ f0: 220, amps: saw(8), seconds: 1.2 }), SR);
  const bright = analyzeNote(tone({ f0: 220, amps: saw(8), seconds: 1.2, extra: [{ hz: 3000, amp: 0.8 }] }), SR);
  assert.ok(
    bright.spectrum.bandShareDb[2]! > plain.spectrum.bandShareDb[2]! + 6,
    `2–4 kHz ${plain.spectrum.bandShareDb[2]} -> ${bright.spectrum.bandShareDb[2]}`,
  );
  const rumble = analyzeNote(tone({ f0: 220, amps: saw(8), seconds: 1.2, extra: [{ hz: 40, amp: 0.5 }] }), SR);
  assert.ok(
    rumble.spectrum.bandShareDb[0]! > plain.spectrum.bandShareDb[0]! + 6,
    `sub ${plain.spectrum.bandShareDb[0]} -> ${rumble.spectrum.bandShareDb[0]}`,
  );
  const metric = compareTimbre(bright, plain).metrics.find((m) => m.id === 'bandShare');
  assert.ok(metric && metric.error > 1, `error ${metric?.error}`);
});

test('analyzeProbe flags an out-of-tune cell', () => {
  const cells = probeLayout({ pitches: [60, 72], sizes: [0.5], noteSec: 0.5, tailSec: 0.3 });
  const total = Math.ceil(cells[cells.length - 1].stop * SR);
  const buf = new Float32Array(total);
  cells.forEach((c, idx) => {
    const hz = 440 * Math.pow(2, (c.midi - 69) / 12) * (idx === 1 ? Math.pow(2, 30 / 1200) : 1);
    const a = Math.floor(c.noteOn * SR);
    const b = Math.floor(c.noteOff * SR);
    const fade = Math.floor(0.01 * SR);
    for (let i = a; i < b; i++) {
      const env = Math.min(1, (i - a) / fade, (b - i) / fade);
      buf[i] = 0.3 * env * Math.sin((2 * Math.PI * hz * (i - a)) / SR);
    }
  });
  const report = analyzeProbe(buf, SR, cells);
  assert.ok(Math.abs(report.cells[0].features.centsOff!) < 2);
  assert.ok(Math.abs(report.cells[1].features.centsOff! - 30) < 2);
  const pitch = report.findings.find((f) => f.id === 'probe.pitch');
  assert.ok(pitch && pitch.message.includes('C5'), JSON.stringify(report.findings));
  assert.equal(report.tracking.clicks, 0);
});
