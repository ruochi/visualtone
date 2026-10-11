#!/usr/bin/env python3
"""Score the current violin on the Gavotte en Rondeau theme, without fitting to it.

The notes come from the Mutopia LilyPond of BWV 1006 (CC BY-SA 3.0). The recording
is Vicond's Wikimedia file, CC BY 3.0, a different movement from the menuet the
body was fitted on. Tempo and the start offset are chosen by chroma alignment.
"""
import json
import re
import subprocess
from pathlib import Path

import numpy as np
from scipy.io import wavfile

from violin_metrics import chroma_from_mag, dtw_path, frame_norm, stft_mag

PC = {'c': 0, 'd': 2, 'e': 4, 'f': 5, 'g': 7, 'a': 9, 'b': 11}
ACC = (('isis', 2), ('eses', -2), ('is', 1), ('es', -1))
DUR = {1: 4.0, 2: 2.0, 4: 1.0, 8: 0.5, 16: 0.25, 32: 0.125}


def closest(pc, prev):
    best = None
    for octave in range(3, 9):
        midi = octave * 12 + pc
        dist = abs(midi - prev)
        if best is None or dist < best[0] or (dist == best[0] and midi < best[1]):
            best = (dist, midi)
    return best[1]


def parse_relative(body, start_midi):
    prev = start_midi
    dur = 1.0
    beat = 0.0
    notes = []
    body = re.sub(r'%[^\n]*', ' ', body)
    body = re.sub(r'\\[A-Za-z]+', ' ', body)
    token = r"(?:^|(?<=[\s\[\(\|]))(?:<[^>]+>\d*\.?|[a-g](?:isis|eses|is|es)?[',]*\d*\.?|s\d*\.?)"
    for raw in re.findall(token, body):
        if raw.startswith('s'):
            m = re.search(r'(\d+)', raw)
            if m:
                dur = DUR[int(m.group(1))]
            if raw.endswith('.'):
                beat += dur * 1.5
            else:
                beat += dur
            continue
        names = []
        dur_src = raw
        if raw.startswith('<'):
            inside, _, rest = raw[1:].partition('>')
            names = inside.split()
            dur_src = rest
        else:
            names = [raw]
            dur_src = ''
        m = re.search(r'(\d+)', dur_src if raw.startswith('<') else raw)
        # duration sits on the note token, including inside a single note
        m = re.search(r'(\d+)', raw if not raw.startswith('<') else raw[raw.find('>'):])
        if m:
            dur = DUR[int(m.group(1))]
        this = dur * (1.5 if raw.endswith('.') else 1.0)
        first_midi = None
        cursor = prev
        for name in names:
            mname = re.match(r"([a-g])(isis|eses|is|es)?([',]*)", name)
            if not mname:
                continue
            pc = PC[mname.group(1)]
            if mname.group(2):
                pc = (pc + dict(ACC)[mname.group(2)]) % 12
            marks = mname.group(3)
            midi = closest(pc, cursor) + 12 * marks.count("'") - 12 * marks.count(',')
            notes.append({'beat': beat, 'dur': this, 'midi': midi})
            if first_midi is None:
                first_midi = midi
            cursor = midi
        # The note after a chord is relative to the chord's first pitch.
        if first_midi is not None:
            prev = first_midi
        beat += this
    return notes


def first_volta(text, which):
    key = 'melodyOne' if which == 1 else 'melodyTwo'
    chunk = text.split(key, 1)[1]
    chunk = chunk.split('% end repeat', 1)[0]
    # Drop the \\relative pitch. It is not a note of the theme.
    brace = chunk.find('{')
    return chunk[brace + 1:]


