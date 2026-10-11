#!/usr/bin/env python3
"""Images that compare one violin-solo fragment with the current violin.

The number that judges timbre is the harmonic slope after a pitch-class
time warp, with loudness removed. A raw spectrogram difference also charges
the room, the player's rubato, and dynamics the score does not write.

The recording is not in the repo. WAVs stay in /tmp. This does not change
the violin preset.
"""
import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from matplotlib import font_manager
from scipy.signal import welch
from violin_metrics import (
    N_HARM,
    PC_NAMES,
    THIRDS,
    best_lag,
    chroma_from_mag,
    cosine,
    db,
    dtw_path,
    envelope,
    frame_norm,
    harmonic_slopes,
    load_notes,
    mean_chroma,
    mel_filterbank,
    mono,
    path_times,
    rms,
    shape_distance,
    slope_summary,
    stft_mag,
    symbolic_chroma,
    third_octave,
    warp_mag,
)

FONT = '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'
font_manager.fontManager.addfont(FONT)
plt.rcParams['font.family'] = 'WenQuanYi Micro Hei'
plt.rcParams['axes.unicode_minus'] = False

REC = '#1d4e89'
SYN = '#c05621'
INK = '#1c1814'
MUTED = '#8a8175'
PAPER = '#f7f4ef'


def style_ax(ax):
    ax.set_facecolor('white')
    for spine in ax.spines.values():
        spine.set_color('#e4ddd2')
    ax.tick_params(colors=INK, labelsize=9)
    ax.grid(True, color='#eee8df', linewidth=0.6)
    ax.set_axisbelow(True)


def bar_lines(ax, bpm, meter, phrase):
    beat = (60 / bpm) * (4 / meter[1])
    bar = meter[0] * beat
    t = 0.0
    n = 1
    while t <= phrase + 1e-6:
        ax.axvline(t, color='#e4ddd2', linewidth=0.7, zorder=0)
        if ax.get_ylim()[1] > ax.get_ylim()[0]:
            pass
        n += 1
        t = (n - 1) * bar


def save(fig, path):
    fig.savefig(path, dpi=130, facecolor=fig.get_facecolor())
    plt.close(fig)
    print('wrote', path)


def frame_cosine(sym, aud):
    cols = min(sym.shape[1], aud.shape[1])
    if cols < 8:
        return 0.0
    s = frame_norm(sym[:, :cols])
    a = frame_norm(aud[:, :cols])
    return float(np.mean(np.sum(s * a, axis=0)))


def scaled_notes(notes, bpm, score_bpm):
    scale = score_bpm / bpm
    return [{**n, 't': n['t'] * scale, 'dur': n['dur'] * scale} for n in notes]


