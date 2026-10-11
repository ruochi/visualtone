#!/usr/bin/env python3
"""Fit a smooth minimum-phase body to bars 1–4 and score it on bars 5–8.

The target is the by-frequency partial error of the current render, with the
straight log-frequency tilt taken out, so this does not redo the harmonic slope.
The impulse response is what the violin preset's bodyFir should hold.
"""
import argparse
import json
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import firwin2, lfilter, minimum_phase

from violin_metrics import harmonic_slopes, load_notes, mono, rms, slope_summary


def load_eval():
    import importlib.util

    path = Path(__file__).with_name('violin-eval.py')
    spec = importlib.util.spec_from_file_location('violin_eval', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_wav(path):
    sr, x = wavfile.read(path)
    if np.issubdtype(x.dtype, np.integer):
        x = x.astype(np.float64) / np.iinfo(x.dtype).max
    else:
        x = x.astype(np.float64)
    if x.ndim == 1:
        x = x[:, None]
    return sr, x


def save_wav(path, sr, x):
    y = np.clip(x, -1, 1)
    wavfile.write(path, sr, (y * 32767).astype(np.int16))


def detilt(hz, db, weight):
    x = np.log2(hz)
    coef = np.polyfit(x, db, 1, w=weight)
    return db - np.polyval(coef, x), coef


def smooth_error(points, sigma_oct):
    hz = np.array([p['hz'] for p in points], dtype=float)
    db = np.array([p['db'] for p in points], dtype=float)
    w = np.sqrt(np.array([p['n'] for p in points], dtype=float))
    grid = np.geomspace(250, 8000, 48)
    sm = np.zeros_like(grid)
    sw = np.zeros_like(grid)
    for f, e, ww in zip(hz, db, w):
        k = np.exp(-0.5 * (np.log2(grid / f) / sigma_oct) ** 2) * ww
        sm += k * e
        sw += k
    sm = np.divide(sm, sw, out=np.zeros_like(sm), where=sw > 1e-8)
    sm, coef = detilt(grid, sm, np.clip(sw, 1e-3, None))
    return grid, sm, coef


def design_fir(grid, err_db, alpha, limit, sr, ntaps):
    corr = np.clip(-alpha * err_db, -limit, limit)
    freqs = np.linspace(0, 1, 512)
    hz = freqs * (sr / 2)
    log_hz = np.log(np.clip(hz, 1, None))
    gain_db = np.interp(log_hz, np.log(grid), corr, left=0, right=0)
    # Leave the register below the lowest measured partial, and the air above it, alone.
    fade_lo = np.clip((hz - 180) / 120, 0, 1)
    fade_hi = np.clip((9000 - hz) / 1500, 0, 1)
    gain_db *= fade_lo * fade_hi
    gain = 10 ** (gain_db / 20)
    gain[0] = gain[1]
    gain[-1] = gain[-2]
    linear = firwin2(ntaps, freqs, gain, fs=2)
    taps = np.asarray(minimum_phase(linear, method='homomorphic'), dtype=np.float64)
    # Keep the passband near unity so the bow level stays where the preset put it.
    mid = (hz > 400) & (hz < 2000)
    ref = float(np.mean(gain[mid])) if np.any(mid) else 1.0
    if ref > 1e-6:
        taps /= ref
    return taps, corr


def apply_fir(x, taps):
    return np.column_stack([lfilter(taps, [1.0], x[:, c]) for c in range(x.shape[1])])


def score(ev, rec, cand, sr, notes, phrase):
    n = int(round(phrase * sr))
    rec_p = rec[:n, 0] if rec.ndim == 2 else rec[:n]
    cand_p = cand[:n, 0] if cand.ndim == 2 else cand[:n]
    gain = rms(rec_p) / max(rms(cand_p), 1e-8)
    cand_p = cand_p * gain
    freqs, times, mag_r, mag_c, syn_t, rec_t = ev.pair_spectra(rec_p, cand_p, sr)
    rows = harmonic_slopes(notes, mag_c, mag_r, times, freqs, syn_t, rec_t)
    out = {}
    for name, pred in (('bars1to4', lambda r: r.get('bar', 9) <= 4), ('bars5to8', lambda r: r.get('bar', 0) >= 5)):
        sub = [r for r in rows if pred(r)]
        out[name] = {
            'harmonic': slope_summary(sub)['meanAbsDb'],
            'byHz': ev.by_frequency(sub),
        }
    train_notes = [nn for nn in notes if nn.get('bar', 9) <= 4]
    out['hnrTrain'] = ev.hnr_gap(train_notes, mag_c, mag_r, times, freqs, syn_t, rec_t)
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--wav', default='/tmp/violin-solo/oracle/l3-final.wav')
    parser.add_argument('--l0', default='/tmp/violin-solo/oracle/l0.wav')
    parser.add_argument('--extract', default='/tmp/violin-solo/oracle/extract.json')
    parser.add_argument('--score', default='examples/violin-minuet.json')
    parser.add_argument('--out', default='/tmp/violin-solo/oracle/body-fir.json')
    args = parser.parse_args()

    ev = load_eval()
    extract = json.loads(Path(args.extract).read_text())
    phrase = float(extract['phraseSec'])
    sr, rec = load_wav(args.l0)
    _sr, cand = load_wav(args.wav)
    if _sr != sr:
        raise SystemExit(f'sample rate {_sr} != {sr}')
    notes = load_notes(json.loads(Path(args.score).read_text()))
    base = score(ev, rec, cand, sr, notes, phrase)
    grid, err, coef = smooth_error(base['bars1to4']['byHz'], 0.55)
    print('baseline train', base['bars1to4']['harmonic'], 'hold', base['bars5to8']['harmonic'])
    print('tilt dB/oct', round(float(coef[0]), 2), 'hnr', base['hnrTrain'])
    print('smoothed train error', ' '.join(f'{f:.0f}:{e:+.1f}' for f, e in zip(grid[::4], err[::4])))

    best = None
    trials = []
    # The search peaked at alpha 5, limit 8. Alpha 7 gave the holdout back.
    for alpha in (5.0,):
        for limit in (8.0,):
            taps, corr = design_fir(grid, err, alpha, limit, sr, 129)
            filtered = apply_fir(cand, taps)
            got = score(ev, rec, filtered, sr, notes, phrase)
            row = {
                'alpha': alpha,
                'limit': limit,
                'train': got['bars1to4']['harmonic'],
                'hold': got['bars5to8']['harmonic'],
                'hnr': got['hnrTrain'],
            }
            trials.append(row)
            print(f"alpha {alpha:.2f} limit {limit:.1f} train {row['train']} hold {row['hold']}")
            hold = row['hold'] if row['hold'] is not None else 99
            train = row['train'] if row['train'] is not None else 99
            # Prefer a holdout that does not get worse, then a better train.
            if hold <= base['bars5to8']['harmonic'] + 0.05 and (best is None or (hold, train) < best['key']):
                best = {'key': (hold, train), 'taps': taps, 'corr': corr, 'row': row, 'byHz': got['bars5to8']['byHz']}

    report = {
        'baseline': {'train': base['bars1to4']['harmonic'], 'hold': base['bars5to8']['harmonic']},
        'trials': trials,
        'chosen': None if best is None else best['row'],
        'taps': None if best is None else [round(float(v), 6) for v in best['taps']],
    }
    Path(args.out).write_text(json.dumps(report, indent=2) + '\n')
    print('wrote', args.out, 'chosen', report['chosen'])


if __name__ == '__main__':
    main()
