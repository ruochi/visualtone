#!/usr/bin/env python3
"""Pull per-voice pitch, loudness, partials, and a noise envelope from the menuet.

The recording is aligned to the score with the same pitch-class warp the
figures use. Each voice is then tracked inside ±80 cents of the written
note, so a double stop does not jump to the other string.
"""
import argparse
import json
from pathlib import Path

import numpy as np

from violin_metrics import (
    chroma_from_mag,
    dtw_path,
    frame_norm,
    load_notes,
    midi_hz,
    mono,
    path_times,
    stft_mag,
    symbolic_chroma,
)

HOP_SEC = 0.005
NFFT = 4096
N_PARTIAL = 20
SEARCH_CENTS = 80


def rnum(x, sig=5):
    if x is None or not np.isfinite(x):
        return None
    return float(f'{float(x):.{sig}g}')


def parabola(mag, i):
    a, b, c = float(mag[i - 1]), float(mag[i]), float(mag[i + 1])
    denom = a - 2 * b + c
    if abs(denom) < 1e-18:
        return max(b, 0.0), 0.0
    delta = float(np.clip(0.5 * (a - c) / denom, -1.0, 1.0))
    peak = b - 0.25 * (a - c) * delta
    return max(peak, 0.0), delta


def local_peak(mag, freqs, f, cents=45):
    df = float(freqs[1] - freqs[0])
    if f < freqs[2] or f > freqs[-3]:
        return None, None
    half = max(f * (2 ** (cents / 1200) - 1), df * 1.5)
    i0 = max(1, int(np.searchsorted(freqs, f - half)))
    i1 = min(len(mag) - 2, int(np.searchsorted(freqs, f + half)))
    if i1 <= i0:
        return None, None
    j = i0 + int(np.argmax(mag[i0:i1 + 1]))
    j = min(max(j, 1), len(mag) - 2)
    peak, delta = parabola(mag, j)
    hz = float(freqs[j] + delta * df)
    return peak, hz


def harmonic_score(mag, freqs, f0, nh=6):
    total = 0.0
    weight = 0.0
    for h in range(1, nh + 1):
        peak, _hz = local_peak(mag, freqs, f0 * h, cents=35)
        if peak is None or peak <= 0:
            continue
        w = 1.0 / h
        total += w * np.log(peak + 1e-12)
        weight += w
    if weight <= 0:
        return -1e9
    return total / weight


def track_f0(mag, freqs, midi):
    f_exp = midi_hz(midi)
    lo = f_exp * 2 ** (-SEARCH_CENTS / 1200)
    hi = f_exp * 2 ** (SEARCH_CENTS / 1200)
    grid = np.exp(np.linspace(np.log(lo), np.log(hi), 33))
    scores = np.array([harmonic_score(mag, freqs, f) for f in grid])
    i = int(np.argmax(scores))
    if scores[i] < -1e8:
        return None
    delta = 0.0
    if 0 < i < len(scores) - 1:
        a, b, c = scores[i - 1], scores[i], scores[i + 1]
        denom = a - 2 * b + c
        if abs(denom) > 1e-9:
            delta = float(np.clip(0.5 * (a - c) / denom, -1.0, 1.0))
    step = np.log2(grid[1] / grid[0])
    return float(grid[i] * 2 ** (delta * step))


def smooth_run(tracked, hop_sec, cutoff=14.0):
    """Two one-pole passes. Keeps a 5 Hz vibrato and drops frame-to-frame chatter."""
    a = 1 - np.exp(-2 * np.pi * cutoff * hop_sec)
    y = tracked.copy()
    acc = None
    for i in range(len(y)):
        if not np.isfinite(y[i]):
            acc = None
            continue
        acc = y[i] if acc is None else acc + a * (y[i] - acc)
        y[i] = acc
    acc = None
    for i in range(len(y) - 1, -1, -1):
        if not np.isfinite(tracked[i]):
            acc = None
            continue
        acc = y[i] if acc is None else acc + a * (y[i] - acc)
        y[i] = acc
    return y


