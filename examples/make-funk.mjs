// Writes examples/funk.json: 16 bars of electro-funk at 112 BPM in E minor.
// The score is the arrangement. Patterns and a chord progression replace the
// old list of several thousand notes.
// Usage: node examples/make-funk.mjs
import { writeFileSync } from 'node:fs';

const bpm = 112;
const bar = (60 / bpm) * 4;

const score = {
  version: 2,
  seed: 7,
  tempo: { bpm, meter: '4/4', swing: 0.12 },
  key: 'E minor',
  duration: 16 * bar,
  sections: [
    { id: 'intro', at: 0 },
    { id: 'groove', at: 4 * bar },
    { id: 'break', at: 12 * bar },
  ],
  tracks: [
    {
      id: 'drums',
      instrument: 'drums',
      patterns: [
        { in: ['intro'], steps: { kick: 'x...x...x...x...', hat: 'x.g.x.g.x.g.x.g.' } },
        {
          in: ['groove'],
          steps: {
            kick: 'x...x...x..x....',
            snare: '....X.......X..g',
            clap: '....x.......x...',
            hat: 'xgxgxgxgxgxgxgxg',
          },
        },
        {
          in: ['break'],
          steps: { kick: 'x...x...x...x...', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.' },
        },
        // One-beat tom fills, restarting would loop but the region is only one beat long.
        { in: { from: 'intro@4:4', to: 'groove' }, steps: { 'tom-high': 'x...', 'tom-mid': '.x..', 'tom-low': '..xX' } },
        { in: { from: 'groove@8:4', to: 'break' }, steps: { 'tom-high': 'x...', 'tom-mid': '.x..', 'tom-low': '..xX' } },
      ],
    },
    {
      id: 'keys',
      instrument: 'epiano',
      // The intro keeps the chords (the bass follows them) without playing stabs.
      chords: [
        { in: ['intro'], progression: 'Em7 A7 | Dmaj7 Bm7', per: '1bar', style: 'stab', rhythm: '................' },
        {
          in: ['groove', 'break'],
          progression: 'Em7 A7 | Dmaj7 Bm7',
          per: '1bar',
          style: 'stab',
          rhythm: '..x...X...x..X..',
          register: 'C4',
        },
      ],
    },
    {
      id: 'bass',
      instrument: 'bass',
      follow: 'keys',
      patterns: [{
        in: { from: 'intro@3:1', to: '17:1' },
        notes: '1 - . 8 1 . b7 8 . . 5 - 1 . 2 4',
      }],
    },
    {
      id: 'lead',
      instrument: 'lead',
      follow: 'keys',
      patterns: [{ in: ['groove'], grid: '1/8', notes: '1 . 5 8 | 5 b7 5 1 | 8 5 1 . | 5 . b7 5' }],
    },
    {
      id: 'fx',
      role: 'sfx',
      sfx: [
        { type: 'riser', at: 'groove', duration: '2bar', size: 0.45 },
        { type: 'impact', at: 'groove', size: 0.55 },
        { type: 'whoosh', at: 'groove@8:3', duration: '1/2', size: 0.5, direction: 'in' },
        { type: 'impact', at: 'break', size: 0.5 },
      ],
    },
  ],
  mix: { loudness: -16, ceiling: -1 },
};

writeFileSync(new URL('./funk.json', import.meta.url), JSON.stringify(score, null, 2) + '\n');
const tracks = score.tracks.map((t) => t.id).join(', ');
console.log(`examples/funk.json: ${tracks}`);
