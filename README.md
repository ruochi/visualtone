# visualtone

Render music and sound effects from a JSON score. This is the lite engine: one runtime dependency (zod), no native modules. It sounds like a simple synth, not a studio. The format is the part that has to be right, because models, examples and later engines all write it.

```bash
npm install
npm run example        # writes out/funk.wav, 16 bars of electro-funk
```

Needs Node 22.

## Score

```json
{
  "version": 2,
  "seed": 7,
  "tempo": { "bpm": 112, "meter": "4/4", "swing": 0.12 },
  "key": "E minor",
  "duration": 34.286,
  "sections": [
    { "id": "intro", "at": 0 },
    { "id": "groove", "at": 8.571 }
  ],
  "tracks": [
    {
      "id": "drums",
      "instrument": "drums",
      "patterns": [{ "in": ["groove"], "steps": { "kick": "x...x...x...x...", "snare": "....X.......X..g" } }]
    },
    {
      "id": "keys",
      "instrument": "epiano",
      "chords": [{ "in": ["groove"], "progression": "Em7 A7 | Dmaj7 Bm7", "style": "stab", "rhythm": "..x...X...x..X.." }]
    },
    {
      "id": "bass",
      "instrument": "bass",
      "follow": "keys",
      "patterns": [{ "in": ["groove"], "notes": "1 - . 8 1 . b7 8 . . 5 - 1 . 2 4" }]
    }
  ],
  "mix": { "loudness": -16, "ceiling": -1 }
}
```

Only `tracks` is required, and it may be an empty list. A track with no notes, patterns, chords, sfx or clips is silence, so a score that a program has filtered down still renders. Same score and `seed` always give the same audio. `duration` is seconds; leave it out and the piece runs until the last event, plus a short release. A section runs until the next section's `at`, and the last section runs until `duration`.

Without `tempo`, every time is seconds. Without `key`, nothing is checked for being out of key. `key` is written `"E minor"` or `"C major"`, and also `"Em"`, `"F#m"` and `"Bb"` (a bare note name is major).

`examples/funk.json` is a full arrangement in this shape (about 100 lines, not thousands of notes).

## Time

Every start is `at`. Every length is `duration`. Both accept the same kinds of value:

| value | meaning |
| --- | --- |
| `3.25` | seconds |
| `"groove"` | the start of that section |
| `"groove@2:3"` | bar 2, beat 3 inside the section (1-based, as in a DAW) |
| `"5:1"` | bar 5, beat 1 from the start of the piece |
| `"1/8"`, `"1/4."`, `"2bar"` | a note length, a dotted length, or whole bars. A number is still seconds |

Hit points (a whoosh, an accent on a cut) should be seconds. Notes inside the music should be bars and beats. The two mix freely. `swing` delays every other 16th by that fraction of a 16th (`0.12` is a light shuffle, `0` is straight).

Patterns and chord rhythms restart at the beginning of each section they are `in`, and they are cut at the section end. A section can start at an arbitrary second (the picture decides); the bar count inside it starts over.

## Tracks

```json
{
  "id": "keys",
  "role": "music",
  "instrument": "epiano",
  "gain": 0,
  "pan": -0.2,
  "brightness": 0.5,
  "space": 0.3,
  "duck": "auto",
  "follow": "keys",
  "notes": [],
  "patterns": [],
  "chords": [],
  "sfx": [],
  "clips": []
}
```

`role` is `music`, `sfx` or `voice`. `gain` is dB on top of the instrument's own level, so `0` (or leaving it out) is already a usable balance. `pan` and `space` left out means the instrument's defaults; set them and they replace the default. `brightness` and `space` are the only tone controls, both 0–1 (dark to bright, dry to wet).

There is no `hue` or `lightness`. Unknown fields are an error, and the message names the field you probably meant (`t` → `at`, `size` on a note → `velocity`, `keys` → `epiano`). An unknown sound (`swoosh`, `ding`) or `duck: false` does the same (`whoosh`, `chime`, `"off"`). `duck: true` means `"auto"`.

