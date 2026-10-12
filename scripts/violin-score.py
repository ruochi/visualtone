#!/usr/bin/env python3
"""Violin scorecard: one number per dimension, one total, and a rule for progress.

    PYTHONPATH=scripts python3 scripts/violin-score.py            # score dist/, compare to the baseline
    PYTHONPATH=scripts python3 scripts/violin-score.py --accept   # same, and keep it if it counts as progress
    PYTHONPATH=scripts python3 scripts/violin-score.py --init     # freeze the anchors and the first baseline
    PYTHONPATH=scripts python3 scripts/violin-score.py --root /tmp/old-checkout --label old

Each metric is an error against the recording. 0 points is what a textbook
sawtooth reaches when it plays the written notes with no vibrato, no body,
and no bow. 100 points is no error. The anchors are frozen in
references/violin-score.json so later runs share one ruler.

Only music the preset was not fitted on decides: menuet bars 5–8, and the
gavotte theme by the same player. Menuet bars 1–4 are reported, never decide.
Every candidate is rendered with several seeds. The spread between seeds is
the noise; a change has to beat it.

Exit status: 0 progress, 1 no clear change, 2 regression.
"""
import argparse
import importlib.util
import json
import shutil
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from scipy.io import wavfile

from violin_metrics import harmonic_slopes, load_notes, midi_hz, mono, rms, slope_summary

ROOT = Path(__file__).resolve().parent.parent
CARD = ROOT / 'references/violin-score.json'
WORK = Path('/tmp/violin-score')
SEEDS = (1006, 7, 23, 101, 2024)

PIECES = {
    'menuet': {
        'title': '小步舞曲 I 前八小节',
        'recording': '/tmp/violin-solo/minuet.wav',
        'url': 'https://commons.wikimedia.org/wiki/Special:FilePath/Partita_No.3_J.S.Bach_(Minuet_1).ogg',
        'offsetSec': 13.3,
        'score': 'examples/violin-minuet.json',
        'splits': {'fit': (1, 4), 'check': (5, 8)},
    },
    'gavotte': {
        'title': '加沃特回旋曲主题',
        'recording': '/tmp/violin-solo/ext/gavotte.wav',
        'url': 'https://commons.wikimedia.org/wiki/Special:FilePath/J.S.Bach_partita_No.3_Gavotte_in_Rondeau.ogg',
        'offsetSec': 0.25,
        'score': 'examples/violin-gavotte-theme.json',
        'splits': {'unseen': (1, 99)},
    },
}
DECIDING = (('menuet', 'check'), ('gavotte', 'unseen'))

# Dimension, weight, and the metrics it averages. Each metric is an error, 0 is perfect.
DIMENSIONS = (
    ('harmonic', '谐波斜率', 20, ('harmonicDb',)),
    ('body', '琴体', 15, ('bodyDb',)),
    ('worst', '最差的音', 10, ('worstNoteDb',)),
    ('noise', '弓噪', 10, ('hnrGapDb',)),
    ('attack', '起音', 10, ('attackCents',)),
    ('vibrato', '揉弦', 10, ('vibratoDepthCents',)),
    ('pitch', '音准', 5, ('intonationCents',)),
    ('phrase', '乐句', 20, ('envelopeMiss', 'loudnessSpanDb')),
)

PROGRESS_MIN = 1.0
DIMENSION_DROP = 5.0
TRANSFER_DROP = 2.0


