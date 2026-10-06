import { readFileSync, writeFileSync } from 'node:fs';
import { analyze, reportToJson } from './analysis/index.js';
import { diffFindings } from './analysis/findings.js';
import { getProfile, profileFromReports } from './analysis/profiles.js';
import type { AnalysisReport } from './analysis/types.js';
import { render } from './renderer.js';
import { renderReport } from './report/panels.js';
import { ScoreSchema, type Score } from './schema.js';
import { readWavFile } from './wav.js';

function flag(name: string, args: string[]): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function loadMix(path: string): {
  buffers: Float32Array[];
  sampleRate: number;
  score?: Score;
  stems?: { id: string; l: Float32Array; r: Float32Array }[];
} {
  if (path.endsWith('.wav')) {
    const decoded = readWavFile(readFileSync(path));
    return { buffers: decoded.buffers, sampleRate: decoded.sampleRate };
  }
  const score = ScoreSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const rendered = render(score, { stems: true });
  return {
    buffers: rendered.buffers,
    sampleRate: rendered.sampleRate,
    score,
    stems: rendered.stems,
  };
}

function resolveProfile(arg: string | undefined) {
  if (!arg) return undefined;
  const builtin = getProfile(arg);
  if (builtin) return builtin;
  return JSON.parse(readFileSync(arg, 'utf8'));
}

export function runAnalyze(args: string[]): void {
  const input = args[1];
  if (!input || input.startsWith('-')) {
    console.error('Usage: visualtone analyze <score.json|mix.wav> [--profile name|file] [--json out.json] [--png out.png] [--panel name]');
    process.exit(1);
  }
  const loaded = loadMix(input);
  const profile = resolveProfile(flag('--profile', args));
  const result = analyze({
    buffers: loaded.buffers,
    sampleRate: loaded.sampleRate,
    stems: loaded.stems,
    score: loaded.score,
    profile,
  });
  const jsonPath = flag('--json', args);
  const pngPath = flag('--png', args);
  const panel = flag('--panel', args);
  if (jsonPath) writeFileSync(jsonPath, reportToJson(result.report));
  if (pngPath || panel) {
    const png = renderReport(result, loaded.score, panel);
    const out = pngPath ?? flag('--panel-out', args) ?? 'report.png';
    writeFileSync(out, png);
    console.log(`Wrote ${out}`);
  }
  printReport(result.report);
  if (jsonPath) console.log(`Wrote ${jsonPath}`);
}

function printReport(report: AnalysisReport): void {
  console.log(
    `LUFS ${report.loudness.integratedLufs.toFixed(1)}  LRA ${report.loudness.rangeLufs.toFixed(1)}  ` +
      `true peak ${report.loudness.truePeakDbtp.toFixed(1)} dBTP  PLR ${report.loudness.plr.toFixed(1)}`,
  );
  console.log(
    'bands  ' + report.bands.map((b) => `${b.name} ${(b.share * 100).toFixed(1)}%`).join('  '),
  );
  console.log(
    `stereo  corr ${report.stereo.correlation.toFixed(2)}  side/mid ${report.stereo.sideMidDb.toFixed(1)} dB  ` +
      `low balance ${report.stereo.lowBalanceDb.toFixed(1)} dB  low corr ${report.stereo.lowCorrelation.toFixed(2)}`,
  );
  console.log(
    `rhythm  tempo ${report.rhythm.tempo?.toFixed(1) ?? '-'}  swing ${report.rhythm.swing?.toFixed(2) ?? '-'}  ` +
      `onsets ${report.rhythm.onsetCount}  kick punch ${report.rhythm.kickPunch?.toFixed(2) ?? '-'}  ` +
      `sidechain ${report.rhythm.sidechainDb?.toFixed(1) ?? '-'} dB`,
  );
  console.log(
    `harmony  ${report.harmony.key ?? '-'} (${report.harmony.correlation.toFixed(2)})  ` +
      `contrast ${report.structure.contrastDb.toFixed(1)} dB`,
  );
  if (report.masking) {
    const top = report.masking.trackIds
      .map((id, i) => ({ id, share: report.masking!.shares[i] }))
      .sort((a, b) => b.share - a.share)
      .slice(0, 6)
      .map((t) => `${t.id} ${(t.share * 100).toFixed(0)}%`)
      .join('  ');
    console.log(`stems  ${top}`);
  }
  if (report.profile) console.log(`profile  ${report.profile.name} — ${report.profile.note}`);
  if (report.findings.length === 0) {
    console.log('\nNo findings.');
    return;
  }
  console.log(`\nFindings (${report.findings.length}):`);
  for (const f of report.findings) {
    console.log(`  [${f.severity}] ${f.message}`);
    console.log(`    ${f.suggestion}`);
  }
}

export function runDiff(args: string[]): void {
  const aPath = args[1];
  const bPath = args[2];
  if (!aPath || !bPath) {
    console.error('Usage: visualtone diff a.report.json b.report.json');
    process.exit(1);
  }
  const a = JSON.parse(readFileSync(aPath, 'utf8')) as AnalysisReport;
  const b = JSON.parse(readFileSync(bPath, 'utf8')) as AnalysisReport;
  const metrics: { name: string; a: number; b: number }[] = [
    { name: 'LUFS', a: a.loudness.integratedLufs, b: b.loudness.integratedLufs },
    { name: 'PLR', a: a.loudness.plr, b: b.loudness.plr },
    { name: 'true peak', a: a.loudness.truePeakDbtp, b: b.loudness.truePeakDbtp },
    { name: 'low balance dB', a: a.stereo.lowBalanceDb, b: b.stereo.lowBalanceDb },
    { name: 'contrast dB', a: a.structure.contrastDb, b: b.structure.contrastDb },
  ];
  for (const band of a.bands) {
    const other = b.bands.find((x) => x.name === band.name);
    if (other) metrics.push({ name: band.name, a: band.share, b: other.share });
  }
  console.log('metric            A          B        delta');
  for (const m of metrics) {
    const d = m.b - m.a;
    console.log(
      `${m.name.padEnd(16)} ${m.a.toFixed(3).padStart(10)} ${m.b.toFixed(3).padStart(10)} ${d.toFixed(3).padStart(10)}`,
    );
  }
  const { resolved, added } = diffFindings(a.findings ?? [], b.findings ?? []);
  console.log(`\nResolved (${resolved.length}):`);
  for (const f of resolved) console.log(`  ${f.id}: ${f.message}`);
  console.log(`Added (${added.length}):`);
  for (const f of added) console.log(`  ${f.id}: ${f.message}`);
}

export function runProfile(args: string[]): void {
  const outIdx = args.indexOf('-o') !== -1 ? args.indexOf('-o') : args.indexOf('--output');
  if (outIdx === -1 || !args[outIdx + 1]) {
    console.error('Usage: visualtone profile <ref.wav> [more.wav ...] -o profile.json');
    process.exit(1);
  }
  const files = args.slice(1, outIdx).filter((f) => !f.startsWith('-'));
  if (files.length === 0) {
    console.error('Give at least one WAV reference');
    process.exit(1);
  }
  const reports = files.map((file) => {
    const decoded = readWavFile(readFileSync(file));
    console.log(`Analyzing ${file}`);
    return analyze({ buffers: decoded.buffers, sampleRate: decoded.sampleRate }).report;
  });
  const name = flag('--name', args) ?? 'reference';
  const profile = profileFromReports(name, reports);
  writeFileSync(args[outIdx + 1], JSON.stringify(profile, null, 2));
  console.log(`Wrote ${args[outIdx + 1]}`);
}