def median_nan(a, k=3):
    out = a.copy()
    r = k // 2
    for i in range(len(a)):
        w = a[max(0, i - r):i + r + 1]
        w = w[np.isfinite(w)]
        if len(w):
            out[i] = float(np.median(w))
    return out


def align_score(rec, sr, notes):
    hop = 1024
    freqs, times, mag = stft_mag(rec, sr, 4096, hop)
    pc_r = frame_norm(chroma_from_mag(mag, freqs))
    pc_y = frame_norm(symbolic_chroma(notes, times))
    band = int(round(1.6 * sr / hop))
    path = dtw_path(pc_y, pc_r, pc_y.sum(0), mag.sum(0), band)
    if len(path) < 8:
        raise SystemExit('time warp failed')
    score_t, rec_t = path_times(path, hop, sr)
    rec_t = np.maximum.accumulate(rec_t)
    return score_t, rec_t


def env_track(x, sr):
    hop = max(1, int(round(HOP_SEC * sr)))
    win = max(hop, int(round(0.02 * sr)))
    n = max(1, (len(x) - win) // hop)
    e = np.empty(n)
    t = np.empty(n)
    for i in range(n):
        s = i * hop
        seg = x[s:s + win]
        e[i] = np.sqrt(np.dot(seg, seg) / len(seg) + 1e-20)
        t[i] = (s + win / 2) / sr
    return t, e


def place_voice(voice_notes, score_t, rec_t, env_t, env, length):
    placed = []
    for n in sorted(voice_notes, key=lambda n: n['t']):
        a = float(np.interp(n['t'], score_t, rec_t))
        b = float(np.interp(n['t'] + n['dur'], score_t, rec_t))
        if b < a:
            a, b = b, a
        b = max(b, a + 0.04)
        placed.append({**n, 'rec_on': a, 'rec_off': min(b, length)})
    # Pull a boundary apart when the recording dips, so a bow change can retrigger.
    for i in range(len(placed) - 1):
        gap = placed[i + 1]['rec_on'] - placed[i]['rec_off']
        if gap > 0.05:
            continue
        mid = 0.5 * (placed[i]['rec_off'] + placed[i + 1]['rec_on'])
        left = float(np.interp(mid - 0.03, env_t, env))
        center = float(np.interp(mid, env_t, env))
        if left > 1e-6 and center < 0.55 * left:
            placed[i]['rec_off'] = max(placed[i]['rec_on'] + 0.03, mid - 0.008)
            placed[i + 1]['rec_on'] = min(placed[i + 1]['rec_off'] - 0.03, mid + 0.008)
    # Keep one voice from overlapping itself.
    for i in range(len(placed) - 1):
        if placed[i]['rec_off'] > placed[i + 1]['rec_on']:
            mid = 0.5 * (placed[i]['rec_off'] + placed[i + 1]['rec_on'])
            placed[i]['rec_off'] = mid
            placed[i + 1]['rec_on'] = mid
    return placed


def smooth_residual(freqs, mag, n_bins=72):
    voiced = mag[:, mag.shape[1] // 20:-mag.shape[1] // 20]
    if voiced.size == 0:
        voiced = mag
    floor = np.median(voiced, axis=1)
    hz = np.geomspace(180, 11000, n_bins)
    out = np.empty(n_bins)
    for i, f in enumerate(hz):
        lo, hi = f / 2 ** (1 / 6), f * 2 ** (1 / 6)
        sl = (freqs >= lo) & (freqs < hi)
        out[i] = float(np.median(floor[sl])) if np.any(sl) else 0.0
    kernel = np.array([0.2, 0.2, 0.2, 0.2, 0.2])
    padded = np.pad(out, 2, mode='edge')
    smoothed = np.convolve(padded, kernel, mode='valid')
    return hz, np.maximum(smoothed, 0.0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--score', default='examples/violin-minuet.json')
    parser.add_argument('--recording', default='/tmp/violin-solo/minuet.wav')
    parser.add_argument('--offset', type=float, default=13.3)
    parser.add_argument('--json', default='/tmp/violin-solo/oracle/extract.json')
    parser.add_argument('--wav', default='/tmp/violin-solo/oracle/l0.wav')
    args = parser.parse_args()

    score = json.loads(Path(args.score).read_text())
    bpm = score['bpm']
    meter = score.get('meter', [4, 4])
    beat = (60 / bpm) * (4 / meter[1])
    phrase = 8 * meter[0] * beat
    tail = 0.45
    sr, rec_all = mono(args.recording)
    a0 = int(round(args.offset * sr))
    n = int(round((phrase + tail) * sr))
    rec = rec_all[a0:a0 + n]
    if len(rec) < n:
        rec = np.pad(rec, (0, n - len(rec)))

    notes = load_notes(score)
    score_t, rec_t = align_score(rec[:int(phrase * sr)], sr, notes)
    env_t, env = env_track(rec, sr)
    melody = [n for n in notes if n['size'] >= 0.6]
    bass = [n for n in notes if n['size'] < 0.6]
    voices_in = {
        'melody': place_voice(melody, score_t, rec_t, env_t, env, len(rec) / sr),
        'bass': place_voice(bass, score_t, rec_t, env_t, env, len(rec) / sr),
    }

    hop = max(1, int(round(HOP_SEC * sr)))
    freqs, times, mag = stft_mag(rec, sr, NFFT, hop)
    n_frames = mag.shape[1]
    f0s = {name: np.full(n_frames, np.nan) for name in voices_in}
    written = {name: np.full(n_frames, np.nan) for name in voices_in}
    for name, placed in voices_in.items():
        for note in placed:
            sl = np.where((times >= note['rec_on']) & (times < note['rec_off']))[0]
            for i in sl:
                f0s[name][i] = note['midi']  # placeholder, replaced below
                written[name][i] = note['midi']
            tracked = np.full(len(sl), np.nan)
            for k, i in enumerate(sl):
                f0 = track_f0(mag[:, i], freqs, note['midi'])
                if f0 is not None:
                    tracked[k] = f0
            tracked = smooth_run(median_nan(tracked, 3), hop / sr)
            for k, i in enumerate(sl):
                f0s[name][i] = tracked[k]

    partials = {name: np.full((n_frames, N_PARTIAL), np.nan) for name in voices_in}
    clear = {name: np.zeros((n_frames, N_PARTIAL), dtype=bool) for name in voices_in}
    for i in range(n_frames):
        present = []
        for name in voices_in:
            if np.isfinite(f0s[name][i]):
                present.append((name, float(f0s[name][i])))
        for name, f0 in present:
            others = [f for n, f in present if n != name]
            for h in range(1, N_PARTIAL + 1):
                freq = f0 * h
                if freq > 9000:
                    continue
                blocked = False
                for other in others:
                    for hb in range(1, N_PARTIAL + 1):
                        fb = other * hb
                        if fb < 80 or fb > 10000:
                            continue
                        if abs(1200 * np.log2(freq / fb)) < 50 and not (h == 1 and hb > 1 and freq < fb):
                            # Keep the lower harmonic number. The other voice owns this bin.
                            if h > hb or (h == hb and f0 > other):
                                blocked = True
                            break
                    if blocked:
                        break
                peak, _hz = local_peak(mag[:, i], freqs, freq, cents=40)
                if peak is None:
                    continue
                partials[name][i, h - 1] = peak
                clear[name][i, h - 1] = not blocked

    power = {}
    for name in voices_in:
        p = np.zeros(n_frames)
        for i in range(n_frames):
            amps = partials[name][i]
            mask = clear[name][i] & np.isfinite(amps)
            if np.any(mask):
                p[i] = float(np.sum(amps[mask] ** 2))
        power[name] = p

    # Residual: knock the tracked partials out, then keep a smooth floor.
    resid = mag.copy()
    df = float(freqs[1] - freqs[0])
    for i in range(n_frames):
        for name in voices_in:
            f0 = f0s[name][i]
            if not np.isfinite(f0):
                continue
            for h in range(1, N_PARTIAL + 1):
                if not clear[name][i, h - 1]:
                    continue
                freq = f0 * h
                half = max(freq * (2 ** (30 / 1200) - 1), df * 1.25)
                sl = np.where((freqs >= freq - half) & (freqs <= freq + half))[0]
                if len(sl) == 0:
                    continue
                left = max(0, sl[0] - 6)
                right = min(len(freqs), sl[-1] + 7)
                floor = float(np.median(mag[left:right, i])) if right > left else 0.0
                resid[sl, i] = floor
    res_hz, res_mag = smooth_residual(freqs, resid)
    noise_rms = np.sqrt(np.mean(resid ** 2, axis=0) + 1e-20)

    cents = []
    for name in voices_in:
        for i in range(n_frames):
            if not np.isfinite(f0s[name][i]) or not np.isfinite(written[name][i]):
                continue
            cents.append(1200 * np.log2(f0s[name][i] / midi_hz(written[name][i])))
    cents = np.array(cents)
    med = float(np.median(np.abs(cents))) if len(cents) else 999.0
    within = float(np.mean(np.abs(cents) <= 40)) if len(cents) else 0.0
    print(json.dumps({
        'frames': int(n_frames),
        'tracked': int(len(cents)),
        'medianAbsCents': round(med, 2),
        'within40Cents': round(within, 3),
        'melodyNotes': len(voices_in['melody']),
        'bassNotes': len(voices_in['bass']),
    }))
    if med > 35 or within < 0.8:
        raise SystemExit(f'pitch track is not locked to the score ({med:.1f} cents, {within:.0%} within 40)')

    def pack(name, written_size):
        f0 = f0s[name]
        rows = []
        for i in range(n_frames):
            if not np.isfinite(f0[i]):
                rows.append(None)
                continue
            amps = []
            flags = 0
            for h in range(N_PARTIAL):
                amps.append(None if not np.isfinite(partials[name][i, h]) else rnum(partials[name][i, h]))
                if clear[name][i, h]:
                    flags |= 1 << h
            rows.append({
                'f0': rnum(f0[i], 6),
                'midi': rnum(written[name][i], 4),
                'power': rnum(power[name][i]),
                'partials': amps,
                'clear': int(flags),
            })
        return {'writtenSize': written_size, 'frames': rows}

    out = {
        'piece': 'J.S. Bach, Violin Partita No. 3 BWV 1006, Menuet I, bars 1-8',
        'sampleRate': sr,
        'offsetSec': args.offset,
        'phraseSec': round(phrase, 4),
        'hopSec': hop / sr,
        'nPartial': N_PARTIAL,
        'times': [rnum(t, 6) for t in times],
        'scoreMap': {'scoreSec': [rnum(t, 6) for t in score_t], 'recSec': [rnum(t, 6) for t in rec_t]},
        'voices': {
            'melody': pack('melody', 0.64),
            'bass': pack('bass', 0.55),
        },
        'residualHz': [rnum(f, 6) for f in res_hz],
        'residualMag': [rnum(v) for v in res_mag],
        'noiseRms': [rnum(v) for v in noise_rms],
        'track': {'medianAbsCents': round(med, 2), 'within40Cents': round(within, 3), 'frames': int(len(cents))},
    }
    dest = Path(args.json)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out) + '\n')
    print('wrote', dest)

    from scipy.io import wavfile
    wavfile.write(args.wav, sr, np.clip(rec, -1, 1).astype(np.float32))
    print('wrote', args.wav)


if __name__ == '__main__':
    main()
