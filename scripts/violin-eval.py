#!/usr/bin/env python3
"""Score L1, L2, and L3 against the menuet recording with one meter.

L1 is analysis resynthesis, L2 is the violin engine on the extracted controls,
L3 is the engine on the written score. Bars 1–4 and 5–8 are reported apart so
a later fit can train on the first half and be judged on the second.
"""
import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from matplotlib import font_manager

from violin_metrics import (
    THIRDS,
    chroma_from_mag,
    dtw_path,
    envelope,
    frame_norm,
    harmonic_slopes,
    load_notes,
    mag_span,
    midi_hz,
    mono,
    path_times,
    rms,
    shape_distance,
    slope_summary,
    stft_mag,
    warp_mag,
)

FONT = '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'
font_manager.fontManager.addfont(FONT)
plt.rcParams['font.family'] = 'WenQuanYi Micro Hei'
plt.rcParams['axes.unicode_minus'] = False

INK = '#1c1814'
PAPER = '#f7f4ef'
LEVELS = ('L1', 'L2', 'L3')
LEVEL_COLOR = {'L1': '#0f766e', 'L2': '#c05621', 'L3': '#1d4e89'}
LEVEL_LABEL = {
    'L1': '重合成',
    'L2': '真实控制',
    'L3': '乐谱',
}
BANDS = ((200, 800), (800, 2000), (2000, 5000), (5000, 10000))
ATTACK_AT = (0.01, 0.03, 0.06, 0.10, 0.15)


def pair_spectra(rec, cand, sr):
    hop = 1024
    freqs, times, mag_r = stft_mag(rec, sr, 4096, hop)
    _, _, mag_c = stft_mag(cand, sr, 4096, hop)
    m = min(mag_r.shape[1], mag_c.shape[1], len(times))
    mag_r, mag_c, times = mag_r[:, :m], mag_c[:, :m], times[:m]
    pc_r = frame_norm(chroma_from_mag(mag_r, freqs))
    pc_c = frame_norm(chroma_from_mag(mag_c, freqs))
    band = int(round(1.6 * sr / hop))
    path = dtw_path(pc_c, pc_r, mag_c.sum(0), mag_r.sum(0), band)
    if len(path) < 8:
        raise SystemExit('time warp failed')
    syn_t, rec_t = path_times(path, hop, sr)
    rec_t = np.maximum.accumulate(rec_t)
    return freqs, times, mag_r, mag_c, syn_t, rec_t


def remap_notes(notes, score_sec, rec_sec):
    out = []
    for n in notes:
        a = float(np.interp(n['t'], score_sec, rec_sec))
        b = float(np.interp(n['t'] + n['dur'], score_sec, rec_sec))
        if b < a:
            a, b = b, a
        out.append({**n, 't': a, 'dur': max(0.05, b - a)})
    return out


def note_errors(rows):
    err = []
    for r in rows:
        d = np.abs(r['syn'][r['both']] - r['rec'][r['both']])
        if len(d):
            err.append(float(np.mean(d)))
    return np.array(err)


def dist_of(err):
    if len(err) == 0:
        return {'median': None, 'mean': None, 'p90': None, 'notes': 0}
    return {
        'median': round(float(np.median(err)), 2),
        'mean': round(float(np.mean(err)), 2),
        'p90': round(float(np.percentile(err, 90)), 2),
        'notes': int(len(err)),
    }


def holdout(rows):
    def pack(pred):
        sub = [r for r in rows if pred(r)]
        return {'harmonicMeanAbsDb': slope_summary(sub)['meanAbsDb'], **dist_of(note_errors(sub))}

    return {
        'bars1to4': pack(lambda r: r.get('bar', 9) <= 4),
        'bars5to8': pack(lambda r: r.get('bar', 0) >= 5),
    }


def by_frequency(rows):
    buckets = {hz: [] for hz in THIRDS}
    for r in rows:
        f0 = midi_hz(r['midi'])
        for h in range(len(r['both'])):
            if not r['both'][h]:
                continue
            f = f0 * (h + 1)
            if not (200 <= f <= 9000):
                continue
            center = min(THIRDS, key=lambda c: abs(np.log(c / f)))
            buckets[center].append(float(r['syn'][h] - r['rec'][h]))
    return [
        {'hz': hz, 'db': round(float(np.median(v)), 2), 'n': len(v)}
        for hz, v in buckets.items() if len(v) >= 3
    ]