def align(rec, sr, notes, score_bpm):
    # Frame-wise pitch-class match. A single average chroma stays high anywhere
    # in the same key, so it cannot lock the phrase.
    hop = 1024
    freqs, times, mag = stft_mag(rec, sr, 4096, hop)
    audio = chroma_from_mag(mag, freqs)
    hits = []
    length_cap = rec.size / sr - 0.4
    for bpm in np.arange(96, 144, 1.0):
        length = 24 * (60 / bpm)
        grid = scaled_notes(notes, bpm, score_bpm)
        for offset in np.arange(0.0, min(length_cap - length, 55), 0.1):
            sl = np.where((times >= offset) & (times < offset + length))[0]
            if sl.size < 40:
                continue
            sym = symbolic_chroma(grid, times[sl] - offset)
            hits.append((frame_cosine(sym, audio[:, sl]), float(bpm), float(offset)))
    hits.sort(reverse=True)
    top = hits[:8]
    bpm0, off0 = top[0][1], top[0][2]
    best = top[0]
    for bpm in np.arange(bpm0 - 1.5, bpm0 + 1.51, 0.25):
        length = 24 * (60 / bpm)
        grid = scaled_notes(notes, bpm, score_bpm)
        for offset in np.arange(off0 - 0.3, off0 + 0.301, 0.025):
            sl = np.where((times >= offset) & (times < offset + length))[0]
            if sl.size < 40:
                continue
            sym = symbolic_chroma(grid, times[sl] - offset)
            c = frame_cosine(sym, audio[:, sl])
            if c > best[0]:
                best = (c, float(bpm), float(offset))
    # The written grid, so a regression is visible next to the search peak.
    length = 24 * (60 / score_bpm)
    grid = scaled_notes(notes, score_bpm, score_bpm)
    sl = np.where((times >= 13.3) & (times < 13.3 + length))[0]
    pinned = frame_cosine(symbolic_chroma(grid, times[sl] - 13.3), audio[:, sl])
    return {
        'cosine': best[0],
        'bpm': best[1],
        'offsetSec': best[2],
        'phraseSec': 24 * (60 / best[1]),
        'pinned115': pinned,
        'top': [{'cosine': c, 'bpm': b, 'offsetSec': o} for c, b, o in top],
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--recording', required=True)
    p.add_argument('--synth')
    p.add_argument('--score', required=True)
    p.add_argument('--out')
    p.add_argument('--json')
    p.add_argument('--offset', type=float, default=13.3)
    p.add_argument('--phrase', type=float, default=24 * 60 / 115)
    p.add_argument('--align-only', action='store_true')
    p.add_argument('--slope-only', action='store_true')
    args = p.parse_args()

    score = json.loads(Path(args.score).read_text())
    notes = load_notes(score)
    sr, rec_all = mono(args.recording)
    if args.align_only:
        report = align(rec_all, sr, notes, score['bpm'])
        print(json.dumps(report, indent=2))
        return

    if args.slope_only:
        if not args.synth:
            raise SystemExit('slope-only needs --synth')
    elif not args.synth or not args.out or not args.json:
        raise SystemExit('figures need --synth --out --json')

    sr_s, synth = mono(args.synth)
    if sr_s != sr:
        raise SystemExit(f'sample rate {sr_s} != {sr}')
    n = min(len(rec_all), len(synth))
    # The node script already sliced both to the phrase. Keep that length.
    rec = rec_all[:n]
    synth = synth[:n]
    phrase = n / sr

    gain = rms(rec) / rms(synth)
    synth_m = synth * gain
    # A flat bow envelope will latch onto a few tens of milliseconds that do not
    # move the pitch. Keep the score grid unless a shift actually improves it.
    lag, _lag_corr = best_lag(rec, synth_m, sr)
    synth_a = synth_m

    freqs_c, times_c, mag_r = stft_mag(rec, sr, 4096, 1024)
    _, _, mag_s = stft_mag(synth_a, sr, 4096, 1024)
    m = min(mag_r.shape[1], mag_s.shape[1])
    mag_r, mag_s, times_c = mag_r[:, :m], mag_s[:, :m], times_c[:m]
    pc_r = chroma_from_mag(mag_r, freqs_c)
    pc_s = chroma_from_mag(mag_s, freqs_c)
    pc_y = symbolic_chroma(notes, times_c)
    chroma = {
        'synthVsRecording': cosine(mean_chroma(pc_r), mean_chroma(pc_s)),
        'symbolicVsRecording': cosine(mean_chroma(pc_r), mean_chroma(pc_y)),
        'synthVsSymbolic': cosine(mean_chroma(pc_s), mean_chroma(pc_y)),
        'frameSynthVsRecording': float(np.mean([
            cosine(frame_norm(pc_r)[:, i], frame_norm(pc_s)[:, i]) for i in range(m)
        ])),
    }

    if args.slope_only:
        chroma_hop = 1024
        band_frames = int(round(1.6 * sr / chroma_hop))
        path = dtw_path(frame_norm(pc_s), frame_norm(pc_r), pc_s.sum(0), pc_r.sum(0), band_frames)
        if len(path) < 8:
            raise SystemExit('time warp failed')
        syn_t, rec_t = path_times(path, chroma_hop, sr)
        slopes = harmonic_slopes(notes, mag_s, mag_r, times_c, freqs_c, syn_t, rec_t)
        print(json.dumps(slope_summary(slopes)))
        return

    weights, mel_hz = mel_filterbank(sr, 2048)
    fr, tr, mr = stft_mag(rec, sr, 2048, 512)
    _, ts, ms = stft_mag(synth_a, sr, 2048, 512)
    mm = min(mr.shape[1], ms.shape[1])
    mel_r = weights @ (mr[:, :mm] ** 2)
    mel_s = weights @ (ms[:, :mm] ** 2)
    ref_m = max(mel_r.max(), mel_s.max())
    mel_db_r = db(np.sqrt(mel_r), np.sqrt(ref_m))
    mel_db_s = db(np.sqrt(mel_s), np.sqrt(ref_m))
    voiced = np.maximum(mel_db_r, mel_db_s) > -55
    mel_abs = float(np.mean(np.abs(mel_db_s - mel_db_r)[voiced]))

    te, ee_r = envelope(rec, sr)
    _, ee_s = envelope(synth_a, sr)
    k = min(len(ee_r), len(ee_s))
    env_corr = float(np.corrcoef(ee_r[:k], ee_s[:k])[0, 1])

    th_r = third_octave(rec, sr)
    th_s = third_octave(synth_a, sr)
    th_db = 20 * np.log10((th_s + 1e-12) / (th_r + 1e-12))
    th_mean = float(np.mean(np.abs(th_db)))

    # Timbre: warp on pitch class, then drop loudness. Harmonic peaks ignore
    # the room between partials.
    chroma_hop = 1024
    band_frames = int(round(1.6 * sr / chroma_hop))
    pc_rn, pc_sn = frame_norm(pc_r), frame_norm(pc_s)
    path = dtw_path(pc_sn, pc_rn, pc_s.sum(0), pc_r.sum(0), band_frames)
    if len(path) < 8:
        raise SystemExit('time warp failed')
    syn_t, rec_t = path_times(path, chroma_hop, sr)
    rubato_ms = float(np.median(np.abs(rec_t - syn_t)) * 1000)
    warped_rec = warp_mag(mag_r, times_c, syn_t, rec_t, times_c)
    shape_raw = shape_distance(mag_r, mag_s, freqs_c)
    shape_warp = shape_distance(warped_rec, mag_s, freqs_c)
    slopes = harmonic_slopes(notes, mag_s, mag_r, times_c, freqs_c, syn_t, rec_t)
    slope = slope_summary(slopes)

    shift_n = int(round(0.08 * sr))
    rec_shift = np.concatenate([np.zeros(shift_n), rec[:-shift_n]])
    _, times_sh, mag_sh = stft_mag(rec_shift, sr, 4096, chroma_hop)
    msh = min(mag_r.shape[1], mag_sh.shape[1], len(times_sh))
    pc_sh = chroma_from_mag(mag_sh[:, :msh], freqs_c)
    path_sh = dtw_path(frame_norm(pc_r[:, :msh]), frame_norm(pc_sh), pc_r[:, :msh].sum(0), pc_sh.sum(0), band_frames)
    syn_sh, rec_sh = path_times(path_sh, chroma_hop, sr)
    warped_sh = warp_mag(mag_sh[:, :msh], times_sh[:msh], syn_sh, rec_sh, times_c[:msh])
    identity = np.array([0.0, phrase])
    slopes_grid = harmonic_slopes(notes, mag_s, mag_r, times_c, freqs_c, identity, identity)
    # The shifted file at time t is the recording from t-80ms, so the same
    # moment is 80ms later. That pair should agree if the partial meter is stable.
    slopes_shift = harmonic_slopes(
        notes, mag_r[:, :msh], mag_sh[:, :msh], times_c[:msh], freqs_c, identity, identity + 0.08,
    )
    shift_check = {
        'unwarpedShapeMeanAbsDb': round(shape_distance(mag_r[:, :msh], mag_sh[:, :msh], freqs_c), 2),
        'warpedShapeMeanAbsDb': round(shape_distance(warped_sh, mag_r[:, :msh], freqs_c), 2),
        'harmonicMeanAbsDb': slope_summary(slopes_shift)['meanAbsDb'],
    }
    grid_harmonic = slope_summary(slopes_grid)['meanAbsDb']

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    bpm = score['bpm']
    meter = score.get('meter', [4, 4])
    beat = (60 / bpm) * (4 / meter[1])
    bar = meter[0] * beat

    def marks(ax, ymax=None):
        t = 0.0
        i = 1
        while t < phrase - 1e-3:
            ax.axvline(t, color='#eadfd0', linewidth=0.7, zorder=0)
            if ymax is not None and i <= 8:
                ax.text(t + 0.06, ymax, str(i), color=MUTED, fontsize=8, va='top')
            i += 1
            t += bar

    # 1. waveform + loudness
    fig, axes = plt.subplots(2, 1, figsize=(13.2, 5.4), sharex=True, layout='constrained')
    fig.set_facecolor(PAPER)
    step = 8
    tw = np.arange(0, n, step) / sr
    axes[0].plot(tw, rec[::step], color=REC, alpha=0.55, linewidth=0.6, label='录音')
    axes[0].plot(tw, synth_a[::step], color=SYN, alpha=0.55, linewidth=0.6, label='合成')
    axes[0].set_ylabel('振幅')
    axes[0].set_title('波形（已按整段响度对齐）', color=INK, loc='left')
    axes[0].legend(frameon=False, loc='upper right')
    db_r = 20 * np.log10(ee_r[:k] + 1e-8)
    db_s = 20 * np.log10(ee_s[:k] + 1e-8)
    span_r = float(np.percentile(db_r, 95) - np.percentile(db_r, 5))
    span_s = float(np.percentile(db_s, 95) - np.percentile(db_s, 5))
    axes[1].plot(te[:k], db_r, color=REC, linewidth=1.2, label='录音')
    axes[1].plot(te[:k], db_s, color=SYN, linewidth=1.2, label='合成')
    axes[1].set_ylim(min(np.percentile(db_r, 2), np.percentile(db_s, 2)) - 3,
                     max(np.percentile(db_r, 98), np.percentile(db_s, 98)) + 2)
    axes[1].set_ylabel('短时响度 dB')
    axes[1].set_xlabel('秒')
    axes[1].set_title(
        f'响度包络  相关 {env_corr:.2f}  录音起伏 {span_r:.1f} dB  合成起伏 {span_s:.1f} dB',
        color=INK, loc='left',
    )
    axes[1].legend(frameon=False, loc='upper right')
    for ax in axes:
        style_ax(ax)
        marks(ax)
    axes[0].set_xlim(0, phrase)
    save(fig, out / 'waveform.png')

    # 2. log spectrogram trio
    f2, t2, m2r = stft_mag(rec, sr, 2048, 256)
    _, _, m2s = stft_mag(synth_a, sr, 2048, 256)
    mm2 = min(m2r.shape[1], m2s.shape[1])
    m2r, m2s, t2 = m2r[:, :mm2], m2s[:, :mm2], t2[:mm2]
    ref = max(m2r.max(), m2s.max())
    dbr, dbs = db(m2r, ref), db(m2s, ref)
    diff = np.clip(dbs - dbr, -18, 18)
    fig, axes = plt.subplots(3, 1, figsize=(13.2, 9.2), sharex=True, layout='constrained')
    fig.set_facecolor(PAPER)
    extent = [t2[0], t2[-1], f2[1], f2[-1]]
    for ax, img, title, cmap, vmin, vmax in (
        (axes[0], dbr, '录音  对数频谱', 'magma', -78, 0),
        (axes[1], dbs, '合成  对数频谱', 'magma', -78, 0),
        (axes[2], diff, '未对齐的整段相减（房间、速度、力度都算进去了）', 'RdBu_r', -18, 18),
    ):
        im = ax.imshow(img, origin='lower', aspect='auto', extent=extent, cmap=cmap, vmin=vmin, vmax=vmax, interpolation='nearest')
        ax.set_yscale('log')
        ax.set_ylim(80, 10000)
        ax.set_ylabel('Hz')
        ax.set_title(title, color=INK, loc='left')
        ax.tick_params(colors=INK, labelsize=9)
        fig.colorbar(im, ax=ax, fraction=0.015, pad=0.01)
    axes[2].set_xlabel('秒')
    save(fig, out / 'spectrogram.png')

    # 3. mel pair + difference
    fig, axes = plt.subplots(3, 1, figsize=(13.2, 8.4), sharex=True, layout='constrained')
    fig.set_facecolor(PAPER)
    mel_t = tr[:mm]
    extent = [mel_t[0], mel_t[-1], 0, len(mel_hz)]
    yt = np.linspace(0, len(mel_hz) - 1, 6).astype(int)
    for ax, img, title, cmap, vmin, vmax in (
        (axes[0], mel_db_r, '录音  梅尔频谱', 'magma', -70, 0),
        (axes[1], mel_db_s, '合成  梅尔频谱', 'magma', -70, 0),
        (axes[2], np.clip(mel_db_s - mel_db_r, -18, 18), f'合成减录音  平均绝对差 {mel_abs:.1f} dB', 'RdBu_r', -18, 18),
    ):
        im = ax.imshow(img, origin='lower', aspect='auto', extent=extent, cmap=cmap, vmin=vmin, vmax=vmax, interpolation='nearest')
        ax.set_yticks(yt)
        ax.set_yticklabels([f'{mel_hz[i]:.0f}' for i in yt])
        ax.set_ylabel('Hz')
        ax.set_title(title, color=INK, loc='left')
        ax.tick_params(colors=INK, labelsize=9)
        fig.colorbar(im, ax=ax, fraction=0.015, pad=0.01)
    axes[2].set_xlabel('秒')
    save(fig, out / 'mel.png')

    # 4. chroma
    fig, axes = plt.subplots(3, 1, figsize=(13.2, 7.6), sharex=True, layout='constrained')
    fig.set_facecolor(PAPER)
    extent = [times_c[0], times_c[-1], -0.5, 11.5]
    panels = (
        (frame_norm(pc_y), f'乐谱音级', 'YlOrBr'),
        (frame_norm(pc_r), f'录音音级  与乐谱余弦 {chroma["symbolicVsRecording"]:.2f}', 'YlGnBu'),
        (frame_norm(pc_s), f'合成音级  与录音余弦 {chroma["synthVsRecording"]:.2f}', 'YlOrRd'),
    )
    for ax, img, title, cmap in zip(axes, *zip(*panels)):
        im = ax.imshow(img, origin='lower', aspect='auto', extent=extent, cmap=cmap, vmin=0, vmax=1, interpolation='nearest')
        ax.set_yticks(range(12))
        ax.set_yticklabels(PC_NAMES, fontsize=8)
        ax.set_title(title, color=INK, loc='left')
        ax.tick_params(colors=INK, labelsize=9)
        fig.colorbar(im, ax=ax, fraction=0.015, pad=0.01)
    axes[2].set_xlabel('秒')
    save(fig, out / 'chroma.png')

    # 5. long-term spectrum + third octave
    f_w, p_r = welch(rec, sr, nperseg=4096)
    _, p_s = welch(synth_a, sr, nperseg=4096)
    fig, axes = plt.subplots(2, 1, figsize=(12.2, 7.0), layout='constrained')
    fig.set_facecolor(PAPER)
    band = (f_w >= 70) & (f_w <= 12000)
    axes[0].semilogx(f_w[band], 10 * np.log10(p_r[band] + 1e-16), color=REC, label='录音', linewidth=1.3)
    axes[0].semilogx(f_w[band], 10 * np.log10(p_s[band] + 1e-16), color=SYN, label='合成', linewidth=1.3)
    axes[0].set_ylabel('功率 dB')
    axes[0].set_title('长时频谱', color=INK, loc='left')
    axes[0].legend(frameon=False)
    style_ax(axes[0])
    colors = [SYN if v >= 0 else REC for v in th_db]
    axes[1].bar([str(h) for h in THIRDS], th_db, color=colors, width=0.72)
    axes[1].axhline(0, color=INK, linewidth=0.6)
    axes[1].set_ylabel('合成减录音 dB')
    axes[1].set_xlabel('三分之一倍频程中心 Hz')
    axes[1].set_title(f'300 Hz–8 kHz  平均绝对差 {th_mean:.1f} dB', color=INK, loc='left')
    axes[1].tick_params(axis='x', labelrotation=45, colors=INK, labelsize=8)
    style_ax(axes[1])
    save(fig, out / 'spectrum.png')

    # 6. bar 8 zoom
    t0 = 7 * bar
    i0, i1 = int(t0 * sr), n
    fig, axes = plt.subplots(3, 1, figsize=(12.2, 7.4), layout='constrained')
    fig.set_facecolor(PAPER)
    sl = slice(i0, i1)
    tt = np.arange(i0, i1) / sr
    axes[0].plot(tt, rec[sl], color=REC, alpha=0.7, linewidth=0.7, label='录音')
    axes[0].plot(tt, synth_a[sl], color=SYN, alpha=0.7, linewidth=0.7, label='合成')
    axes[0].set_title('第八小节  升F5 与 B4', color=INK, loc='left')
    axes[0].legend(frameon=False, loc='upper right')
    axes[0].set_ylabel('振幅')
    style_ax(axes[0])
    zf, zt, zr = stft_mag(rec[sl], sr, 2048, 256)
    _, _, zs = stft_mag(synth_a[sl], sr, 2048, 256)
    mz = min(zr.shape[1], zs.shape[1])
    zref = max(zr[:, :mz].max(), zs[:, :mz].max())
    for ax, mag, title in (
        (axes[1], zr[:, :mz], '录音'),
        (axes[2], zs[:, :mz], '合成'),
    ):
        im = ax.imshow(
            db(mag, zref), origin='lower', aspect='auto',
            extent=[t0 + zt[0], t0 + zt[mz - 1], zf[1], zf[-1]],
            cmap='magma', vmin=-78, vmax=0, interpolation='nearest',
        )
        ax.set_yscale('log')
        ax.set_ylim(150, 8000)
        ax.set_title(title, color=INK, loc='left')
        ax.set_ylabel('Hz')
        ax.tick_params(colors=INK, labelsize=9)
        fig.colorbar(im, ax=ax, fraction=0.02, pad=0.01)
    axes[2].set_xlabel('秒')
    save(fig, out / 'bar8.png')

    # Timbre on the score clock: recording frames follow the pitch-class warp.
    f_img, t_img, mag_img_r = stft_mag(rec, sr, 2048, 256)
    _, _, mag_img_s = stft_mag(synth_a, sr, 2048, 256)
    mt = min(mag_img_r.shape[1], mag_img_s.shape[1], len(t_img))
    mag_img_r, mag_img_s, t_img = mag_img_r[:, :mt], mag_img_s[:, :mt], t_img[:mt]
    mag_img_w = warp_mag(mag_img_r, t_img, syn_t, rec_t, t_img)
    band = (f_img >= 180) & (f_img <= 8000)
    def centered(mag):
        spec = 20 * np.log10(mag[band] + 1e-10)
        return spec - np.median(spec, axis=0, keepdims=True)
    shape_r = centered(mag_img_w)
    shape_s = centered(mag_img_s)
    shape_diff = np.clip(shape_s - shape_r, -12, 12)
    show_r = db(mag_img_w, max(mag_img_w.max(), mag_img_s.max()))
    show_s = db(mag_img_s, max(mag_img_w.max(), mag_img_s.max()))
    fig, axes = plt.subplots(3, 1, figsize=(13.2, 9.2), sharex=True, layout='constrained')
    fig.set_facecolor(PAPER)
    extent = [t_img[0], t_img[-1], f_img[band][0], f_img[band][-1]]
    panels = (
        (show_r[band], '录音  已对齐到乐谱', 'magma', -78, 0),
        (show_s[band], '合成  乐谱格子', 'magma', -78, 0),
        (shape_diff, f'去掉响度后的形状差  {shape_warp:.1f} dB（未对齐 {shape_raw:.1f} dB）', 'RdBu_r', -12, 12),
    )
    for ax, (img, title, cmap, vmin, vmax) in zip(axes, panels):
        im = ax.imshow(img, origin='lower', aspect='auto', extent=extent, cmap=cmap, vmin=vmin, vmax=vmax, interpolation='nearest')
        ax.set_yscale('log')
        ax.set_ylim(180, 8000)
        ax.set_ylabel('Hz')
        ax.set_title(title, color=INK, loc='left')
        ax.tick_params(colors=INK, labelsize=9)
        fig.colorbar(im, ax=ax, fraction=0.015, pad=0.01)
    axes[2].set_xlabel('秒')
    fig.suptitle(f'音级对齐  演奏相对格子的中位偏移 {rubato_ms:.0f} ms', color=INK, fontsize=13)
    save(fig, out / 'aligned_shape.png')

    fig, axes = plt.subplots(2, 1, figsize=(11.5, 7.2), layout='constrained')
    fig.set_facecolor(PAPER)
    hs = np.arange(1, N_HARM + 1)
    for r in slopes:
        axes[0].plot(hs, r['rec'], color=REC, alpha=0.18, linewidth=0.8)
        axes[0].plot(hs, r['syn'], color=SYN, alpha=0.18, linewidth=0.8)
    med_r = np.nanmedian(np.stack([r['rec'] for r in slopes]), axis=0) if slopes else np.full(N_HARM, np.nan)
    med_s = np.nanmedian(np.stack([r['syn'] for r in slopes]), axis=0) if slopes else np.full(N_HARM, np.nan)
    axes[0].plot(hs, med_r, color=REC, linewidth=2.2, label='录音中位')
    axes[0].plot(hs, med_s, color=SYN, linewidth=2.2, label='合成中位')
    axes[0].set_xticks(hs)
    axes[0].set_xlabel('谐波次数')
    axes[0].set_ylabel('相对最强谐波 dB')
    axes[0].set_title(
        f'谐波斜率  中位绝对差 {slope["meanAbsDb"]} dB  （{slope["notes"]} 个音，短于八分的不算）',
        color=INK, loc='left',
    )
    axes[0].legend(frameon=False)
    style_ax(axes[0])
    labels = [str(p['h']) for p in slope['partialDb']]
    vals = [p['db'] for p in slope['partialDb']]
    axes[1].bar(labels, vals, color=[SYN if v >= 0 else REC for v in vals], width=0.72)
    axes[1].axhline(0, color=INK, linewidth=0.6)
    axes[1].set_xlabel('谐波次数')
    axes[1].set_ylabel('合成减录音 dB')
    axes[1].set_title('同一谐波上，合成比录音多多少', color=INK, loc='left')
    style_ax(axes[1])
    save(fig, out / 'harmonic_slope.png')

    fig, ax = plt.subplots(figsize=(10.5, 4.6), layout='constrained')
    fig.set_facecolor(PAPER)
    names = [
        '同一录音\n平移 80 ms\n整段相减',
        '同一录音\n平移后再对齐',
        '同一录音\n谐波斜率',
        '合成对录音\n谐波斜率',
    ]
    heights = [
        shift_check['unwarpedShapeMeanAbsDb'],
        shift_check['warpedShapeMeanAbsDb'],
        shift_check['harmonicMeanAbsDb'] or 0,
        slope['meanAbsDb'] or 0,
    ]
    colors = ['#9a3412', '#0f766e', '#0f766e', SYN]
    ax.bar(names, heights, color=colors, width=0.72)
    for i, v in enumerate(heights):
        ax.text(i, v + 0.25, f'{v:.1f} dB', ha='center', color=INK, fontsize=11)
    ax.set_ylabel('平均绝对差 dB')
    ax.set_ylim(0, max(heights) * 1.25)
    ax.set_title('同一段录音平移 80 ms，旧的整段相减仍报很大的差', color=INK, loc='left')
    style_ax(ax)
    save(fig, out / 'method_check.png')

    report = {
        'piece': 'J.S. Bach, Violin Partita No. 3 BWV 1006, Menuet I, bars 1-8',
        'recording': {
            'file': 'Partita_No.3_J.S.Bach_(Minuet_1).ogg',
            'url': 'https://commons.wikimedia.org/wiki/File:Partita_No.3_J.S.Bach_(Minuet_1).ogg',
            'author': 'Vicond',
            'license': 'CC BY 3.0',
            'offsetSec': args.offset,
            'phraseSec': round(phrase, 4),
        },
        'score': 'examples/violin-minuet.json',
        'bpm': bpm,
        'rmsMatchDb': round(20 * np.log10(gain), 2),
        'envelopeLagSec': round(lag, 4),
        'lagApplied': False,
        'loudnessSpanDb': {'recording': round(span_r, 2), 'synth': round(span_s, 2)},
        'chroma': {k: round(v, 4) for k, v in chroma.items()},
        'melMeanAbsDb': round(mel_abs, 2),
        'envelopeCorrelation': round(env_corr, 4),
        'thirdOctaveMeanAbsDb': round(th_mean, 2),
        'thirdOctaveDb': [{'hz': hz, 'db': round(float(v), 2)} for hz, v in zip(THIRDS, th_db)],
        'timbre': {
            'warpedShapeMeanAbsDb': round(shape_warp, 2),
            'unwarpedShapeMeanAbsDb': round(shape_raw, 2),
            'rubatoMedianMs': round(rubato_ms, 1),
            'harmonic': slope,
            'gridHarmonicMeanAbsDb': grid_harmonic,
            'shift80ms': shift_check,
        },
        'note': 'Timbre is the harmonic slope after a pitch-class time warp, with per-frame loudness removed. melMeanAbsDb, the envelope correlation, and the third-octave bars also charge the room, rubato, and dynamics the score does not write. shift80ms is the same recording delayed by 80 ms: the unwarped shape distance moves, the warped one should stay small. The body, bow, and seed were not refit.',
    }
    Path(args.json).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report['timbre'], indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
