#!/usr/bin/env python3
"""Build L1 (partials plus the residual noise) and the L2 control score.

L1 is additive synthesis of the extracted partials, with noise colored by the
residual spectrum. L2 is a score whose pitch and loudness are those curves,
played by the current violin with its own vibrato turned off.
"""
import argparse
import json
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import fftconvolve

from violin_metrics import mono, stft_mag

NFFT = 4096


def write_wav(path, sr, x):
    y = np.clip(x, -1, 1)
    stereo = np.column_stack([y, y]).astype(np.float32)
    wavfile.write(path, sr, stereo)
    print('wrote', path)


def unit_sine_peak(sr, hop):
    t = np.arange(sr) / sr
    x = np.sin(2 * np.pi * 440 * t)
    freqs, _times, mag = stft_mag(x, sr, NFFT, hop)
    i = int(np.argmin(np.abs(freqs - 440)))
    return float(np.median(mag[i, 8:-8]))


def voice_signal(frames, times, sr, n, n_partial, scale):
    y = np.zeros(n)
    phases = np.zeros(n_partial)
    for i in range(len(times) - 1):
        a = frames[i]
        b = frames[i + 1]
        i0 = int(round(times[i] * sr))
        i1 = int(round(times[i + 1] * sr))
        i0 = max(0, min(n, i0))
        i1 = max(i0, min(n, i1))
        if i1 <= i0 or a is None:
            if a is not None:
                phases[:] = 0
            continue
        count = i1 - i0
        ramp = np.linspace(0, 1, count, endpoint=False)
        f0_a = a['f0']
        f0_b = b['f0'] if b is not None else f0_a
        f0 = f0_a + (f0_b - f0_a) * ramp
        step = 2 * np.pi * f0 / sr
        for h in range(n_partial):
            pa = a['partials'][h]
            if pa is None or not (a['clear'] & (1 << h)):
                phases[h] = 0
                continue
            pb = pa if b is None or b['partials'][h] is None else b['partials'][h]
            amp = (pa + (pb - pa) * ramp) * scale
            ph = phases[h] + np.cumsum(step * (h + 1))
            y[i0:i1] += np.sin(ph) * amp
            phases[h] = float(ph[-1] % (2 * np.pi))
    return y


def colored_noise(sr, n, hz, mag, seed):
    rng = np.random.default_rng(seed)
    white = rng.standard_normal(n)
    freqs = np.fft.rfftfreq(NFFT, 1 / sr)
    spec = np.interp(freqs, hz, mag, left=0.0, right=0.0)
    ker = np.fft.irfft(spec, n=NFFT)
    ker = np.roll(ker, NFFT // 2)
    ker *= np.hanning(NFFT)
    ker /= np.sqrt(np.sum(ker * ker) + 1e-18)
    return fftconvolve(white, ker, mode='same')


def apply_frame_gain(x, times, gains, sr):
    if len(times) < 2:
        return x
    t = np.arange(len(x)) / sr
    g = np.interp(t, times, gains, left=gains[0], right=gains[-1])
    return x * g


def points_for(voice, times, floor=0.12):
    frames = voice['frames']
    written = voice['writtenSize']
    power = np.array([0.0 if fr is None else (fr['power'] or 0.0) for fr in frames])
    active = power[power > 0]
    ref = float(np.median(active)) if len(active) else 1.0
    points = []
    prev_on = False
    last_y = 60.0
    for i, fr in enumerate(frames):
        t = round(float(times[i]), 5)
        if fr is None:
            if prev_on:
                points.append({'t': t, 'y': round(last_y, 4), 'size': 0, 'ease': 'linear'})
                prev_on = False
            continue
        loud = np.sqrt(max(fr['power'] or 0.0, 0.0))
        size = written * (loud / np.sqrt(ref)) if ref > 0 else written
        size = float(np.clip(max(size, floor), 0.0, 1.0))
        last_y = 69 + 12 * np.log2(fr['f0'] / 440)
        pt = {'t': t, 'y': round(float(last_y), 4), 'size': round(size, 4)}
        if prev_on:
            pt['ease'] = 'linear'
        points.append(pt)
        prev_on = True
    if prev_on:
        points.append({'t': round(float(times[-1]) + 0.01, 5), 'y': round(last_y, 4), 'size': 0, 'ease': 'linear'})
    return points


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--extract', default='/tmp/violin-solo/oracle/extract.json')
    parser.add_argument('--l0', default='/tmp/violin-solo/oracle/l0.wav')
    parser.add_argument('--l1', default='/tmp/violin-solo/oracle/l1.wav')
    parser.add_argument('--score', default='/tmp/violin-solo/oracle/l2-score.json')
    parser.add_argument('--template', default='examples/violin-minuet.json')
    args = parser.parse_args()

    data = json.loads(Path(args.extract).read_text())
    template = json.loads(Path(args.template).read_text())
    sr = int(data['sampleRate'])
    times = np.array(data['times'], dtype=np.float64)
    hop = max(1, int(round(data['hopSec'] * sr)))
    n = int(round((times[-1] + data['hopSec']) * sr))
    scale = 1.0 / unit_sine_peak(sr, hop)
    harm = np.zeros(n)
    for voice in data['voices'].values():
        harm += voice_signal(voice['frames'], times, sr, n, data['nPartial'], scale)

    noise = colored_noise(sr, n, np.array(data['residualHz']), np.array(data['residualMag']), 1006)
    noise_rms = np.array(data['noiseRms'], dtype=np.float64)
    noise = apply_frame_gain(noise, times, noise_rms / (np.sqrt(np.mean(noise ** 2)) + 1e-12), sr)

    _sr, rec = mono(args.l0)
    if _sr != sr:
        raise SystemExit(f'sample rate {_sr} != {sr}')
    m = min(len(rec), n)
    mix = harm[:m] + noise[:m]
    rec = rec[:m]
    gain = np.sqrt(np.mean(rec ** 2) + 1e-20) / np.sqrt(np.mean(mix ** 2) + 1e-20)
    write_wav(args.l1, sr, mix * gain)

    duration = round(float(times[-1]) + 0.8, 3)
    tracks = []
    for i, (name, voice) in enumerate(data['voices'].items()):
        tracks.append({
            'id': name,
            'instrument': 'violin',
            'channel': [0, 1],
            'seed': 1006 + i,
            'room': 0.2,
            'humanize': {'timeMs': 0, 'size': 0},
            'timbre': {'pitchLife': 0},
            'points': points_for(voice, times),
        })
    score = {
        'sampleRate': sr,
        'duration': duration,
        'bpm': template['bpm'],
        'meter': template['meter'],
        'seed': template['seed'],
        'master': template['master'],
        'tracks': tracks,
    }
    Path(args.score).write_text(json.dumps(score) + '\n')
    print('wrote', args.score, 'points', [len(t['points']) for t in tracks])


if __name__ == '__main__':
    main()
