import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ClipAudio } from './renderer.js';
import { mix } from './segments.js';
import { ScoreSchema, type Score, trackClips } from './schema.js';
import { expandSfx } from './sfx.js';
import { readWavFile } from './wav.js';

export interface LoadedScore {
  score: Score;
  clips: Record<string, ClipAudio>;
  warnings: string[];
}

function readClip(src: string, baseDir: string): ClipAudio {
  const abs = resolve(baseDir, src);
  const data = readFileSync(abs);
  const decoded = readWavFile(data);
  return {
    sampleRate: decoded.sampleRate,
    buffers: decoded.buffers,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}

function collectClips(score: Score, baseDir: string, into: Record<string, ClipAudio>) {
  for (const track of score.tracks) {
    for (const clip of trackClips(track)) {
      const audio = readClip(clip.src, baseDir);
      const prev = into[clip.src];
      if (prev && prev.sha256 !== audio.sha256) {
        throw new Error(`片段 "${clip.src}" 在不同目录下指向不同文件。请写成不会撞名的路径`);
      }
      into[clip.src] = audio;
    }
  }
}

/** Load a score JSON. A file with `segments` is mixed first; clip paths are relative to the file that names them. */
export function loadScoreFile(path: string): LoadedScore {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const base = dirname(resolve(path));
  if (Array.isArray(raw.segments)) {
    const warnings: string[] = [];
    const clips: Record<string, ClipAudio> = {};
    const segments = (raw.segments as Record<string, unknown>[]).map((seg) => {
      if (typeof seg.src !== 'string') throw new Error('segments[].src 必须是乐谱路径');
      const loaded = loadScoreFile(resolve(base, seg.src));
      warnings.push(...loaded.warnings);
      for (const [k, v] of Object.entries(loaded.clips)) {
        const prev = clips[k];
        if (prev && prev.sha256 !== v.sha256) {
          throw new Error(`片段 "${k}" 在不同目录下指向不同文件。请写成不会撞名的路径`);
        }
        clips[k] = v;
      }
      return {
        score: loaded.score,
        at: typeof seg.at === 'number' ? seg.at : 0,
        fadeIn: typeof seg.fadeIn === 'number' ? seg.fadeIn : undefined,
        fadeOut: typeof seg.fadeOut === 'number' ? seg.fadeOut : undefined,
        prefix: typeof seg.prefix === 'string' ? seg.prefix : undefined,
      };
    });
    const mixed = mix(segments, raw.master as Score['master']);
    warnings.push(...mixed.warnings);
    const score: Score = {
      ...mixed.score,
      sampleRate: typeof raw.sampleRate === 'number' ? raw.sampleRate : mixed.score.sampleRate,
      seed: typeof raw.seed === 'number' ? raw.seed : mixed.score.seed,
      bpm: typeof raw.bpm === 'number' ? raw.bpm : mixed.score.bpm,
      duration: typeof raw.duration === 'number' ? raw.duration : mixed.score.duration,
      master: (raw.master as Score['master']) ?? mixed.score.master,
    };
    return { score, clips, warnings };
  }
  const score = expandSfx(ScoreSchema.parse(raw));
  const clips: Record<string, ClipAudio> = {};
  collectClips(score, base, clips);
  return { score, clips, warnings: [] };
}
