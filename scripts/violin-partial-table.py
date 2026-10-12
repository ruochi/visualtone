#!/usr/bin/env python3
"""Per-pitch harmonic levels from menuet bars 1–4 of the recording.

The wav is only a clock. Its notes pull the recording into line; the levels
written out are the recording's, never the wav's. Bars 5–8 and the gavotte
are not used.

  node scripts/violin-score-render.mjs examples/violin-minuet.json /tmp/violin-score align 1006
  PYTHONPATH=scripts python3 scripts/violin-partial-table.py /tmp/violin-score/align-1006.wav

Prints the table and the harmonic error of predicting later bars from it.
The violin preset does not load this table: on the holdout it matched the
menuet's harmonics and lost the gavotte. The numbers are kept in
references/violin-partial-table.json.
"""
import importlib.util
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

from violin_metrics import harmonic_slopes, load_notes, midi_hz, mono, rms

ROOT = Path(__file__).resolve().parent.parent
N_HARM = 10
SLOPE_CAP = 1.5  # dB per semitone, outside the measured range


def load_eval():
    path = Path(__file__).with_name('violin-eval.py')
    spec = importlib.util.spec_from_file_location('violin_eval', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def rows_of(wav, score, offset):
    ev = load_eval()
    notes = load_notes(json.loads(Path(score).read_text()))
    sr, rec = mono('/tmp/violin-solo/minuet.wav')
    rec = rec[int(round(offset * sr)):]
    _sr, cand = mono(wav)
    n = int(round(max(x['t'] + x['dur'] for x in notes) * sr))
    rec, cand = rec[:n], cand[:n]
    if len(cand) < n:
        cand = np.pad(cand, (0, n - len(cand)))
    cand = cand * (rms(rec) / max(rms(cand), 1e-8))
    freqs, times, mag_r, mag_c, syn_t, rec_t = ev.pair_spectra(rec, cand, sr)
    return harmonic_slopes(notes, mag_c, mag_r, times, freqs, syn_t, rec_t)


def tail_step(values, idx):
    """dB per harmonic from the measured points. Unknown tops must keep falling."""
    if len(idx) < 2:
        return -3.0
    steps = np.diff(values) / np.diff(idx)
    step = float(np.median(steps))
    return min(-0.5, max(-8.0, step))


def fill(med, fallback):
    x = np.array(med, dtype=float)
    good = np.isfinite(x)
    idx = np.arange(len(x))
    fb = np.array(fallback, dtype=float)
    if int(good.sum()) >= 2:
        first = int(idx[good][0])
        last = int(idx[good][-1])
        interior = ~good & (idx > first) & (idx < last)
        x[interior] = np.interp(idx[interior], idx[good], x[good])
        step = tail_step(x[good], idx[good])
        for i in range(last + 1, len(x)):
            x[i] = x[i - 1] + step
        for i in range(first):
            x[i] = fb[i]
    elif int(good.sum()) == 1:
        x[:] = x[good][0]
    else:
        x = fb.copy()
    still = ~np.isfinite(x)
    x[still] = fb[still]
    x -= np.nanmax(x)
    return x


def fit_table(rows):
    """Median recording partials per MIDI, bars 1–4 only."""
    used = [r for r in rows if r.get('bar', 99) <= 4]
    if any(r.get('bar', 0) > 4 for r in used):
        raise SystemExit('fit leaked past bar 4')
    stack = np.vstack([r['rec'] for r in used])
    fallback = np.nanmedian(stack, axis=0)
    if not np.all(np.isfinite(fallback)):
        # Last resort: interpolate the global curve too.
        fallback = fill(fallback, np.zeros(N_HARM))
    by_midi = defaultdict(list)
    for r in used:
        by_midi[int(r['midi'])].append(r['rec'])
    table = []
    for midi in sorted(by_midi):
        med = np.nanmedian(np.vstack(by_midi[midi]), axis=0)
        row = fill(med, fallback)
        row = np.round(row, 2)
        row -= row.max()
        row = np.round(row, 2)
        table.append((midi, row, len(by_midi[midi])))
    return table, len(used)


def lookup(table, midi):
    """Same rule as the engine: exact, linear dB between, capped trend outside."""
    midis = np.array([m for m, _row, _n in table], dtype=float)
    db = np.vstack([row for _m, row, _n in table])
    n, h = db.shape
    mean_m = float(midis.mean())
    slope = np.zeros(h)
    if n >= 2:
        for k in range(h):
            dm = midis - mean_m
            den = float(np.dot(dm, dm))
            s = float(np.dot(dm, db[:, k] - db[:, k].mean()) / den) if den > 1e-9 else 0.0
            slope[k] = min(SLOPE_CAP, max(-SLOPE_CAP, s))
    if midi <= midis[0]:
        out = db[0] + slope * (midi - midis[0])
    elif midi >= midis[-1]:
        out = db[-1] + slope * (midi - midis[-1])
    else:
        i = int(np.searchsorted(midis, midi, side='right') - 1)
        if midis[i] == midi:
            return db[i].copy()
        span = midis[i + 1] - midis[i]
        u = 0.0 if span == 0 else (midi - midis[i]) / span
        out = db[i] * (1 - u) + db[i + 1] * u
    out = out - np.max(out)
    return out


def harmonic_db(rows, predict):
    """Median |predicted − recording| per partial, then the mean. Same as the scorecard."""
    acc = []
    note_err = []
    for h in range(N_HARM):
        vals = []
        for r in rows:
            if not r['both'][h]:
                continue
            pred = predict(r['midi'])
            vals.append(pred[h] - r['rec'][h])
        if len(vals) >= 3:
            acc.append(abs(float(np.median(vals))))
    for r in rows:
        pred = predict(r['midi'])
        d = np.abs(pred[r['both']] - r['rec'][r['both']])
        if len(d):
            note_err.append(float(np.mean(d)))
    harm = float(np.mean(acc)) if acc else None
    worst = float(np.percentile(note_err, 90)) if note_err else None
    return harm, worst, len(rows)


def main():
    wav = sys.argv[1] if len(sys.argv) > 1 else '/tmp/violin-score/align-1006.wav'
    rows = rows_of(wav, ROOT / 'examples/violin-minuet.json', 13.3)
    table, n_fit = fit_table(rows)
    predict = lambda midi: lookup(table, midi)  # noqa: E731
    fit_rows = [r for r in rows if r.get('bar', 99) <= 4]
    check_rows = [r for r in rows if 5 <= r.get('bar', 0) <= 8]
    fit_h, fit_w, fit_n = harmonic_db(fit_rows, predict)
    chk_h, chk_w, chk_n = harmonic_db(check_rows, predict)
    anchor_h, anchor_w = 3.78, 13.838
    pts = lambda err, anchor: None if err is None else round(100 * max(0, 1 - err / anchor), 1)
    print(f'fit notes {n_fit}  scored fit {fit_n} check {chk_n}')
    print(f'fit  harmonic {fit_h:.2f} dB ({pts(fit_h, anchor_h)} pts)  worst {fit_w:.2f} dB')
    print(f'check harmonic {chk_h:.2f} dB ({pts(chk_h, anchor_h)} pts)  worst {chk_w:.2f} dB ({pts(chk_w, anchor_w)} pts)')
    print('midi  n   ' + ' '.join(f'h{h+1:>5}' for h in range(N_HARM)))
    out = []
    for midi, row, n in table:
        print(f'{midi:4d} {n:2d}  ' + ' '.join(f'{v:6.2f}' for v in row))
        out.append({'midi': midi, 'db': [float(v) for v in row]})
    # Slopes used past the top measured pitch, so A5/B5 are visible.
    for midi in (81, 83):
        row = lookup(table, midi)
        print(f'{midi:4d} trend ' + ' '.join(f'{v:6.2f}' for v in row))
    dest = Path('/tmp/violin-score/partial-table.json')
    dest.write_text(json.dumps(out, indent=2) + '\n')
    print('wrote', dest)


if __name__ == '__main__':
    main()
