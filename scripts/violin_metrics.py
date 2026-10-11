"""Shared pitch, chroma, and harmonic measurements for the violin solo.

These functions used to live in violin-solo-figures.py. The oracle ladder
uses the same time warp and the same partial meter.
"""
import re

import numpy as np
from scipy.io import wavfile
from scipy.signal import stft

PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
SEMI = {'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4, 'F': 5, 'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11}
THIRDS = [315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000]


def mono(path):
    sr, data = wavfile.read(path)
    x = np.asarray(data, dtype=np.float64)
    if x.ndim == 2:
        x = x.mean(axis=1)
    peak = np.max(np.abs(x))
    if peak > 2:  # integer PCM
        x = x / np.iinfo(data.dtype).max
    return sr, x


def parse_pitch(name):
    m = re.match(r'^([A-G]#?)(-?\d+)$', name)
    if not m:
        raise SystemExit(f'bad pitch {name}')
    return (int(m.group(2)) + 1) * 12 + SEMI[m.group(1)]


def parse_at(at, bpm, meter):
    bar, beat = at.split(':')
    beat_sec = (60 / bpm) * (4 / meter[1])
    return (int(bar) - 1) * meter[0] * beat_sec + (float(beat) - 1) * beat_sec


def parse_len(len_, bpm):
    num, den = len_.split('/')
    return (4 * int(num) / int(den)) * (60 / bpm)


def load_notes(score):
    bpm = score['bpm']
    meter = score.get('meter', [4, 4])
    notes = []
    for track in score['tracks']:
        for n in track.get('notes', []):
            notes.append({
                't': parse_at(n['at'], bpm, meter),
                'dur': parse_len(n['len'], bpm),
                'midi': parse_pitch(n['pitch']),
                'size': n['size'],
                'bar': int(str(n.get('at', '1:1')).split(':')[0]),
            })
    return notes


def cosine(a, b):
    na = np.linalg.norm(a)
    nb = np.linalg.norm(b)
    if na < 1e-12 or nb < 1e-12:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def chroma_from_mag(mag, freqs, fmin=200.0, fmax=2500.0):
    pc = np.zeros((12, mag.shape[1]), dtype=np.float64)
    for i, f in enumerate(freqs):
        if f < fmin or f > fmax:
            continue
        midi = 69 + 12 * np.log2(f / 440)
        pc[int(np.round(midi)) % 12] += mag[i] ** 2
    return pc


def frame_norm(pc):
    n = np.linalg.norm(pc, axis=0, keepdims=True)
    n[n < 1e-12] = 1
    return pc / n


def stft_mag(x, sr, nfft, hop):
    freqs, times, z = stft(
        x, fs=sr, nperseg=nfft, noverlap=nfft - hop, window='hann',
        padded=False, boundary=None,
    )
    return freqs, times, np.abs(z)


def symbolic_chroma(notes, times):
    pc = np.zeros((12, len(times)), dtype=np.float64)
    for n in notes:
        k = n['midi'] % 12
        on = (times >= n['t']) & (times < n['t'] + n['dur'])
        pc[k, on] += n['size']
    return pc


def mean_chroma(pc):
    return frame_norm(pc).mean(axis=1)