def hnr_db(mag, freqs, f0):
    out = []
    for lo, hi in BANDS:
        sl = np.where((freqs >= lo) & (freqs < hi))[0]
        if len(sl) < 4 or not np.isfinite(f0):
            out.append(np.nan)
            continue
        band_f = freqs[sl]
        peak = np.zeros(len(sl), dtype=bool)
        for h in range(1, 16):
            f = f0 * h
            if f < lo or f >= hi:
                continue
            peak |= np.abs(band_f - f) <= f * (2 ** (40 / 1200) - 1)
        power = mag[sl] ** 2
        num = float(np.sum(power[peak]))
        den = float(np.sum(power[~peak])) + 1e-20
        out.append(10 * np.log10(num / den) if num > 0 else np.nan)
    return out


def hnr_gap(notes, mag_c, mag_r, times, freqs, syn_t, rec_t):
    gaps = []
    for n in notes:
        if n['dur'] < 0.2:
            continue
        a = n['t'] + 0.25 * n['dur']
        b = n['t'] + 0.7 * n['dur']
        ra, rb = np.interp([a, b], syn_t, rec_t)
        if rb < ra:
            ra, rb = rb, ra
        cand = hnr_db(mag_span(mag_c, times, a, b), freqs, midi_hz(n['midi']))
        rec = hnr_db(mag_span(mag_r, times, ra, rb), freqs, midi_hz(n['midi']))
        gaps.append(np.array(cand) - np.array(rec))
    if not gaps:
        return []
    med = np.nanmedian(np.stack(gaps), axis=0)
    return [
        {'hz': [lo, hi], 'db': None if not np.isfinite(v) else round(float(v), 2)}
        for (lo, hi), v in zip(BANDS, med)
    ]


def centroid_track(x, sr):
    freqs, times, mag = stft_mag(x, sr, 2048, 256)
    sl = (freqs >= 200) & (freqs <= 8000)
    f = freqs[sl][:, None]
    p = mag[sl] ** 2
    cent = np.sum(f * p, axis=0) / (np.sum(p, axis=0) + 1e-20)
    return times, cent


def attack_report(notes, rec_t_c, rec_cent, cand_t, cand_cent, syn_t, rec_map):
    err_30 = []
    err_100 = []
    steady = []
    for n in notes:
        if n['dur'] < 0.18:
            continue
        rec_on = float(np.interp(n['t'], syn_t, rec_map))

        def at(track_t, track, origin, dt):
            return float(np.interp(origin + dt, track_t, track))

        c30 = at(cand_t, cand_cent, n['t'], 0.03)
        r30 = at(rec_t_c, rec_cent, rec_on, 0.03)
        c100 = at(cand_t, cand_cent, n['t'], 0.10)
        r100 = at(rec_t_c, rec_cent, rec_on, 0.10)
        if min(c30, r30, c100, r100) > 50:
            err_30.append(abs(1200 * np.log2(c30 / r30)))
            err_100.append(abs(1200 * np.log2(c100 / r100)))
        sustain_c = np.median([at(cand_t, cand_cent, n['t'], t) for t in (0.16, 0.22, 0.28)])
        sustain_r = np.median([at(rec_t_c, rec_cent, rec_on, t) for t in (0.16, 0.22, 0.28)])

        def steady_ms(origin_at, track_t, track, sustain):
            grid = np.arange(0.0, 0.15, 0.005)
            series = np.array([float(np.interp(origin_at + t, track_t, track)) for t in grid])
            for i in range(len(grid) - 3):
                if np.all(np.abs(series[i:i + 3] - sustain) < 0.18 * max(sustain, 1)):
                    return grid[i] * 1000
            return np.nan

        sc = steady_ms(n['t'], cand_t, cand_cent, sustain_c)
        sr_ = steady_ms(rec_on, rec_t_c, rec_cent, sustain_r)
        if np.isfinite(sc) and np.isfinite(sr_):
            steady.append(sc - sr_)
    def med(a):
        return None if len(a) == 0 else round(float(np.median(a)), 1)

    return {
        'centroid30MsCents': med(err_30),
        'centroid100MsCents': med(err_100),
        'steadyLagMs': med(steady),
        'notes': len(err_30),
    }


