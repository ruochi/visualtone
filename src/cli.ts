#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { ScoreSchema, getJsonSchema } from './schema.js';
import { render } from './renderer.js';

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
visualtone - Music as animated colored curves

Usage:
  visualtone render <score.json> -o <output.wav>
  visualtone schema

Commands:
  render    Render a score JSON file to WAV audio
  schema    Print the JSON Schema for score files

Options:
  -o, --output    Output WAV file path (for render command)
  -h, --help      Show this help message
`);
  process.exit(0);
}

const command = args[0];

if (command === 'schema') {
  const schema = getJsonSchema();
  console.log(JSON.stringify(schema, null, 2));
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
    
    const result = render(score);
    
    console.log(`\nRendered ${result.duration.toFixed(2)}s of audio`);
    console.log('\nTrack report:');
    
    for (const event of result.eventReport) {
      console.log(`  ${event.trackId} (ch ${event.channel}):`);
      console.log(`    Samples: ${event.samplesRendered}`);
      console.log(`    Peak: ${event.peakGain.toFixed(4)}`);
      console.log(`    RMS: ${event.rmsGain.toFixed(4)}`);
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