### `notes`

```json
{ "at": "groove@1:1", "pitch": "B4", "duration": "1/8", "velocity": 0.8 }
```

`pitch` is required: a note name (`C4`, `F#3`, `Bb2`), a MIDI number, a drum name on a drum track (`kick`, `snare`, `hat`, …), or a chord degree when the track follows a chord. `velocity` is 0–1, default 0.8. Leaving `duration` out means a quarter note, or 0.25 seconds when there is no tempo.

### `patterns`

A pattern is a loop. Each section in `in` starts it again. `in` can also be `{ "from": "groove", "to": "outro@2:1" }` for one span. Leave `in` out and it plays across the whole piece.

Drums, one character per grid step (`grid` defaults to `"1/16"`):

```json
{ "in": ["groove"], "steps": { "kick": "x...x...x...x...", "snare": "....X.......X..g", "hat": "x.x.x.x.x.x.x.x." } }
```

`x` is normal, `X` is an accent, `g` is a ghost, `.` is a rest. Spaces and `|` are ignored, so you can mark bars. A row of `x` is not one flat velocity: drum steps get the same metrical accent as a pitched loop, so a downbeat is a little louder than an offbeat. `X` and `g` sit above and below that.

Pitched instruments use tokens separated by spaces. `-` holds the previous note:

```json
{ "in": ["groove"], "notes": "1 . . 8 | . 5 - b7 | 1 . . 1 | 3 . 5 ." }
```

On a track with `follow` (or its own `chords`), `1 3 5 7 8` are the chord's root, third, fifth, seventh and octave root. `b7` and `#4` are chromatic shifts from the major scale, so they do not move when the chord quality changes. Without a chord to follow, tokens are note names (`C4`, `E3`). The loop has no accent marks of its own, so downbeats are played a little louder than offbeats.

### `chords`

```json
{
  "in": ["intro", "groove"],
  "progression": "Em7 A7 | Dmaj7 Bm7",
  "per": "1bar",
  "style": "stab",
  "rhythm": "..x...X...x..X..",
  "register": "C4",
  "voicing": "close"
}
```

`|` is only a barline for reading. Each symbol lasts `per` (default `"1bar"`) and the line loops. The engine voices the chord around `register` and moves each voice to the nearest note of the next chord. `voicing` is `close`, `open` or `spread`. `C/E` puts E in the bass. `C6/9` and `Dmaj13#11` are extended chords: the text after `/` is a bass note only when it is a note name.

`style`:

| style | what you hear |
| --- | --- |
| `pad` | held, soft |
| `block` | the whole chord, released just before the next one |
| `stab` | short hits. `rhythm` uses the same `x X g .` marks; without it, one hit per chord |
| `strum` | the notes a few milliseconds apart, low to high |
| `arp-up`, `arp-down`, `arp-updown` | one chord tone per step |

Another track sets `"follow": "keys"` and its degrees are read against whatever chord that track is playing.

### `sfx`

```json
{ "type": "whoosh", "at": 8.4, "duration": 0.7, "size": 0.6, "pan": -0.3, "direction": "in" }
```

`at` may be a list (`"at": [1.2, 1.45, 1.7]`). Repeated hits of one type get a small pitch and brightness change from `seed`. `size` is 0–1, default 0.6. `direction` (`in` or `out`) is only for `whoosh`.

`at` is not always the start of the sound:

| type | `at` is | use |
| --- | --- | --- |
| `whoosh` | the loudest point | a transition, something flying past |
| `riser` | the end, when it arrives. `duration` is the build | into a drop or a reveal |
| `downlifter` | the start | falling away after a hit |
| `swell` | the loudest point | into a new section |
| `impact`, `boom`, `hit`, `pop`, `click`, `tick`, `type`, `shimmer`, `chime` | the attack | hits, UI, a chime |
| `glitch` | the start. `duration` is the length | a digital break |