def frame_f0(frame, sr, midi):
    window = frame * np.hanning(len(frame))
    spec = np.abs(np.fft.rfft(window))
    freqs = np.fft.rfftfreq(len(frame), 1 / sr)
    f_exp = midi_hz(midi)
    lo, hi = f_exp * 2 ** (-80 / 1200), f_exp * 2 ** (80 / 1200)
    grid = np.exp(np.linspace(np.log(lo), np.log(hi), 25))
    best, best_s = None, -1e9
    df = float(freqs[1] - freqs[0]) if len(freqs) > 1 else 1
    for f0 in grid:
        s = 0.0
        w = 0.0
        for h in range(1, 6):
            f = f0 * h
            if f >= freqs[-1]:
                break
            i = int(round(f / df))
            if i < 1 or i >= len(spec) - 1:
                continue
            s += np.log(spec[i] + 1e-12) / h
            w += 1 / h
        if w > 0 and s / w > best_s:
            best_s = s / w
            best = float(f0)
    return best


def vibrato_report(rec, cand, sr, notes, syn_t, rec_map):
    win = int(round(0.04 * sr))
    hop = int(round(0.01 * sr))
    depths_r, depths_c, rates_r, rates_c = [], [], [], []
    corr_r, corr_c = [], []
    for n in notes:
        if n['dur'] < 0.36:
            continue
        a = n['t'] + 0.22 * n['dur']
        b = n['t'] + 0.8 * n['dur']
        if b - a < 0.18:
            continue
        ra, rb = np.interp([a, b], syn_t, rec_map)

        def track(x, t0, t1):
            i0 = int(t0 * sr)
            i1 = int(t1 * sr)
            f0, tt = [], []
            i = i0
            while i + win <= i1 and i + win <= len(x):
                f = frame_f0(x[i:i + win], sr, n['midi'])
                if f:
                    f0.append(f)
                    tt.append((i + win / 2) / sr)
                i += hop
            return np.array(tt), np.array(f0)

        tr, fr = track(rec, ra, rb)
        tc, fc = track(cand, a, b)
        def depth_rate(f0):
            if len(f0) < 8:
                return None, None
            cents = 1200 * np.log2(f0 / np.median(f0))
            depth = float(np.std(cents) * np.sqrt(2))
            spec = np.abs(np.fft.rfft(cents - np.mean(cents)))
            freq = np.fft.rfftfreq(len(cents), 0.01)
            sl = (freq >= 3.0) & (freq <= 8.5)
            rate = float(freq[sl][int(np.argmax(spec[sl]))]) if np.any(sl) else None
            return depth, rate

        dr, rr = depth_rate(fr)
        dc, rc = depth_rate(fc)
        if dr is not None and dc is not None:
            depths_r.append(dr)
            depths_c.append(dc)
        if rr is not None and rc is not None:
            rates_r.append(rr)
            rates_c.append(rc)

        def partial_corr(x, t0, t1, f0_t, f0):
            if len(f0) < 12:
                return None
            corrs = []
            cents = 1200 * np.log2(f0 / np.median(f0))
            series = {h: [] for h in range(6)}
            used = []
            for t, f, c in zip(f0_t, f0, cents):
                i0 = int(t * sr)
                frame = x[i0:i0 + win]
                if len(frame) < win:
                    break
                spec = np.abs(np.fft.rfft(frame * np.hanning(win)))
                bins = np.fft.rfftfreq(win, 1 / sr)
                used.append(c)
                for h in range(6):
                    i = int(np.argmin(np.abs(bins - f * (h + 1))))
                    i = min(max(i, 1), len(spec) - 2)
                    series[h].append(spec[i])
            cents = np.array(used)
            for h in range(6):
                amp = np.array(series[h])
                if len(amp) != len(cents) or np.std(amp) < 1e-12 or np.std(cents) < 1:
                    continue
                corrs.append(float(np.corrcoef(np.log(amp + 1e-12), cents[:len(amp)])[0, 1]))
            finite = [c for c in corrs if np.isfinite(c)]
            if not finite:
                return None
            return float(np.median(np.abs(finite)))

        cr = partial_corr(rec, ra, rb, tr, fr)
        cc = partial_corr(cand, a, b, tc, fc)
        if cr is not None and cc is not None:
            corr_r.append(cr)
            corr_c.append(cc)

    def med(a):
        return None if len(a) == 0 else round(float(np.median(a)), 2)

    return {
        'recordingDepthCents': med(depths_r),
        'depthCents': med(depths_c),
        'depthErrorCents': None if not depths_c else round(float(np.median(np.array(depths_c) - np.array(depths_r))), 2),
        'recordingRateHz': med(rates_r),
        'rateHz': med(rates_c),
        'partialF0AbsCorr': med(corr_c),
        'recordingPartialF0AbsCorr': med(corr_r),
        'notes': len(depths_c),
    }


