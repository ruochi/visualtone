#!/usr/bin/env python3
"""Score one menuet render on bars 1–4 and bars 5–8 separately.

Bars 1–4 are the only bars a fit may look at. Bars 5–8 are the check.
"""
import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np

from violin_metrics import harmonic_slopes, load_notes, mono, rms, slope_summary


def load_eval():
    path = Path(__file__).with_name('violin-eval.py')
    spec = importlib.util.spec_from_file_location('violin_eval', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--wav', required=True)
    parser.add_argument('--l0', default='/tmp/violin-solo/oracle/l0.wav')
    parser.add_argument('--extract', default='/tmp/violin-solo/oracle/extract.json')
    parser.add_argument('--score', default='examples/violin-minuet.json')
    args = parser.parse_args()

    ev = load_eval()
    extract = json.loads(Path(args.extract).read_text())
    phrase = float(extract['phraseSec'])
    sr, rec = mono(args.l0)
    n = int(round(phrase * sr))
    rec = rec[:n]
    _sr, cand = mono(args.wav)
    if _sr != sr:
        raise SystemExit(f'sample rate {_sr} != {sr}')
    gain = rms(rec) / max(rms(cand[:n]), 1e-8)
    cand = cand[:n] * gain
    notes = load_notes(json.loads(Path(args.score).read_text()))
    freqs, times, mag_r, mag_c, syn_t, rec_t = ev.pair_spectra(rec, cand, sr)
    rows = harmonic_slopes(notes, mag_c, mag_r, times, freqs, syn_t, rec_t)
    phrase_m = ev.phrase_report(rec, cand, sr, syn_t, rec_t)
    vib = ev.vibrato_report(rec, cand, sr, notes, syn_t, rec_t)
    report = {}
    for name, pred in (('bars1to4', lambda r: r.get('bar', 9) <= 4), ('bars5to8', lambda r: r.get('bar', 0) >= 5)):
        sub = [r for r in rows if pred(r)]
        report[name] = {
            'harmonic': slope_summary(sub),
            'byHz': ev.by_frequency(sub),
            'notes': len(sub),
        }
    report['phrase'] = phrase_m
    report['vibrato'] = vib
    train_notes = [n for n in notes if n.get('bar', 9) <= 4]
    report['vibratoBars1to4'] = ev.vibrato_report(rec, cand, sr, train_notes, syn_t, rec_t)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