### `clips`

```json
{ "src": "voice/intro.wav", "at": 0, "offset": 0, "duration": 4.2, "loop": false, "gain": 0, "fadeIn": 0, "fadeOut": 0.3 }
```

`gain` is dB, same as a track. Paths are relative to the score file. From code, pass the samples and nothing is read from disk. A `src` that is neither in memory nor on disk names that `src` in the error:

```ts
render(score, { clips: { 'voice/intro.wav': { sampleRate, channels } } })
```

## Instruments

Names stay put when the synth changes. Each one has a range (the report flags notes outside it), a default level, a default pan and a default amount of reverb. A score that only names instruments is already balanced.

| group | names |
| --- | --- |
| drums | `drums` — `kick` `snare` `clap` `rim` `hat` `openhat` `tom-low` `tom-mid` `tom-high` `crash` `ride` `shaker`. GM numbers work too |
| bass | `bass` `sub` `synth-bass` |
| harmony | `piano` `epiano` `organ` `pad` `strings` |
| melody | `pluck` `lead` `bell` `marimba` |

## Mix

`mix.loudness` (default -16 LUFS, K-weighted, channels summed) and `mix.ceiling` (default -1 dBFS, peak limiter) are the only mix fields.

When a track has `role: "voice"`, every `music` track ducks under it (`duck: "auto"`). `duck: "off"` keeps a track up. `duck: { "by": "drums", "amount": 0.4, "release": 0.12 }` follows one track, which is how a bass can sit under a kick. Harmonic instruments also lose a little of the 2–3 kHz band, and that dip follows the same envelope: it is open while the voice is up and closes when the voice stops.

A kick pump, or yielding around an impact, is not a score field. `processTrack` runs after gain and pan and before the duck, and it can scale the buffer at those times.

`space` is a send to one reverb. There is no per-track delay and no EQ in the score.

## Report

`render` returns `report.issues`. The piece still plays; the issues say what to fix:

| code | meaning |
| --- | --- |
| `out-of-key` | notes outside the key. Minor keys allow both 6ths and both 7ths, so a dominant and a major IV are not flagged |
| `out-of-range` | outside that instrument's range |
| `flat-velocity` | hand-written notes all at one velocity. Drum and pitched patterns take a metrical accent, so a row of `x` is not flagged |
| `dense-sfx` | two short effects, or the same effect twice, stacked on top of each other |
| `sfx-clipped` | the sound starts before 0, because `at` is the peak or the end |
| `voice-masked` | while the voice is speaking, the music is much louder around 2.5 kHz |
| `deep-limiting` | the limiter took more than 8 dB off the peaks |

`validate` prints the issues that can be seen without rendering. `out-of-key`, range, flat velocity, crowded and clipped effects are in that list. Masking and limiting show up after `render`.

## Signal chain

notes / sfx / clips → high-pass (where the instrument has one), gain, pan → `processTrack` → duck, with the vocal dip following that envelope → sum, plus the `space` send to the reverb → `processMaster` → DC block → K-weighted loudness match → lookahead limiter → 16-bit stereo WAV.

## Use from code

```ts
import { parseScore, render, renderToWav } from 'visualtone'

const wav = renderToWav(scoreObject)
const { left, right, report, envelopes } = render(parseScore(scoreObject), { envelopes: true })
```

`envelopes: true` returns one level per track, including tracks that are silent, the same length as `left`. The level is linear amplitude after ducking and after the loudness-match gain. It is not peak-normalized, so a track reads lower while it yields. Onset times come from `compile()`.

`render` takes `instruments`, a function from a track to `{ renderNote(note, midi, ctx) }`. Return nothing to keep the lite synth. `processTrack` and `processMaster` see the buffers and may edit them in place. This is how a better engine plugs in without a different score.

## CLI

```bash
npx visualtone render score.json out.wav
npx visualtone validate score.json
```

## License

MIT