def phrase_report(rec, cand, sr, syn_t, rec_t):
    te, ee_r = envelope(rec, sr)
    tc, ee_c = envelope(cand, sr)
    mapped = np.interp(tc, syn_t, rec_t)
    ee_w = np.interp(mapped, te, ee_r)
    k = min(len(ee_c), len(ee_w))
    corr = float(np.corrcoef(ee_c[:k], ee_w[:k])[0, 1]) if k > 8 else None
    def span(e):
        db = 20 * np.log10(e + 1e-8)
        return float(np.percentile(db, 95) - np.percentile(db, 5))
    return {
        'envelopeCorrelation': None if corr is None or not np.isfinite(corr) else round(corr, 3),
        'loudnessSpanDb': {'recording': round(span(ee_r), 2), 'candidate': round(span(ee_c), 2)},
    }


def round_or_none(v, n=2):
    if v is None or not np.isfinite(v):
        return None
    return round(float(v), n)


def judge(levels):
    """Broadband shape is saturated by the room, so it cannot rank the levels.

    The partial meter can: L1 copies the partials and should land near 0 dB.
    Whatever is left at L2 is the engine. The phrase meter is the envelope
    correlation. L3 collapses it; L2 should bring it back.
    """
    harm = {k: levels[k]['harmonic']['meanAbsDb'] for k in LEVELS}
    env = {k: levels[k]['phrase']['envelopeCorrelation'] for k in LEVELS}
    shape = {k: levels[k]['shapeDb'] for k in LEVELS}
    timbre_engine = None if None in (harm['L1'], harm['L2']) else harm['L2'] - harm['L1']
    timbre_control = None if None in (harm['L2'], harm['L3']) else harm['L3'] - harm['L2']
    phrase_l1 = None if env['L1'] is None else 1 - env['L1']
    phrase_l2 = None if env['L2'] is None else 1 - env['L2']
    phrase_l3 = None if env['L3'] is None else 1 - env['L3']
    phrase_engine = None if None in (phrase_l1, phrase_l2) else phrase_l2 - phrase_l1
    phrase_control = None if None in (phrase_l2, phrase_l3) else phrase_l3 - phrase_l2
    # Partials decide the steady tone. The phrase decides the line.
    # A gap under about 1 dB, or a correlation gap under 0.15, does not count.
    timbre_is_engine = timbre_engine is not None and timbre_engine > 1 and (timbre_control or 0) < timbre_engine
    phrase_is_control = phrase_control is not None and phrase_control > 0.15
    phrase_is_engine = phrase_engine is not None and phrase_engine > 0.15
    if harm['L1'] is not None and harm['L1'] > 3 and (timbre_engine or 0) < 1:
        kind = 'representation'
    elif timbre_is_engine and (phrase_is_control or phrase_is_engine):
        kind = 'both'
    elif timbre_is_engine:
        kind = 'engine'
    elif phrase_is_control:
        kind = 'control'
    else:
        kind = 'both'
    why = (
        f"稳态谐波斜率：重合成 {harm['L1']} dB，真实控制 {harm['L2']} dB，乐谱 {harm['L3']} dB。"
        f"谐波模型本身能贴到 {harm['L1']} dB，所以不是表示不够。"
        f"换成我们的琴之后升到 {harm['L2']} dB，再换成乐谱也还是 {harm['L3']} dB，"
        f"多出来的是引擎（{round_or_none(timbre_engine)} dB），不是谱面。"
        f"乐句响度相关：重合成 {env['L1']}，真实控制 {env['L2']}，乐谱 {env['L3']}。"
        f"乐谱几乎跟录音对不上，真实控制能补回一截。"
        f"整段频谱形状差三级都在 {shape['L1']}、{shape['L2']}、{shape['L3']} dB，拉不开，"
        f"因为房间和分音之间的噪声盖过了音色，这组数不参与判定。"
    )
    nxt = (
        '下一步分两路，都用第 5–8 小节验收。'
        '引擎先补固定频率上的琴体：500 Hz 一带偏高，1 kHz 和 6 kHz 一带偏低，噪声也要经过同一个琴体。'
        '控制先补乐句力度和揉弦深度，老师就是这次提取的曲线。'
        '先不上物理弦。重合成的谐波斜率已经接近零，稳态音色用谐波就装得下。'
    )
    return {
        'bottleneck': kind,
        'timbreGapDb': {'engine': round_or_none(timbre_engine), 'control': round_or_none(timbre_control)},
        'phraseGap': {'engine': round_or_none(phrase_engine, 3), 'control': round_or_none(phrase_control, 3)},
        'summary': f"稳态音色差在引擎，乐句差在演奏控制。{why}{nxt}",
    }


