#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { ScoreSchema } from './schema.js';
import { getJsonSchema } from './json-schema.js';
import { render } from './renderer.js';
import type { BitDepth } from './wav.js';
import { runAnalyze, runDiff, runProfile } from './cli-listen.js';

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
visualtone - Music as animated colored curves

Usage:
  visualtone render <score.json> -o <output.wav>
  visualtone analyze <score.json|mix.wav> [--profile deep-house] [--json report.json] [--png report.png] [--panel name]
  visualtone diff a.report.json b.report.json
  visualtone profile <ref.wav> [more.wav ...] -o profile.json
  visualtone schema

Commands:
  render     Render a score JSON file to WAV audio
  analyze    Measure a score or WAV and write a listening report
  diff       Compare two analysis reports
  profile    Build a target profile from reference WAVs
  schema     Print the JSON Schema for score files

Options:
  -o, --output       Output WAV file path (for render command)
  -b, --bit-depth    16 (default, TPDF dithered) | 24 | 32f (float)
      --no-dither    Disable dither for 16/24-bit output
  -h, --help         Show this help message
`);
  process.exit(0);
}

const command = args[0];

if (command === 'schema') {
  const schema = getJsonSchema();
  console.log(JSON.stringify(schema, null, 2));
  process.exit(0);
}

if (command === 'analyze') {
  runAnalyze(args);
  process.exit(0);
}

if (command === 'diff') {
  runDiff(args);
  process.exit(0);
}

if (command === 'profile') {
  runProfile(args);
  process.exit(0);
}

if (command === 'render') {
  const scorePath = args[1];
  
  if (!scorePath) {
    console.error('Error: No score file specified');
    process.exit(1);
  }
  
  const outputIndex = args.indexOf('-o') !== -1 ? args.indexOf('-o') : args.indexOf('--output');
  
  if (outputIndex === -1 || !args[outputIndex + 1]) {
    console.error('Error: No output file specified. Use -o or --output');
    process.exit(1);
  }
  
  const outputPath = args[outputIndex + 1];

  const depthIndex = args.indexOf('-b') !== -1 ? args.indexOf('-b') : args.indexOf('--bit-depth');
  const depthArg = depthIndex !== -1 ? args[depthIndex + 1] : '16';
  const depthMap: Record<string, BitDepth> = { '16': 16, '24': 24, '32': 32, '32f': 32 };
  const bitDepth = depthMap[depthArg ?? ''];
  if (!bitDepth) {
    console.error(`Error: --bit-depth must be 16, 24 or 32f (got "${depthArg}")`);
    process.exit(1);
  }
  const dither = !args.includes('--no-dither');

  try {
    const scoreJson = readFileSync(scorePath, 'utf-8');
    const scoreData = JSON.parse(scoreJson);
    
    const parseResult = ScoreSchema.safeParse(scoreData);
    
    if (!parseResult.success) {
      console.error('Error: Invalid score format');
      console.error(parseResult.error.format());
      process.exit(1);
    }
    
    const score = parseResult.data;
    
    console.log('Rendering score...');
    console.log(`  Sample rate: ${score.sampleRate} Hz`);
    console.log(`  Tracks: ${score.tracks.length}`);
    console.log(`  Format: ${bitDepth === 32 ? '32-bit float' : `${bitDepth}-bit PCM${dither ? ' + TPDF dither' : ''}`}`);

    const result = render(score, { wav: { bitDepth, dither } });
    
    console.log(`\nRendered ${result.duration.toFixed(2)}s of audio`);
    console.log('\nTrack report:');
    
    for (const event of result.eventReport) {
      console.log(`  ${event.trackId} (ch ${event.channels.join(',')}):`);
      console.log(`    Samples: ${event.samplesRendered}`);
      console.log(`    Peak: ${event.peakGain.toFixed(4)}`);
      console.log(`    RMS: ${event.rmsGain.toFixed(4)}`);
      console.log(`    Centroid: ${event.spectralCentroid.toFixed(0)} Hz`);
      console.log(`    Onsets: ${event.onsets}`);
      if (event.gainReductionDb > 0) console.log(`    Comp GR: -${event.gainReductionDb.toFixed(1)} dB max`);
    }
    console.log(`\nMaster peak: ${result.master.peak.toFixed(4)}, loudness ~${result.master.loudnessDb.toFixed(1)} dBFS`);
    if (result.master.gainReductionDb > 0) {
      console.log(`Master glue comp: -${result.master.gainReductionDb.toFixed(1)} dB max`);
    }
    
    writeFileSync(outputPath, result.wav);
    console.log(`\nWrote ${outputPath}`);
    
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  
  process.exit(0);
}

console.error(`Unknown command: ${command}`);
console.error('Run "visualtone --help" for usage');
process.exit(1);