def best_lag(a, b, sr, max_lag=0.08):
    hop = 64
    win = max(1, int(0.02 * sr))

    def env(x):
        n = max(1, (len(x) - win) // hop)
        e = np.empty(n)
        for i in range(n):
            s = i * hop
            seg = x[s:s + win]
            e[i] = np.sqrt(np.dot(seg, seg) / len(seg) + 1e-12)
        return e

    ea, eb = env(a), env(b)
    max_k = int(max_lag * sr / hop)
    best_k, best_c = 0, -1.0
    for k in range(-max_k, max_k + 1):
        if k >= 0:
            x, y = ea[:len(ea) - k or None], eb[k:]
        else:
            x, y = ea[-k:], eb[:len(eb) + k or None]
        m = min(len(x), len(y))
        if m < 8:
            continue
        c = np.corrcoef(x[:m], y[:m])[0, 1]
        if np.isfinite(c) and c > best_c:
            best_c, best_k = float(c), k
    return best_k * hop / sr, best_c


def rms(x):
    return float(np.sqrt(np.mean(x * x) + 1e-20))


def mel_filterbank(sr, nfft, n_mels=64, fmin=80.0, fmax=8000.0):
    def hz_mel(f):
        return 2595.0 * np.log10(1 + f / 700.0)

    def mel_hz(m):
        return 700.0 * (10 ** (m / 2595.0) - 1)

    pts = mel_hz(np.linspace(hz_mel(fmin), hz_mel(fmax), n_mels + 2))
    bins = np.floor((nfft + 1) * pts / sr).astype(int)
    weights = np.zeros((n_mels, nfft // 2 + 1))
    for i in range(n_mels):
        left, center, right = bins[i], bins[i + 1], bins[i + 2]
        if center <= left or right <= center:
            continue
        for j in range(left, center):
            weights[i, j] = (j - left) / (center - left)
        for j in range(center, right):
            weights[i, j] = (right - j) / (right - center)
    return weights, mel_hz(np.linspace(hz_mel(fmin), hz_mel(fmax), n_mels + 2)[1:-1])


def db(mag, ref):
    return 20 * np.log10(mag / ref + 1e-8)


def envelope(x, sr, win=0.03, hop=0.01):
    w = max(1, int(win * sr))
    h = max(1, int(hop * sr))
    n = max(1, (len(x) - w) // h)
    e = np.empty(n)
    t = np.empty(n)
    for i in range(n):
        s = i * h
        seg = x[s:s + w]
        e[i] = np.sqrt(np.dot(seg, seg) / len(seg) + 1e-20)
        t[i] = (s + w / 2) / sr
    return t, e


def dtw_path(a, b, energy_a, energy_b, band):
    """Banded DTW. a and b are frame-normalized chroma, shape (12, T)."""
    n, m = a.shape[1], b.shape[1]
    thr_a = np.median(energy_a) * 0.25
    thr_b = np.median(energy_b) * 0.25
    inf = 1e6
    prev = np.full(m + 1, inf)
    prev[0] = 0.0
    choice = np.full((n, m), -1, dtype=np.int8)
    for i in range(1, n + 1):
        cur = np.full(m + 1, inf)
        j0 = max(1, i - band)
        j1 = min(m, i + band)
        ai = a[:, i - 1]
        silent_a = energy_a[i - 1] < thr_a
        for j in range(j0, j1 + 1):
            if silent_a and energy_b[j - 1] < thr_b:
                cost = 0.0
            else:
                cost = 1.0 - float(np.dot(ai, b[:, j - 1]))
            opts = (prev[j - 1], prev[j], cur[j - 1])
            k = 0 if opts[0] <= opts[1] and opts[0] <= opts[2] else (1 if opts[1] <= opts[2] else 2)
            cur[j] = cost + opts[k]
            choice[i - 1, j - 1] = k
        prev = cur
    i, j = n - 1, m - 1
    if not np.isfinite(prev[m]) or prev[m] >= inf / 2 or choice[i, j] < 0:
        return []
    path = []
    while i >= 0 and j >= 0 and choice[i, j] >= 0:
        path.append((i, j))
        step = int(choice[i, j])
        if step == 0:
            i, j = i - 1, j - 1
        elif step == 1:
            i -= 1
        else:
            j -= 1
        if i < 0 or j < 0:
            break
    path.reverse()
    return path


def path_times(path, hop, sr):
    """path items are (query_index, reference_index).

    Returns the query times and the reference time to read for each of them.
    """
    buckets = {}
    for query, ref in path:
        buckets.setdefault(query, []).append(ref)
    qs = np.array(sorted(buckets), dtype=np.float64)
    query_t = qs * hop / sr
    ref_t = np.array([np.mean(buckets[int(q)]) * hop / sr for q in qs])
    return query_t, ref_t


def warp_mag(mag_rec, times_rec, syn_t, rec_t, times_syn):
    """Recording magnitude placed on the synth time grid."""
    mapped = np.interp(times_syn, syn_t, rec_t)
    idx = np.clip(np.searchsorted(times_rec, mapped), 0, len(times_rec) - 1)
    prev = np.clip(idx - 1, 0, len(times_rec) - 1)
    take_prev = np.abs(times_rec[prev] - mapped) < np.abs(times_rec[idx] - mapped)
    idx = np.where(take_prev, prev, idx)
    return mag_rec[:, idx]


def shape_distance(mag_a, mag_b, freqs, fmin=250.0, fmax=6000.0):
    """Mean |dB| after each frame loses its own loudness. Level is not timbre."""
    band = (freqs >= fmin) & (freqs <= fmax)
    cols = min(mag_a.shape[1], mag_b.shape[1])
    a = mag_a[band, :cols]
    b = mag_b[band, :cols]
    da = 20 * np.log10(a + 1e-10)
    db_ = 20 * np.log10(b + 1e-10)
    da -= np.median(da, axis=0, keepdims=True)
    db_ -= np.median(db_, axis=0, keepdims=True)
    ea = np.mean(a ** 2, axis=0)
    eb = np.mean(b ** 2, axis=0)
    gate = (ea > np.median(ea) * 0.2) & (eb > np.median(eb) * 0.2)
    if int(gate.sum()) < 8:
        gate = np.ones(cols, dtype=bool)
    return float(np.mean(np.abs(da[:, gate] - db_[:, gate])))


N_HARM = 10


def partial_db(mag, freqs, f0, other_f0):
    """Level of partials 1..N relative to the strongest clear partial, in dB."""
    peaks = np.full(N_HARM, np.nan)
    df = float(freqs[1] - freqs[0]) if len(freqs) > 1 else 1.0
    for h in range(1, N_HARM + 1):
        f = f0 * h
        if f < 180 or f > 7500:
            continue
        blocked = False
        for f0b in other_f0:
            for hb in range(1, N_HARM + 1):
                fb = f0b * hb
                if fb < 150 or fb > 9000:
                    continue
                if abs(1200 * np.log2(f / fb)) < 70:
                    blocked = True
                    break
            if blocked:
                break
        if blocked:
            continue
        half = max(f * (2 ** (40 / 1200) - 1), df * 1.25)
        sl = (freqs >= f - half) & (freqs <= f + half)
        if not np.any(sl):
            continue
        peak = float(np.max(mag[sl]))
        wide = (freqs >= f * 2 ** (-1.5 / 12)) & (freqs <= f * 2 ** (1.5 / 12))
        floor = float(np.median(mag[wide])) if np.any(wide) else 0.0
        if peak < floor * 1.6:
            continue
        peaks[h - 1] = peak
    ref = np.nanmax(peaks)
    if not np.isfinite(ref) or ref <= 0:
        return np.full(N_HARM, np.nan)
    return 20 * np.log10(peaks / ref + 1e-12)


def midi_hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def mag_span(mag, times, t0, t1):
    sl = (times >= t0) & (times < t1)
    if int(sl.sum()) == 0:
        i = int(np.argmin(np.abs(times - 0.5 * (t0 + t1))))
        return mag[:, i]
    return np.mean(mag[:, sl], axis=1)


def harmonic_slopes(notes, mag_syn, mag_rec, times, freqs, syn_t, rec_t):
    """Relative partial levels. Recording windows follow the time warp."""
    rows = []
    for n in notes:
        if n['dur'] < 0.2:
            continue
        a = n['t'] + 0.22 * n['dur']
        b = n['t'] + 0.72 * n['dur']
        if b <= a:
            continue
        others = [
            midi_hz(o['midi']) for o in notes
            if o is not n and o['t'] < b and o['t'] + o['dur'] > a and abs(o['midi'] - n['midi']) > 0.4
        ]
        f0 = midi_hz(n['midi'])
        syn = partial_db(mag_span(mag_syn, times, a, b), freqs, f0, others)
        ra, rb = np.interp([a, b], syn_t, rec_t)
        if rb < ra:
            ra, rb = rb, ra
        if rb - ra < 0.04:
            rb = ra + 0.04
        rec = partial_db(mag_span(mag_rec, times, ra, rb), freqs, f0, others)
        both = np.isfinite(syn) & np.isfinite(rec)
        if int(both.sum()) < 4:
            continue
        row = {'midi': n['midi'], 't': n['t'], 'syn': syn, 'rec': rec, 'both': both}
        if 'bar' in n:
            row['bar'] = n['bar']
        rows.append(row)
    return rows


def slope_summary(rows):
    if not rows:
        return {'meanAbsDb': None, 'partialDb': [], 'notes': 0}
    acc = []
    per = []
    for h in range(N_HARM):
        vals = [r['syn'][h] - r['rec'][h] for r in rows if r['both'][h]]
        if len(vals) >= 3:
            med = float(np.median(vals))
            acc.append(abs(med))
            per.append({'h': h + 1, 'db': round(med, 2), 'notes': len(vals)})
    note_err = []
    for r in rows:
        d = np.abs(r['syn'][r['both']] - r['rec'][r['both']])
        note_err.append(float(np.mean(d)))

    def mean_abs(subset):
        got = []
        for h in range(N_HARM):
            vals = [r['syn'][h] - r['rec'][h] for r in subset if r['both'][h]]
            if len(vals) >= 3:
                got.append(abs(float(np.median(vals))))
        return round(float(np.mean(got)), 2) if got else None

    return {
        'meanAbsDb': round(float(np.mean(acc)), 2) if acc else None,
        'noteMeanAbsDb': round(float(np.mean(note_err)), 2) if note_err else None,
        'lowNotesMeanAbsDb': mean_abs([r for r in rows if r['midi'] < 70]),
        'highNotesMeanAbsDb': mean_abs([r for r in rows if r['midi'] >= 70]),
        'partialDb': per,
        'notes': len(rows),
    }


def third_octave(x, sr):
    freqs, times, mag = stft_mag(x, sr, 4096, 1024)
    power = mag ** 2
    out = []
    for center in THIRDS:
        lo, hi = center / 2 ** (1 / 6), center * 2 ** (1 / 6)
        band = (freqs >= lo) & (freqs < hi)
        if not np.any(band):
            out.append(0.0)
            continue
        out.append(float(np.sqrt(np.mean(power[band]))))
    return np.array(out)
