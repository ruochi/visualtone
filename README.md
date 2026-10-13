# visualtone

Render music and sound effects from a JSON score. This is the lite version: about 900 lines of TypeScript, one runtime dependency (zod), no native modules. It sounds like a simple synth, not a studio. The point is a clear format and an engine you can read and run right away.

```bash
npm install
npm run example        # writes out/funk.wav, 36 s of electro-funk
```

Needs Node 22 (`nvm use`).

## Score

```json
{
  "version": 1,
  "tracks": [
    { "id": "drums", "instrument": "drums", "notes": [{ "t": 0, "pitch": 36 }, { "t": 0.5, "pitch": 38 }] },
    { "id": "bass", "instrument": "bass", "notes": [{ "t": 0, "pitch": "E1", "duration": 0.4, "size": 0.9 }],
      "duck": { "by": "drums", "amount": 0.3 } },
    { "id": "vo", "role": "voice", "clips": [{ "src": "voice.wav", "at": 1 }] },
    { "id": "fx", "role": "sfx", "sfx": [{ "sfx": "impact", "t": 2 }] }
  ],
  "master": { "loudness": -16, "ceiling": -1 }
}
```

Times are in seconds. A track holds any mix of:

- `notes`: `t`, `pitch` (MIDI number or name like `C4`, `F#3`), `size` (velocity 0–1), `duration`.
- `sfx`: `whoosh`, `riser`, `impact`, `pop`, `tick`, with `t`, `size`, optional `duration`.
- `clips`: a WAV file (16/24/32-bit PCM or float) with `at`, `gain` (dB), `fadeIn`, `fadeOut`. Paths are relative to the score file.

Track settings: `instrument`, `hue`, `lightness`, `gain` (dB), `pan`, `lowCut`/`highCut` (Hz), `reverb`/`delay` sends (0–1), `duck: { by, amount, release }`, `role` (`music`, `sfx`, `voice`).

Master: `loudness` (gated RMS target, dBFS, close to LUFS for music), `ceiling` (peak limiter, dBFS), `reverb: { size, damping }`, `delay: { time, feedback }`.

The full schema is in [src/schema.ts](src/schema.ts). Same score and `seed` always give the same audio.

## Instruments

| name | sound |
|---|---|
| `lead` | two detuned saws, filter envelope |
| `bass` | saw + square, snappy filter |
| `sub` | sine/triangle sub bass |
| `pluck` | short filtered pluck |
| `pad` | slow detuned saws |
| `keys` | soft triangle keys |
| `drums` | GM numbers: 36 kick, 38 snare, 39 clap, 42 closed hat, 46 open hat, 45/47/50 toms |

`hue` (0–360) swaps the oscillator pair: 0 sine, 90 triangle, 180 square, 270 saw. `lightness` (0–1, default 0.5) moves the filter cutoff.

## Signal chain

notes / sfx / clips → track high/low cut, gain, pan → duck → sum + reverb and delay sends → DC block → loudness match → lookahead limiter → 16-bit stereo WAV.

## Use from code

```ts
import { parseScore, render, renderToWav } from 'visualtone'

const wav = renderToWav(scoreObject)                 // Buffer
const { left, right, report } = render(parseScore(scoreObject))
```

`render` takes `{ instruments }`, a function from track to an `Instrument` with `renderNote(note, midi, ctx)`. Return `undefined` to keep the lite synth. This is how a better engine plugs in without changing the format.

## CLI

```bash
npx visualtone render score.json out.wav
npx visualtone validate score.json
```

## License

MIT