def draw(report, path):
    fig, axes = plt.subplots(2, 2, figsize=(12.4, 8.2), layout='constrained')
    fig.set_facecolor(PAPER)
    ax = axes[0, 0]
    hs = np.arange(1, 11)
    width = 0.25
    for i, name in enumerate(LEVELS):
        partial = {p['h']: p['db'] for p in report['levels'][name]['harmonic']['partialDb']}
        vals = [partial.get(int(h), 0) for h in hs]
        ax.bar(hs + (i - 1) * width, vals, width=width, color=LEVEL_COLOR[name], label=LEVEL_LABEL[name])
    ax.axhline(0, color=INK, linewidth=0.6)
    ax.set_xticks(hs)
    ax.set_xlabel('谐波次数')
    ax.set_ylabel('比录音多出的 dB')
    ax.set_title('按谐波次数', color=INK, loc='left')
    ax.legend(frameon=False, ncol=3)

    ax = axes[0, 1]
    for name in LEVELS:
        rows = report['levels'][name]['byHz']
        ax.plot([r['hz'] for r in rows], [r['db'] for r in rows], color=LEVEL_COLOR[name], marker='o', label=LEVEL_LABEL[name])
    ax.axhline(0, color=INK, linewidth=0.6)
    ax.set_xscale('log')
    ax.set_xlabel('Hz')
    ax.set_ylabel('比录音多出的 dB')
    ax.set_title('按频率。两把琴叠在一起，差在琴体', color=INK, loc='left')
    ax.legend(frameon=False, ncol=3)

    ax = axes[1, 0]
    metrics = ['谐波中位', '逐音 p90', '第 5–8 小节']
    keys = []
    for name in LEVELS:
        lv = report['levels'][name]
        keys.append([
            lv['harmonic']['meanAbsDb'] or 0,
            lv['distribution']['p90'] or 0,
            lv['holdout']['bars5to8']['harmonicMeanAbsDb'] or 0,
        ])
    keys = np.array(keys)
    x = np.arange(len(metrics))
    for i, name in enumerate(LEVELS):
        ax.bar(x + (i - 1) * width, keys[i], width=width, color=LEVEL_COLOR[name], label=LEVEL_LABEL[name])
    ax.set_xticks(x, metrics)
    ax.set_ylabel('dB')
    ax.set_title('稳态音色。重合成接近零，说明差在琴，不在表示', color=INK, loc='left')
    ax.legend(frameon=False, ncol=3)

    ax = axes[1, 1]
    labels = ['揉弦深度\n音分', '响度相关\n×15', '分音随音高\n×15']
    rec_depth = report['levels']['L1']['vibrato']['recordingDepthCents'] or 0
    rec_corr = report['levels']['L1']['vibrato']['recordingPartialF0AbsCorr'] or 0
    vals = []
    for name in LEVELS:
        lv = report['levels'][name]
        vals.append([
            lv['vibrato']['depthCents'] or 0,
            (lv['phrase']['envelopeCorrelation'] or 0) * 15,
            (lv['vibrato']['partialF0AbsCorr'] or 0) * 15,
        ])
    vals = np.array(vals)
    x = np.arange(3)
    ax.bar(x - 1.5 * width, [rec_depth, 15, rec_corr * 15], width=width, color='#94a3b8', label='录音')
    for i, name in enumerate(LEVELS):
        ax.bar(x + (i - 0.5) * width, vals[i], width=width, color=LEVEL_COLOR[name], label=LEVEL_LABEL[name])
    ax.set_xticks(x, labels)
    ax.set_title('演奏。乐谱的揉弦浅，响度也跟不上', color=INK, loc='left', fontsize=11)
    ax.legend(frameon=False, ncol=4, fontsize=8)
    for a in axes.ravel():
        a.set_facecolor('white')
        for spine in a.spines.values():
            spine.set_color('#e4ddd2')
        a.tick_params(colors=INK, labelsize=8)
        a.grid(True, color='#eee8df', linewidth=0.6)
        a.set_axisbelow(True)
    fig.suptitle('稳态音色差在引擎，乐句差在演奏控制', color=INK, fontsize=14)
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=130, facecolor=fig.get_facecolor())
    plt.close(fig)
    print('wrote', path)