def load_eval():
    path = Path(__file__).with_name('violin-eval.py')
    spec = importlib.util.spec_from_file_location('violin_eval', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def fetch(piece):
    wav = Path(piece['recording'])
    if wav.exists():
        return
    wav.parent.mkdir(parents=True, exist_ok=True)
    ogg = wav.with_suffix('.ogg')
    if not ogg.exists():
        subprocess.check_call(['curl', '-sSL', '-A', 'visualtone-score/1.0', '-o', str(ogg), piece['url']])
    subprocess.check_call([
        'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', str(ogg), '-ac', '1', '-ar', '48000', str(wav),
    ])


def piece_notes(score_path):
    return load_notes(json.loads(Path(score_path).read_text()))


def phrase_sec(notes):
    return max(n['t'] + n['dur'] for n in notes)


_REC = {}


def recording(name):
    if name not in _REC:
        piece = PIECES[name]
        sr, x = mono(piece['recording'])
        i0 = int(round(piece['offsetSec'] * sr))
        _REC[name] = (sr, x[i0:])
    return _REC[name]


def frame_f0(frame, sr, midi):
    spec = np.abs(np.fft.rfft(frame * np.hanning(len(frame))))
    df = sr / len(frame)
    grid = midi_hz(midi) * 2 ** (np.linspace(-80, 80, 81) / 1200)
    best, best_s = None, -1e9
    for f0 in grid:
        s = w = 0.0
        for h in range(1, 6):
            i = int(round(f0 * h / df))
            if i < 1 or i >= len(spec) - 1:
                continue
            s += np.log(spec[i] + 1e-12) / h
            w += 1 / h
        if w > 0 and s / w > best_s:
            best_s, best = s / w, float(f0)
    return best


def intonation(rec, cand, sr, notes, syn_t, rec_t):
    """Median |cents| between the held pitch of each note in the two takes.

    The recording is not tuned to A440, so the shared offset comes out first.
    """
    win = int(0.06 * sr)
    hop = int(0.02 * sr)
    errs = []
    for n in notes:
        if n['dur'] < 0.2:
            continue
        a, b = n['t'] + 0.25 * n['dur'], n['t'] + 0.75 * n['dur']
        ra, rb = np.interp([a, b], syn_t, rec_t)

        def held(x, t0, t1):
            got = []
            i = int(t0 * sr)
            while i + win <= min(int(t1 * sr), len(x)):
                f = frame_f0(x[i:i + win], sr, n['midi'])
                if f:
                    got.append(f)
                i += hop
            return float(np.median(got)) if len(got) >= 3 else None

        fc, fr = held(cand, a, b), held(rec, ra, max(rb, ra + 0.08))
        if fc and fr:
            errs.append(1200 * np.log2(fc / fr))
    if len(errs) < 3:
        return None
    errs = np.array(errs)
    return float(np.median(np.abs(errs - np.median(errs))))


def vibrato_miss(ev, rec, cand, sr, notes, syn_t, rec_t):
    """Median per-note |depth difference|, in cents.

    The player leans into long notes and leaves some short ones plain. A signed
    median lets those cancel, so each note is compared on its own.
    """
    miss = []
    for n in notes:
        v = ev.vibrato_report(rec, cand, sr, [n], syn_t, rec_t)
        if v['depthCents'] is not None and v['recordingDepthCents'] is not None:
            miss.append(abs(v['depthCents'] - v['recordingDepthCents']))
    return float(np.median(miss)) if len(miss) >= 3 else None


def phrase_window(rec, cand, sr, syn_t, rec_t, t0, t1, ev):
    te, ee_r = ev.envelope(rec, sr)
    tc, ee_c = ev.envelope(cand, sr)
    mapped = np.interp(tc, syn_t, rec_t)
    ee_w = np.interp(mapped, te, ee_r)
    on = (tc >= t0) & (tc <= t1)
    if int(on.sum()) < 8:
        return None, None
    c, w = ee_c[on], ee_w[on]
    corr = float(np.corrcoef(c, w)[0, 1])

    def span(e):
        d = 20 * np.log10(e + 1e-8)
        return float(np.percentile(d, 95) - np.percentile(d, 5))

    return (None if not np.isfinite(corr) else 1 - corr), abs(span(c) - span(w))


def measure_pair(rec, cand, sr, notes, splits):
    ev = load_eval()
    n = int(round(phrase_sec(notes) * sr))
    rec = rec[:n]
    cand = cand[:n]
    if len(cand) < n:
        cand = np.pad(cand, (0, n - len(cand)))
    cand = cand * (rms(rec) / max(rms(cand), 1e-8))
    freqs, times, mag_r, mag_c, syn_t, rec_t = ev.pair_spectra(rec, cand, sr)
    rows = harmonic_slopes(notes, mag_c, mag_r, times, freqs, syn_t, rec_t)
    out = {}
    for split, (lo, hi) in splits.items():
        sub_notes = [x for x in notes if lo <= x['bar'] <= hi]
        sub_rows = [r for r in rows if lo <= r.get('bar', 0) <= hi]
        by_hz = ev.by_frequency(sub_rows)
        note_err = ev.note_errors(sub_rows)
        hnr = [b['db'] for b in ev.hnr_gap(sub_notes, mag_c, mag_r, times, freqs, syn_t, rec_t) if b['db'] is not None]
        rc_t, rc = ev.centroid_track(rec, sr)
        cc_t, cc = ev.centroid_track(cand, sr)
        att = ev.attack_report(sub_notes, rc_t, rc, cc_t, cc, syn_t, rec_t)
        vib = vibrato_miss(ev, rec, cand, sr, sub_notes, syn_t, rec_t)
        t0 = min(x['t'] for x in sub_notes)
        t1 = max(x['t'] + x['dur'] for x in sub_notes)
        miss, span = phrase_window(rec, cand, sr, syn_t, rec_t, t0, t1, ev)
        metrics = {
            'harmonicDb': slope_summary(sub_rows)['meanAbsDb'],
            'bodyDb': float(np.mean([abs(b['db']) for b in by_hz])) if by_hz else None,
            'worstNoteDb': float(np.percentile(note_err, 90)) if len(note_err) else None,
            'hnrGapDb': float(np.mean(np.abs(hnr))) if hnr else None,
            'attackCents': att['centroid30MsCents'],
            'vibratoDepthCents': vib,
            'intonationCents': intonation(rec, cand, sr, sub_notes, syn_t, rec_t),
            'envelopeMiss': miss,
            'loudnessSpanDb': span,
        }
        out[split] = {
            'metrics': {k: None if v is None else round(float(v), 3) for k, v in metrics.items()},
            'notesScored': len(sub_rows),
            'notesWritten': len(sub_notes),
        }
    return out


def measure_wav(job):
    name, wav, score_path = job
    piece = PIECES[name]
    notes = piece_notes(score_path)
    sr, rec = recording(name)
    _sr, cand = mono(wav)
    if _sr != sr:
        raise SystemExit(f'{wav}: sample rate {_sr} != {sr}')
    return name, wav, measure_pair(rec, cand, sr, notes, piece['splits'])


def naive_take(notes, sr):
    """Sawtooth partials at the written pitch and size. No vibrato, body, bow, or room."""
    n = int(round((phrase_sec(notes) + 0.5) * sr))
    out = np.zeros(n)
    fade = int(0.01 * sr)
    for x in notes:
        i0 = int(round(x['t'] * sr))
        m = int(round(x['dur'] * sr))
        t = np.arange(m) / sr
        f0 = midi_hz(x['midi'])
        tone = np.zeros(m)
        for h in range(1, 21):
            if f0 * h > 0.45 * sr:
                break
            tone += np.sin(2 * np.pi * f0 * h * t) / h
        env = np.ones(m)
        k = min(fade, m // 2)
        env[:k] = np.linspace(0, 1, k)
        env[m - k:] = np.linspace(1, 0, k)
        out[i0:i0 + m] += tone * env * x['size']
    return out


def self_take(rec, sr):
    return np.concatenate([np.zeros(int(0.08 * sr)), rec])


def to_points(metrics, anchors):
    pts = {}
    for key, value in metrics.items():
        a = anchors.get(key)
        if value is None or a is None or a <= 1e-9:
            pts[key] = None
            continue
        pts[key] = float(100 * np.clip(1 - value / a, 0, 1))
    dims = {}
    for key, _label, _w, keys in DIMENSIONS:
        got = [pts[k] for k in keys if pts.get(k) is not None]
        dims[key] = float(np.mean(got)) if got else None
    num = sum(w * dims[k] for k, _l, w, _m in DIMENSIONS if dims[k] is not None)
    den = sum(w for k, _l, w, _m in DIMENSIONS if dims[k] is not None)
    return {'total': num / den if den else None, 'dims': dims, 'points': pts}


def summarize(takes, anchors):
    """takes: list of {split: {'metrics': ...}} for one piece, one per seed."""
    out = {}
    for split in takes[0]:
        scored = [to_points(t[split]['metrics'], anchors[split]) for t in takes]
        totals = np.array([s['total'] for s in scored], dtype=float)
        dims = {}
        for key, *_ in DIMENSIONS:
            vals = np.array([s['dims'][key] for s in scored if s['dims'][key] is not None], dtype=float)
            dims[key] = {
                'mean': round(float(vals.mean()), 2) if len(vals) else None,
                'sd': round(float(vals.std(ddof=1)), 2) if len(vals) > 1 else 0.0,
                'seeds': [None if s['dims'][key] is None else round(float(s['dims'][key]), 2) for s in scored],
            }
        metrics = {}
        for key in takes[0][split]['metrics']:
            vals = [t[split]['metrics'][key] for t in takes if t[split]['metrics'][key] is not None]
            metrics[key] = round(float(np.mean(vals)), 3) if vals else None
        out[split] = {
            'total': round(float(totals.mean()), 2),
            'totalSd': round(float(totals.std(ddof=1)), 2) if len(totals) > 1 else 0.0,
            'seedTotals': [round(float(t), 2) for t in totals],
            'dims': dims,
            'metrics': metrics,
            'notesScored': takes[0][split]['notesScored'],
            'notesWritten': takes[0][split]['notesWritten'],
        }
    return out


def diff_se(b, c, n):
    """Standard error of the mean difference. Same seeds are paired."""
    bs, cs = b.get('seeds') or b.get('seedTotals'), c.get('seeds') or c.get('seedTotals')
    if bs and cs and len(bs) == len(cs) and None not in bs and None not in cs:
        d = np.array(cs, dtype=float) - np.array(bs, dtype=float)
        return float(d.std(ddof=1) / np.sqrt(len(d)))
    b_sd = b.get('totalSd', b.get('sd', 0.0))
    c_sd = c.get('totalSd', c.get('sd', 0.0))
    return float(np.sqrt(b_sd ** 2 + c_sd ** 2) / np.sqrt(n))


def decide(base, cand, n_seeds):
    lines = []
    m_b, m_c = base['menuet']['check'], cand['menuet']['check']
    g_b, g_c = base['gavotte']['unseen'], cand['gavotte']['unseen']
    f_b, f_c = base['menuet']['fit'], cand['menuet']['fit']
    d_check = m_c['total'] - m_b['total']
    bar_check = max(PROGRESS_MIN, 2 * diff_se(m_b, m_c, n_seeds))
    d_transfer = g_c['total'] - g_b['total']
    bar_transfer = max(TRANSFER_DROP, 2 * diff_se(g_b, g_c, n_seeds))
    d_fit = f_c['total'] - f_b['total']
    bar_fit = max(PROGRESS_MIN, 2 * diff_se(f_b, f_c, n_seeds))
    dropped = []
    for key, label, _w, _m in DIMENSIONS:
        b, c = m_b['dims'][key], m_c['dims'][key]
        if b['mean'] is None or c['mean'] is None:
            continue
        bar = max(DIMENSION_DROP, 2 * diff_se(b, c, n_seeds))
        if c['mean'] - b['mean'] < -bar:
            dropped.append(f'{label} {c["mean"] - b["mean"]:+.1f}')
    lines.append(f'第 5–8 小节 {d_check:+.2f}（门槛 ±{bar_check:.2f}）')
    lines.append(f'加沃特 {d_transfer:+.2f}（允许下降 {bar_transfer:.2f}）')
    lines.append(f'前四小节 {d_fit:+.2f}，只作参考')
    if d_check < -bar_check:
        verdict = 'regression'
    elif d_transfer < -bar_transfer:
        verdict = 'regression'
        lines.append('加沃特变差，换一首曲子就不成立')
    elif dropped:
        verdict = 'regression'
        lines.append('有维度掉得太多：' + '，'.join(dropped))
    elif d_check > bar_check:
        verdict = 'progress'
    else:
        verdict = 'flat'
    if d_check <= bar_check and d_fit > bar_fit:
        lines.append('只在拟合用的前四小节上涨，像过拟合')
    return verdict, lines


VERDICT_ZH = {'progress': '进步', 'flat': '持平', 'regression': '退步'}


def print_card(cand, base):
    for name, piece in PIECES.items():
        for split in piece['splits']:
            c = cand[name][split]
            b = base[name][split] if base else None
            head = f"{piece['title']} {split_label(split)}：{c['total']:.1f} ± {c['totalSd']:.1f}"
            if b:
                head += f"（基线 {b['total']:.1f}）"
            print(head + f"  打分音 {c['notesScored']}/{c['notesWritten']}")
            for key, label, w, _m in DIMENSIONS:
                d = c['dims'][key]
                if d['mean'] is None:
                    print(f'  {label:<5} 无')
                    continue
                tail = ''
                if b and b['dims'][key]['mean'] is not None:
                    tail = f"  {d['mean'] - b['dims'][key]['mean']:+.1f}"
                print(f"  {label:<5} {d['mean']:5.1f} ± {d['sd']:.1f}  权重 {w}{tail}")


def split_label(split):
    return {'fit': '前四小节（拟合）', 'check': '第 5–8 小节（验收）', 'unseen': '（未参与拟合）'}[split]


def draw(card, cand, label, path):
    import matplotlib

    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib import font_manager

    font = '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'
    font_manager.fontManager.addfont(font)
    plt.rcParams['font.family'] = 'WenQuanYi Micro Hei'
    plt.rcParams['axes.unicode_minus'] = False
    base = card.get('baseline')
    panels = [('menuet', 'check'), ('gavotte', 'unseen'), ('menuet', 'fit')]
    fig, axes = plt.subplots(1, 4, figsize=(17, 4.8), layout='constrained',
                             gridspec_kw={'width_ratios': [3, 3, 3, 2.2]})
    fig.set_facecolor('#f7f4ef')
    labels = [lab for _k, lab, _w, _m in DIMENSIONS]
    y = np.arange(len(DIMENSIONS))
    for ax, (name, split) in zip(axes, panels):
        c = cand[name][split]
        vals = [c['dims'][k]['mean'] or 0 for k, *_ in DIMENSIONS]
        errs = [c['dims'][k]['sd'] or 0 for k, *_ in DIMENSIONS]
        if base and base['pieces'] is not cand:
            b = base['pieces'][name][split]
            ax.barh(y + 0.2, [b['dims'][k]['mean'] or 0 for k, *_ in DIMENSIONS], 0.4,
                    color='#cbd5e1', label=f"基线 {b['total']:.1f}")
        ax.barh(y - 0.2, vals, 0.4, xerr=errs, color='#1d4e89', ecolor='#64748b', label=f"{label} {c['total']:.1f}")
        ax.set_yticks(y, labels)
        ax.invert_yaxis()
        ax.set_xlim(0, 100)
        ax.set_title(f"{PIECES[name]['title']} {split_label(split)}", loc='left', fontsize=10)
        ax.legend(frameon=False, fontsize=8, loc='lower right')
    ax = axes[3]
    hist = card.get('history', [])
    if hist:
        xs = np.arange(len(hist))
        ax.plot(xs, [h['menuetCheck'] for h in hist], marker='o', color='#1d4e89', label='第 5–8 小节')
        ax.plot(xs, [h['gavotte'] for h in hist], marker='s', color='#c05621', label='加沃特')
        ax.plot(xs, [h['menuetFit'] for h in hist], marker='^', color='#94a3b8', label='前四小节')
        ticks = [f"{h['label']}\n{VERDICT_ZH.get(h['verdict'], '基线')}" for h in hist]
        ax.set_xticks(xs, ticks, fontsize=8)
        ax.set_ylim(0, 100)
        ax.legend(frameon=False, fontsize=8)
    ax.set_title('历次总分', loc='left', fontsize=10)
    for a in axes:
        a.set_facecolor('white')
        a.grid(True, axis='x', color='#eee8df')
        a.set_axisbelow(True)
    fig.suptitle('小提琴打分卡  0 = 按谱演奏的锯齿波  100 = 和录音一样', fontsize=13)
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=120, facecolor=fig.get_facecolor())
    plt.close(fig)
    print('wrote', path)


def render_takes(root, label, seeds):
    WORK.mkdir(parents=True, exist_ok=True)
    jobs = []
    for name, piece in PIECES.items():
        score = root / piece['score']
        if not score.exists():
            score = ROOT / piece['score']
        subprocess.check_call([
            'node', str(ROOT / 'scripts/violin-score-render.mjs'), str(score), str(WORK), f'{label}-{name}',
            *[str(s) for s in seeds], '--dist', str(root / 'dist'),
        ], stdout=subprocess.DEVNULL)
        for s in seeds:
            jobs.append((name, str(WORK / f'{label}-{name}-{s}.wav'), str(score)))
    return jobs


def score_jobs(jobs, workers):
    with ProcessPoolExecutor(max_workers=workers) as pool:
        got = list(pool.map(measure_wav, jobs))
    by_piece = {name: [] for name in PIECES}
    for name, _wav, splits in got:
        by_piece[name].append(splits)
    return by_piece


def freeze_anchors():
    anchors, self_check = {}, {}
    for name, piece in PIECES.items():
        notes = piece_notes(ROOT / piece['score'])
        sr, rec = recording(name)
        print('anchor', name)
        anchors[name] = {s: v['metrics'] for s, v in
                         measure_pair(rec, naive_take(notes, sr), sr, notes, piece['splits']).items()}
        self_check[name] = {s: v['metrics'] for s, v in
                            measure_pair(rec, self_take(rec, sr), sr, notes, piece['splits']).items()}
    return anchors, self_check


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default=str(ROOT), help='checkout whose dist/ and examples/ are scored')
    parser.add_argument('--label', default='now')
    parser.add_argument('--commit', default=None)
    parser.add_argument('--init', action='store_true', help='freeze anchors and take this run as the baseline')
    parser.add_argument('--accept', action='store_true', help='keep this run as the baseline if it is progress')
    parser.add_argument('--history', action='store_true', help='append this run to the history without judging')
    parser.add_argument('--workers', type=int, default=3)
    parser.add_argument('--figure', default=str(WORK / 'score.png'))
    args = parser.parse_args()

    for piece in PIECES.values():
        fetch(piece)
    root = Path(args.root).resolve()
    commit = args.commit or subprocess.run(
        ['git', '-C', str(root), 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip()
    card = json.loads(CARD.read_text()) if CARD.exists() else {}

    if args.init or 'anchors' not in card:
        anchors, self_check = freeze_anchors()
        card = {
            'about': __doc__.strip().split('\n\n')[2].replace('\n', ' '),
            'seeds': list(SEEDS),
            'weights': {k: w for k, _l, w, _m in DIMENSIONS},
            'dimensions': {k: {'label': lab, 'metrics': list(m)} for k, lab, _w, m in DIMENSIONS},
            'rule': {
                'deciding': ['menuet bars 5-8', 'gavotte theme'],
                'progressMinPoints': PROGRESS_MIN,
                'dimensionDropPoints': DIMENSION_DROP,
                'transferDropPoints': TRANSFER_DROP,
                'noise': 'Twice the standard error of the per-seed difference (same seeds paired), when that is larger.',
            },
            'anchors': anchors,
            'selfCheck': {name: {s: to_points(m, anchors[name][s])['total'] for s, m in v.items()}
                          for name, v in self_check.items()},
            'history': [],
        }
        print('self check', json.dumps(card['selfCheck']))

    jobs = render_takes(root, args.label, SEEDS)
    takes = score_jobs(jobs, args.workers)
    cand = {name: summarize(takes[name], card['anchors'][name]) for name in PIECES}
    base = card.get('baseline')
    print_card(cand, base['pieces'] if base and not args.init else None)

    entry = {
        'label': args.label,
        'commit': commit,
        'menuetCheck': cand['menuet']['check']['total'],
        'gavotte': cand['gavotte']['unseen']['total'],
        'menuetFit': cand['menuet']['fit']['total'],
    }
    status = 1

    def remember(e):
        card['history'] = [h for h in card['history'] if (h['label'], h['commit']) != (e['label'], e['commit'])]
        card['history'].append(e)

    if args.init or not base:
        card['baseline'] = {'label': args.label, 'commit': commit, 'pieces': cand}
        entry['verdict'] = 'baseline'
        remember(entry)
        status = 0
        print('基线已建立')
    else:
        verdict, lines = decide(base['pieces'], cand, len(SEEDS))
        print(f"结论：{VERDICT_ZH[verdict]}（对比基线 {base['label']} {base['commit']}）")
        for line in lines:
            print('  ' + line)
        last = card['history'][-1] if card.get('history') else None
        if last and last['label'] != base['label']:
            print(f"  相对最新一版 {last['label']}：第 5–8 小节 {entry['menuetCheck'] - last['menuetCheck']:+.2f}，"
                  f"加沃特 {entry['gavotte'] - last['gavotte']:+.2f}")
        entry['verdict'] = verdict
        entry['why'] = lines
        status = {'progress': 0, 'flat': 1, 'regression': 2}[verdict]
        if args.history:
            remember(entry)
        if args.accept and verdict == 'progress':
            card['baseline'] = {'label': args.label, 'commit': commit, 'pieces': cand}
            remember(entry)
            print('已作为新基线')
    if args.init or args.accept or args.history:
        card['latest'] = {'label': args.label, 'commit': commit, 'verdict': entry['verdict'], 'pieces': cand}
        CARD.write_text(json.dumps(card, indent=2, ensure_ascii=False) + '\n')
        print('wrote', CARD)
        args.figure = str(ROOT / 'references/violin-score.png')
    draw(card, cand, args.label, Path(args.figure))
    for job in jobs:
        Path(job[1]).unlink(missing_ok=True)
    sys.exit(status)


if __name__ == '__main__':
    main()
