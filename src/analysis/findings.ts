import type { Score } from '../schema.js';
import { getChannelIndices } from '../schema.js';
import type { Profile } from './profiles.js';
import type { AnalysisReport, Finding } from './types.js';

function family(id: string): string {
  return id.replace(/-\d+$/, '');
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function noteSizes(score: Score | undefined, fam: string): number | null {
  if (!score) return null;
  const sizes: number[] = [];
  for (const t of score.tracks) {
    if (family(t.id) !== fam) continue;
    for (const n of t.notes ?? []) sizes.push(n.size);
  }
  return median(sizes);
}

/** Share as a percent string: one decimal under 10%, none above. */
function pct(share: number): string {
  const v = share * 100;
  return v < 10 ? String(Math.round(v * 10) / 10) : v.toFixed(0);
}

function inRange(v: number, range: [number, number]): boolean {
  return v >= range[0] && v <= range[1];
}

export function buildFindings(report: AnalysisReport, profile: Profile | undefined, score?: Score): Finding[] {
  const out: Finding[] = [];
  const push = (f: Finding) => out.push(f);

  if (report.loudness.samplePeak > 0.98 || report.loudness.truePeakDbtp > -0.3) {
    push({
      id: 'clip',
      severity: 'high',
      metric: 'loudness.truePeakDbtp',
      value: report.loudness.truePeakDbtp,
      target: '< -1 dBTP',
      message: `真峰值 ${report.loudness.truePeakDbtp.toFixed(1)} dBTP，有削波风险`,
      suggestion: '把 master.limiter.ceiling 设到 -1.5 或更低，或降低 master.drive',
    });
  }

  const balanceLimit = profile?.lowBalanceMaxDb ?? 3;
  if (Math.abs(report.stereo.lowBalanceDb) > balanceLimit && report.channels > 1) {
    const side = report.stereo.lowBalanceDb > 0 ? '左' : '右';
    const culprits: string[] = [];
    if (score && report.masking) {
      const maxLow = Math.max(...report.masking.lowEnergy, 1e-12);
      for (const t of score.tracks) {
        const ch = getChannelIndices(t.channel);
        const idx = report.masking.trackIds.indexOf(t.id);
        const low = idx >= 0 ? report.masking.lowEnergy[idx] : 0;
        if (ch.length === 1 && low > maxLow * 0.15) culprits.push(`${t.id}→ch ${ch[0]}`);
      }
    }
    push({
      id: 'stereo.lowBalance',
      severity: 'high',
      metric: 'stereo.lowBalanceDb',
      value: report.stereo.lowBalanceDb,
      target: `±${balanceLimit} dB`,
      message: `低频左右不平衡：120Hz 以下偏${side} ${Math.abs(report.stereo.lowBalanceDb).toFixed(1)} dB`,
      suggestion: culprits.length
        ? `把 ${culprits.join('、')} 的 channel 改成 [0,1]。channel 写单个数字时，立体声成片里只会进那一边`
        : '检查底鼓和贝斯的 channel 是否为 [0,1]；单个数字在立体声成片里只会进左或右声道',
    });
  }

  if (profile && report.stereo.lowCorrelation < profile.lowCorrelationMin) {
    push({
      id: 'stereo.lowCorrelation',
      severity: 'medium',
      metric: 'stereo.lowCorrelation',
      value: report.stereo.lowCorrelation,
      target: `> ${profile.lowCorrelationMin}`,
      message: `120Hz 以下左右相关性只有 ${report.stereo.lowCorrelation.toFixed(2)}，低频不单声道`,
      suggestion: '底鼓、贝斯不要加 pan LFO 或过宽的 unison spread，让 120Hz 以下保持居中',
    });
  }

  if (profile && !inRange(report.stereo.sideMidDb, profile.sideMidDb)) {
    const wide = report.stereo.sideMidDb > profile.sideMidDb[1];
    push({
      id: 'stereo.width',
      severity: 'low',
      metric: 'stereo.sideMidDb',
      value: report.stereo.sideMidDb,
      target: `${profile.sideMidDb[0]}..${profile.sideMidDb[1]} dB`,
      message: wide
        ? `声场偏宽（侧/中 ${report.stereo.sideMidDb.toFixed(1)} dB）`
        : `声场偏窄（侧/中 ${report.stereo.sideMidDb.toFixed(1)} dB）`,
      suggestion: wide
        ? '减小 pad 和 lead 的 space，或降低 lfo pan 的 depth'
        : '给 pad、hat、hook 加 pan LFO，或提高 space 让混响把声场撑开',
    });
  }

  if (profile && !inRange(report.loudness.integratedLufs, profile.lufs)) {
    push({
      id: 'loudness.integrated',
      severity: 'medium',
      metric: 'loudness.integratedLufs',
      value: report.loudness.integratedLufs,
      target: `${profile.lufs[0]}..${profile.lufs[1]} LUFS`,
      message: `积分响度 ${report.loudness.integratedLufs.toFixed(1)} LUFS，不在 ${profile.name} 的范围内`,
      suggestion: `把 master.loudness 调到 ${profile.lufs[0]} 和 ${profile.lufs[1]} 之间`,
    });
  }

  if (profile && !inRange(report.loudness.plr, profile.plr)) {
    const dynamic = report.loudness.plr > profile.plr[1];
    push({
      id: 'loudness.plr',
      severity: dynamic ? 'medium' : 'low',
      metric: 'loudness.plr',
      value: report.loudness.plr,
      target: `${profile.plr[0]}..${profile.plr[1]} dB`,
      message: dynamic
        ? `峰均比 ${report.loudness.plr.toFixed(1)} dB 偏大，听感不够密`
        : `峰均比 ${report.loudness.plr.toFixed(1)} dB 偏低，动态被压扁了`,
      suggestion: dynamic
        ? '把 master.loudness 提高 1–2 dB，让限幅器多压一点峰值；或加强 master.comp（降低 threshold、提高 ratio）'
        : '放宽 master.comp 的 ratio，或降低各轨 comp 的 makeup',
    });
  }

  if (profile) {
    for (const band of report.bands) {
      const range = profile.bands[band.name];
      if (!range || inRange(band.share, range)) continue;
      const low = band.share < range[0];
      const highBand = band.name === 'presence' || band.name === 'air';
      push({
        id: `band.${band.name}`,
        severity: highBand && low ? 'high' : 'medium',
        metric: `bands.${band.name}`,
        value: band.share,
        target: `${pct(range[0])}-${pct(range[1])}%`,
        message: low
          ? `${band.name} 只占 ${(band.share * 100).toFixed(1)}%，低于 ${profile.name} 的 ${pct(range[0])}%`
          : `${band.name} 占 ${(band.share * 100).toFixed(1)}%，高于 ${profile.name} 的 ${pct(range[1])}%`,
        suggestion: suggestionForBand(band.name, low),
      });
    }
  }

  if (profile && report.structure.contrastDb < profile.contrastMinDb && report.structure.energyDb.length >= 4) {
    push({
      id: 'structure.contrast',
      severity: 'medium',
      metric: 'structure.contrastDb',
      value: report.structure.contrastDb,
      target: `> ${profile.contrastMinDb} dB`,
      message: `段落对比只有 ${report.structure.contrastDb.toFixed(1)} dB，编曲太平`,
      suggestion: '用 automation.gain 把前奏和 build 压低，drop 再回到 1；或在 drop 前留一拍空白',
    });
  }

  if (report.masking) {
    const ids = report.masking.trackIds;
    const shareLimit = profile?.trackShareMax ?? 0.45;
    const grouped = new Map<string, number>();
    ids.forEach((id, i) => grouped.set(family(id), (grouped.get(family(id)) ?? 0) + report.masking!.shares[i]));
    for (const [fam, share] of grouped) {
      if (/kick|bass/i.test(fam)) continue;
      if (share <= shareLimit) continue;
      const size = noteSizes(score, fam);
      const buried = [...grouped.entries()]
        .filter(([name, s]) => name !== fam && s >= 0.002 && !/kick|bass/i.test(name))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, s]) => `${name} ${(s * 100).toFixed(0)}%`);
      push({
        id: `share.${fam}`,
        severity: share > shareLimit * 1.3 ? 'high' : 'medium',
        metric: `masking.share.${fam}`,
        value: share,
        target: `< ${(shareLimit * 100).toFixed(0)}%`,
        message: buried.length
          ? `${fam} 合计占能量 ${(share * 100).toFixed(0)}%，盖过了 ${buried.join('、')}`
          : `${fam} 合计占能量 ${(share * 100).toFixed(0)}%，盖过了其他轨`,
        suggestion: size
          ? `把 ${fam} 的 notes size 从约 ${size.toFixed(2)} 降到 ${(size * (shareLimit / share)).toFixed(2)}，或加 eq.lowCut 给别的轨让位置`
          : `降低 ${fam} 的 size，或加 eq.lowCut / peaks 把多余的频段挖掉`,
      });
    }

    const overlapLimit = profile?.maskOverlapMax ?? 0.55;
    const seen = new Set<string>();
    for (const pair of report.masking.pairs) {
      const amount = Math.max(pair.overlap, pair.cover);
      if (amount < overlapLimit) continue;
      const fa = family(pair.a);
      const fb = family(pair.b);
      if (fa === fb) continue;
      if (/kick|bass/i.test(fa) && /kick|bass/i.test(fb)) continue;
      const key = [fa, fb].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const shareA = grouped.get(fa) ?? 0;
      const shareB = grouped.get(fb) ?? 0;
      if (shareA < 0.04 && shareB < 0.04) continue;
      const louder = shareA >= shareB ? fa : fb;
      const quieter = louder === fa ? fb : fa;
      const size = noteSizes(score, louder);
      const covered = pair.cover >= overlapLimit && pair.cover >= pair.overlap;
      push({
        id: `mask.${key}`,
        severity: amount > 0.6 ? 'high' : 'medium',
        metric: covered ? 'masking.cover' : 'masking.overlap',
        value: covered ? pair.cover : pair.overlap,
        target: `< ${overlapLimit}`,
        message: covered
          ? `${louder} 盖住了 ${quieter}：在 ${Math.round(pair.bandLo)}–${Math.round(pair.bandHi)} Hz，${quieter} 有 ${(pair.cover * 100).toFixed(0)}% 的能量叠在 ${louder} 上`
          : `${fa} 与 ${fb} 在 ${Math.round(pair.bandLo)}–${Math.round(pair.bandHi)} Hz 重叠度 ${pair.overlap.toFixed(2)}`,
        suggestion: size
          ? `降低 ${louder} 的 size（现在约 ${size.toFixed(2)}），或给 ${louder} 加 eq.peaks，freq ${Math.round((pair.bandLo + pair.bandHi) / 2)}、gain -3`
          : `给 ${louder} 加 eq.peaks，在 ${Math.round((pair.bandLo + pair.bandHi) / 2)} Hz 处 -3dB，或降低它的 size`,
      });
    }
  }

  if (profile && report.space.wetShare !== null && report.space.wetShare < profile.wetShareMin) {
    push({
      id: 'space.wet',
      severity: 'high',
      metric: 'space.wetShare',
      value: report.space.wetShare,
      target: `> ${(profile.wetShareMin * 100).toFixed(0)}%`,
      message: `混响和延迟只占能量的 ${(report.space.wetShare * 100).toFixed(1)}%，听起来偏干`,
      suggestion: '提高 pad 和 hook 的 space，给鼓加 room 发送；master.reverb 加大 size，并留 20ms 以上的 preDelayMs',
    });
  }

  if (profile && report.space.tailRatioDb !== null && report.space.tailRatioDb < profile.tailRatioDbMin) {
    push({
      id: 'space.tail',
      severity: 'medium',
      metric: 'space.tailRatioDb',
      value: report.space.tailRatioDb,
      target: `> ${profile.tailRatioDbMin} dB`,
      message: `起音之间的尾巴比音头低 ${Math.abs(report.space.tailRatioDb).toFixed(1)} dB，音符断得太干净`,
      suggestion: '给 stab、pad、hook 加 release（150–400ms），并提高它们的 space 或 room',
    });
  }

  if (profile && report.dynamics.hitVariationDb !== null && report.dynamics.hitVariationDb < profile.hitVariationMinDb) {
    const flat = [...report.dynamics.tracks].sort((a, b) => a.variationDb - b.variationDb)[0];
    push({
      id: 'dynamics.variation',
      severity: 'high',
      metric: 'dynamics.hitVariationDb',
      value: report.dynamics.hitVariationDb,
      target: `> ${profile.hitVariationMinDb} dB`,
      message: `偏死的轨每一下只差 ${report.dynamics.hitVariationDb.toFixed(2)} dB，听起来像 MIDI 直出`,
      suggestion: flat
        ? `给 ${flat.id} 等轨加 humanize.size（0.08–0.15）和 timbre.velocity（约 0.6），让重音更亮、弱音更暗`
        : '给鼓和 stab 加 humanize.size，并打开 timbre.velocity',
    });
  }

  if (profile && !inRange(report.warmth, profile.warmth)) {
    const low = report.warmth < profile.warmth[0];
    push({
      id: 'warmth',
      severity: low ? 'high' : 'medium',
      metric: 'warmth',
      value: report.warmth,
      target: `${pct(profile.warmth[0])}-${pct(profile.warmth[1])}%`,
      message: low
        ? `150–500Hz 只占 ${(report.warmth * 100).toFixed(1)}%，中低频偏薄，不浑厚`
        : `150–500Hz 占 ${(report.warmth * 100).toFixed(1)}%，中低频偏糊`,
      suggestion: low
        ? '少挖 200–400Hz：底鼓和贝斯的 peaks 负增益收到 -1.5dB 以内，pad 的 lowCut 降到 160Hz 左右，并加一层长音 keys'
        : '给 pad 加 eq.peaks 在 300Hz 处 -2dB，或降低 pad 的 size',
    });
  }

  if (profile && report.dynamics.repetition > profile.repetitionMax && report.structure.energyDb.length >= 8) {
    push({
      id: 'dynamics.repetition',
      severity: 'medium',
      metric: 'dynamics.repetition',
      value: report.dynamics.repetition,
      target: `< ${profile.repetitionMax}`,
      message: `相隔 4 或 8 小节的段落有 ${(report.dynamics.repetition * 100).toFixed(0)}% 几乎一模一样`,
      suggestion: '每 4 或 8 小节加一个过门：鼓的空拍、stab 换节奏，或让 hook 的乐句结尾不一样',
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return out;
}

function suggestionForBand(name: string, low: boolean): string {
  if (name === 'presence' || name === 'air') {
    return low
      ? '降低 hat 的 eq.lowCut，给 stab 和 hook 加 highShelf（+3dB @ 6kHz 左右）；pad 的 highShelf 如果是负的就收回来'
      : '给 hat、hook 加 highCut，或把 highShelf 的 gain 降下来';
  }
  if (name === 'sub' || name === 'bass') {
    return low
      ? '底鼓的 y 再低 1–2 个半音，贝斯少做高八度；确认它们的 channel 是 [0,1] 而不是只进一边'
      : '给 bass 加 eq.peaks 在 200–300Hz 挖掉，或降低 bass 的 size';
  }
  return low
    ? '中频偏少：提高 stab 或 hook 的 size，或把 pad 的 lowCut 降一点'
    : '中频糊：给 pad 加 eq.peaks 在 400–800Hz 处 -3dB，并把 pad 的 size 降下来';
}

export function diffFindings(before: Finding[], after: Finding[]): { resolved: Finding[]; added: Finding[] } {
  const afterIds = new Set(after.map((f) => f.id));
  const beforeIds = new Set(before.map((f) => f.id));
  return {
    resolved: before.filter((f) => !afterIds.has(f.id)),
    added: after.filter((f) => !beforeIds.has(f.id)),
  };
}