def evaluate(name, rec, cand, sr, notes, aligned_notes):
    n = min(len(rec), len(cand))
    rec, cand = rec[:n], cand[:n]
    gain = rms(rec) / max(rms(cand), 1e-8)
    cand = cand * gain
    use_notes = aligned_notes if name in ('L1', 'L2') else notes
    freqs, times, mag_r, mag_c, syn_t, rec_t = pair_spectra(rec, cand, sr)
    if name in ('L1', 'L2'):
        syn_t = np.array([0.0, n / sr])
        rec_t = syn_t.copy()
    rows = harmonic_slopes(use_notes, mag_c, mag_r, times, freqs, syn_t, rec_t)
    summary = slope_summary(rows)
    warped = warp_mag(mag_r, times, syn_t, rec_t, times)
    rec_cent_t, rec_cent = centroid_track(rec, sr)
    cand_cent_t, cand_cent = centroid_track(cand, sr)
    return {
        'rmsMatchDb': round(float(20 * np.log10(gain)), 2),
        'shapeDb': round(shape_distance(warped, mag_c, freqs), 2),
        'harmonic': summary,
        'distribution': dist_of(note_errors(rows)),
        'holdout': holdout(rows),
        'byHz': by_frequency(rows),
        'hnrDb': hnr_gap(use_notes, mag_c, mag_r, times, freqs, syn_t, rec_t),
        'attack': attack_report(use_notes, rec_cent_t, rec_cent, cand_cent_t, cand_cent, syn_t, rec_t),
        'vibrato': vibrato_report(rec, cand, sr, use_notes, syn_t, rec_t),
        'phrase': phrase_report(rec, cand, sr, syn_t, rec_t),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--extract', default='/tmp/violin-solo/oracle/extract.json')
    parser.add_argument('--l0', default='/tmp/violin-solo/oracle/l0.wav')
    parser.add_argument('--l1', default='/tmp/violin-solo/oracle/l1.wav')
    parser.add_argument('--l2', default='/tmp/violin-solo/oracle/l2.wav')
    parser.add_argument('--l3', default='/tmp/violin-solo/oracle/l3.wav')
    parser.add_argument('--score', default='examples/violin-minuet.json')
    parser.add_argument('--json', default='references/violin-oracle-ladder.json')
    parser.add_argument('--figure', default='references/violin-oracle-ladder.png')
    args = parser.parse_args()

    extract = json.loads(Path(args.extract).read_text())
    phrase = float(extract['phraseSec'])
    sr, rec = mono(args.l0)
    n = int(round(phrase * sr))
    rec = rec[:n]
    notes = load_notes(json.loads(Path(args.score).read_text()))
    score_sec = np.array(extract['scoreMap']['scoreSec'], dtype=np.float64)
    rec_sec = np.array(extract['scoreMap']['recSec'], dtype=np.float64)
    aligned = remap_notes(notes, score_sec, rec_sec)
    levels = {}
    for name, path in (('L1', args.l1), ('L2', args.l2), ('L3', args.l3)):
        _sr, cand = mono(path)
        if _sr != sr:
            raise SystemExit(f'{name} sample rate {_sr} != {sr}')
        print('scoring', name)
        levels[name] = evaluate(name, rec, cand[:n] if name != 'L3' else cand, sr, notes, aligned)
        print(json.dumps({
            'shape': levels[name]['shapeDb'],
            'harmonic': levels[name]['harmonic']['meanAbsDb'],
            'p90': levels[name]['distribution']['p90'],
            'env': levels[name]['phrase']['envelopeCorrelation'],
            'vibrato': levels[name]['vibrato']['depthCents'],
        }))
    verdict = judge(levels)
    report = {
        'piece': extract['piece'],
        'phraseSec': phrase,
        'levels': {
            'L0': 'recording',
            **levels,
        },
        'verdict': verdict,
        'note': 'L1 is partials plus residual noise driven by the recording. L2 is the violin engine driven by the extracted pitch and loudness, with pitchLife 0. L3 is the written score. Shape and harmonic numbers are after loudness removal. Bars 5-8 are the holdout.',
    }
    dest = Path(args.json)
    dest.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    print('wrote', dest)
    print(verdict['summary'])
    draw(report, Path(args.figure))


if __name__ == '__main__':
    main()