def theme_notes(ly_text):
    one = parse_relative(first_volta(ly_text, 1), 71)
    two = parse_relative(first_volta(ly_text, 2), 64)
    notes = []
    for src, size in ((one, 0.64), (two, 0.55)):
        for n in src:
            bar = int(n['beat'] // 4) + 1
            beat_in = (n['beat'] % 4) + 1
            # Collapse the written pickup into bar 1 by shifting two beats.
            at_beat = n['beat'] + 2
            bar = int(at_beat // 4) + 1
            beat_in = round((at_beat % 4) + 1, 3)
            notes.append({
                'at': f'{bar}:{beat_in}',
                'pitch': midi_name(n['midi']),
                'quarters': n['dur'],
                'size': size,
            })
    return notes


NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


def midi_name(midi):
    return f'{NAMES[midi % 12]}{midi // 12 - 1}'


def len_name(quarters):
    table = {4: '1', 2: '1/2', 1: '1/4', 0.5: '1/8', 0.25: '1/16', 0.125: '1/32', 1.5: '3/8', 3: '3/4'}
    return table.get(quarters, f'{quarters}/1')


def score_json(notes, bpm):
    menuet = json.loads(Path('examples/violin-minuet.json').read_text())
    beats = max(n['beat'] if False else 0 for n in notes)
    # recompute end from at
    def at_quarters(at):
        bar, beat = at.split(':')
        return (int(bar) - 1) * 4 + (float(beat) - 1)

    end = 0.0
    out_notes = []
    for n in notes:
        start = at_quarters(n['at'])
        end = max(end, start + n['quarters'])
        out_notes.append({
            'at': n['at'],
            'pitch': n['pitch'],
            'len': len_name(n['quarters']),
            'size': n['size'],
            'ease': 'hold',
        })
    return {
        'sampleRate': 48000,
        'duration': round(end * 60 / bpm + 1.2, 3),
        'bpm': bpm,
        'meter': [4, 4],
        'seed': 1006,
        'master': menuet['master'],
        'tracks': [{
            'id': 'violin',
            'instrument': 'violin',
            'channel': [0, 1],
            'seed': 1006,
            'room': 0.2,
            'humanize': {'timeMs': 0, 'size': 0},
            'notes': out_notes,
        }],
    }


def chroma_cost(rec_mag, rec_freqs, sr, hop, notes, bpm, offset):
    from violin_metrics import load_notes
    score = score_json(notes, bpm)
    written = load_notes(score)
    if not written:
        return 1e6, 0
    dur = max(n['t'] + n['dur'] for n in written)
    i0 = int(offset * sr / hop)
    i1 = i0 + int(dur * sr / hop)
    if i0 < 0 or i1 > rec_mag.shape[1]:
        return 1e6, 0
    mag_r = rec_mag[:, i0:i1]
    pc = np.zeros((12, mag_r.shape[1]), dtype=np.float64)
    energy = np.zeros(mag_r.shape[1])
    for n in written:
        a = int(n['t'] * sr / hop)
        b = max(a + 1, int((n['t'] + n['dur']) * sr / hop))
        b = min(b, pc.shape[1])
        pc[n['midi'] % 12, a:b] += 1
        energy[a:b] += 1
    pc_r = frame_norm(chroma_from_mag(mag_r, rec_freqs))
    pc_s = frame_norm(pc)
    band = max(8, pc_s.shape[1] // 3)
    path = dtw_path(pc_s, pc_r, energy + 0.2, mag_r.sum(0), band)
    if len(path) < 8:
        return 1e6, 0
    dist = [1 - float(np.dot(pc_s[:, i], pc_r[:, j])) for i, j in path]
    return float(np.mean(dist)), dur


def main():
    ly = Path('/tmp/violin-solo/ext/gavotte.ly').read_text()
    notes = theme_notes(ly)
    print('notes', len(notes), 'first', notes[0], 'second', notes[1])
    wav = Path('/tmp/violin-solo/ext/gavotte.wav')
    if not wav.exists():
        subprocess.check_call([
            'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
            '-i', '/tmp/violin-solo/ext/gavotte.ogg',
            '-ac', '1', '-ar', '48000', str(wav),
        ])
    sr, rec = wavfile.read(wav)
    if np.issubdtype(rec.dtype, np.integer):
        rec = rec.astype(np.float64) / np.iinfo(rec.dtype).max
    else:
        rec = rec.astype(np.float64)
    if rec.ndim > 1:
        rec = rec.mean(axis=1)
    rec = rec / (np.max(np.abs(rec)) + 1e-12)
    hop = 1024
    rec_freqs, _times, rec_mag = stft_mag(rec[: int(40 * sr)], sr, 4096, hop)
    print('theme', [(n['at'], n['pitch'], n['quarters']) for n in notes[:8]])

    # Same-tempo chroma first. DTW only on the few alignments that already agree.
    screen = []
    for bpm in range(90, 151, 10):
        for offset in np.arange(0, 1.51, 0.25):
            cost, dur = chroma_cost(rec_mag, rec_freqs, sr, hop, notes, bpm, float(offset))
            screen.append((cost, bpm, float(offset), dur))
    screen.sort()
    refined = screen[0]
    for cost0, bpm, offset, _dur in screen[:2]:
        for bpm2 in range(bpm - 4, bpm + 5, 4):
            for offset2 in np.arange(max(0, offset - 0.2), offset + 0.21, 0.2):
                cost, dur = chroma_cost(rec_mag, rec_freqs, sr, hop, notes, bpm2, float(offset2))
                if cost < refined[0]:
                    refined = (cost, bpm2, float(offset2), dur)
    cost, bpm, offset, dur = refined
    print(f'align cost {cost:.3f} bpm {bpm} offset {offset:.2f} dur {dur:.2f}')
    score = score_json(notes, bpm)
    out_score = Path('examples/violin-gavotte-theme.json')
    out_score.write_text(json.dumps(score, indent=2) + '\n')
    report = {
        'piece': 'Bach Partita 3, Gavotte en Rondeau, rondeau theme',
        'recording': 'Wikimedia Commons J.S.Bach_partita_No.3_Gavotte_in_Rondeau.ogg',
        'license': 'CC BY 3.0, Vicond',
        'scoreSource': 'Mutopia bwv-1006_3.ly, CC BY-SA 3.0, Hajo Dezelski, Bach-Gesellschaft 1879',
        'player': 'Vicond, same player as the menuet, different movement',
        'bpm': bpm,
        'offsetSec': round(offset, 3),
        'chromaCost': round(cost, 3),
        'fittedOnThisPiece': False,
    }
    Path('/tmp/violin-solo/ext/align.json').write_text(json.dumps(report, indent=2) + '\n')
    print('wrote', out_score)


if __name__ == '__main__':
    main()
