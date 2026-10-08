# visualtone

**音乐即动画彩色曲线 — 音频作为视觉数据的纯函数**

visualtone 是一个 TypeScript 库，它将彩色曲线转换为音频。每条曲线的时间、音高、音量和音色都由其视觉属性定义。

## 核心概念

### 视觉到音频的映射

- **x 轴** → 时间 (秒)
- **y 轴** → 音高 (MIDI 音符，0-127，连续浮点数)
- **点的大小** → 音量 (0-1 归一化值映射到增益)
- **色调 (Hue)** → 音色 (0-360° 映射到连续的合成器参数)
- **亮度 (Lightness)** → 明暗 (0–1，控制低通截止频率；轨道默认 0.5)

### 曲线语法

**points** 上可选字段：

| 字段 | 说明 |
|------|------|
| `ease` | 如何**到达**该点：`step` `linear` `in` `out` `inOut` `exp` |
| `tween` | 仅在该点前 `tween` 秒内插值，之前保持上一值 |

未写 `ease` 时的默认规则：

- `size` 从 0 到大于 0 → `step`（起音）
- `size` 下降 → `exp`
- 两点均为 `size=0` → 静音
- 连续发声时音高 → `linear`（连奏）；断奏请在音符间留静音

**notes** 简写（渲染前展开为 points）：

```json
{ "t": 0, "y": 36, "size": 0.9, "duration": 0.15, "ease": "exp" }
```

- `hold`（默认）：保持音量，结尾约 20ms 收掉
- `exp`：在 `duration` 内指数衰减（鼓、镲）

### Hue 音色环

| Hue | 家族 |
|-----|------|
| 0° | Kick |
| 30° | Bass |
| 70° | Pluck / arp |
| 110° | Bell / keys |
| 160° | Supersaw lead |
| 210° | Pad |
| 260° | Vocal / breath |
| 300° | Snare / clap |
| 335° | Hi-hat |

轨道可选：`space`（大厅混响发送）、`room`（短房间发送）、`echo`（延迟）、`release`（音符结束后的尾巴，毫秒，0 为硬切断）、`chorus`、`duck`（侧链）、`saturation`、`channel: [0,1]` 立体声路由；乐谱级 `bpm` 与 `master` 总线响度/效果。

### 混音、调制与律动

信号链（每轨）：曲线 → Voice（`release`、力度联动、漂移）→ `eq` → `comp` → `chorus` → 增益/声像 LFO 与自动化 → `duck` → 立体声发送，汇总后进共享的 hall（`space`）、room（`room`）和延迟（`echo`）。hall 的输入先过 120 Hz 高通，低音的长尾不会糊成一片。主总线：`eq` → `saturation` → `comp` → 软削波 → 响度对齐 → 前瞻限幅。

| 字段 | 作用 | 示例 |
|------|------|------|
| `eq` | RBJ 双二阶：`lowCut` / `highCut`（Hz）、`lowShelf` / `highShelf` `{freq, gain}`、`peaks` `[{freq, gain, q}]` | `{ "lowCut": 180, "peaks": [{ "freq": 600, "gain": -2, "q": 1 }] }` |
| `comp` | 软拐点立体声联动压缩：`threshold` `ratio` `attackMs` `releaseMs` `knee` `makeup` | `{ "threshold": -14, "ratio": 4, "attackMs": 8 }` |
| `lfo` | `[{ target, depth, rate|beats, shape, phase }]`；target = `lightness`（滤波扫频）/ `pitch`（颤音，半音）/ `gain`（tremolo）/ `pan`（±1 = 左右） | `{ "target": "pitch", "depth": 0.16, "rate": 5.3 }` |
| `automation` | 关键帧线性插值：`lightness`（加到亮度上的偏移）、`gain`（乘数） | `{ "gain": [{ "t": 0, "v": 0.6 }, { "t": 4, "v": 1 }] }` |
| `swing` | 乐谱级（或轨道覆盖）0 = 平直，1 = 三连音；`swingGrid` 8 或 16 | `"swing": 0.42` |
| `humanize` | 确定性微抖动：`timeMs`、`size` | `{ "timeMs": 4, "size": 0.25 }` |
| `release` | 音符曲线结束后按这个毫秒数衰减；0 与以前一样立刻切断 | `250` |
| `room` | 短房间混响发送 0–1，和 `space` 的长尾大厅分开 | `0.35` |
| `chorus` | 三路调制延迟：`depth` `rateHz` `mix` | `{ "depth": 0.45, "rateHz": 0.35, "mix": 0.4 }` |
| `timbre.velocity` | 0–1。重音把截止频率和滤波包络开得更亮，轻音更暗 | `0.6` |
| `timbre.drift` | 0–1。缓慢的音高漂移、每次起音的截止偏移和齐奏起始相位。种子固定，渲染可复现 | `0.4` |
| `master.comp` | 总线胶水压缩，阈值相对目标响度 | `{ "threshold": -9, "ratio": 2 }` |
| `master.saturation` | 0–1。偶次谐波的不对称软饱和，后面隔直流；0 关闭 | `0.3` |
| `master.room` | 短房间总线：`size` `decay` `preDelayMs` `damping` `width` | `{ "size": 0.45, "decay": 0.35, "preDelayMs": 8 }` |
| `master.reverb` | 长尾大厅，同样带 `preDelayMs`、`damping`（尾巴高频衰减）、`width` | `{ "size": 0.78, "decay": 0.62, "preDelayMs": 25, "damping": 0.45 }` |

完整示例见 `examples/deep-house-v5.json`（由 `examples/scripts/deep-house-v5.mjs` 生成）。`examples/deep-house-v6.json` 是 32 小节的完整版（前奏、铺垫、两段 drop、间奏、尾奏）。`examples/deep-house-v7.json` 在同一编曲上加了房间总线、音符尾巴、力度联动和漂移、合唱、总线饱和，以及一层 keys 和中频贝斯，并用 `analyze --profile deep-house` 调到没有遗留问题。

总线末端是前瞻真峰值限幅器（默认 −1 dBTP，5 ms 前瞻），`master.limiter` 可以改上限和释放时间。`master.eq` 在饱和和胶水压缩之前处理整条总线。大厅和房间是两条共享的立体声 FDN，带预延迟、早期反射和阻尼，不再是每轨一个混响。`lightness` 按泛音倍数指数映射到截止频率（0.5 约为基频 8.5 倍，0.8 约 24 倍，上限 18 kHz），stab、hook 想进 2–6 kHz 的 presence 区，lightness 需要 0.6 以上。

详见 `llms.txt`（面向 AI 作者的速查与示例）。

### 多轨道与立体声

- 每条轨道是一条单色曲线 (每条轨道一个色调值)
- `channel: 0` / `1` 把单声道曲线送到左 / 右；`channel: [0,1]` 走立体声（居中，齐奏与 `pan` LFO 会展开声像）
- 立体声乐谱里只写 `channel: 0` 的轨道只在左声道出声，底鼓、贝斯请用 `[0,1]`
- 多轨道 = 多条平行曲线
- 音乐 = 这些值随时间变化 (平滑插值或阶跃式打击乐)

## 听感分析

`analyze` 把成片（以及乐谱渲染出的分轨）变成能看的报告，用来判断浑浊、遮蔽、声像、响度和编曲起伏。输入 `.json` 时会带分轨渲染；输入 `.wav` 时只分析混音（支持 16/24-bit PCM 和 32-bit float）。

报告里的数字：

- 响度：BS.1770 积分 LUFS、响度范围、4 倍过采样真峰值、峰均比
- 频段能量：sub / bass / mid / presence / air，另有 150–500 Hz 的厚度 `warmth`
- 空间：`wetShare`（混响和延迟总线能量占干声加湿声的比例，需要分轨）、`tailRatioDb`（起音尾巴相对音头）
- 力度：`hitVariationDb`（至少 16 下的轨里，偏死那一档的局部峰值起伏）、`repetition`（相隔 4 或 8 小节且几乎相同的比例）
- 立体声：相关性、侧中比、120Hz 以下的左右平衡，以及低/中/高频段的侧中比
- 节奏：速度、swing、底鼓冲击力、侧链深度
- 和声：色度 + Krumhansl 调性
- 结构：按小节的能量、自相似、段落对比
- 遮蔽：分轨在 ERB 频带上的时频重叠和能量占比

`--profile` 用 `deep-house`、`techno`、`pop-edm`、`ambient` 之一，或 `profile` 命令从参考曲生成的 JSON。内置画像是通用混音经验值，不是标准。差距会写成 findings，每条带严重度和一条指向乐谱字段的建议。

PNG 面板（标签是英文）：乐谱曲线、对数频谱、分轨频谱、频段柱、短时响度、相位、底鼓包络、遮蔽矩阵、自相似和色度，以及空间（各总线湿声占比和尾巴）和力度（每一下的峰值点，排成直线就是 MIDI 感）。

听完一轮可以记一条偏好，攒多了再看哪些指标跟你的分数相关。追加到 `feedback/ratings.jsonl`，一行一个 JSON：

```json
{"date":"2026-10-06","file":"examples/deep-house-v5.json","reportHash":"…","scores":{"groove":4,"timbre":3,"clarity":4,"overall":3},"note":"drop 还是不够砸"}
```

`groove`、`timbre`、`clarity`、`overall` 都是 1–5。

### 音色测量

`analyze` 衡量整首混音；`timbre` 和 `probe` 衡量单个乐器，用来给建模引擎调参。

```bash
visualtone timbre note.wav --midi 60 --ref piano-c4.wav --json c4.json
visualtone probe track.json --pitches 36,48,60,72,84 --sizes 0.3,0.6,0.9 --ref refs/
```

`timbre` 测一个音：

- 音高：f0、相对 `--midi` 的音分、稳定度、起音滑音、颤音速度和深度，以及去掉漂移和揉弦之后剩下的抖动
- 包络：起音 10–90%、整体/早段/晚段衰减（dB/s）、T60、松开后的尾巴、固定时刻的包络曲线、8–20 Hz 的微起伏（比揉弦更快的幅度调制，dB）
- 泛音：前 16 个泛音的相对 dB、斜率、奇偶比、非谐性 B、谐噪比、杂散峰（混叠会出现在这里）、前 8 个泛音各自的衰减、各分音自己的起伏
- 亮度：质心（Hz 和 f0 的倍数）、起音和持续段的质心、平坦度、log-mel 频谱和 MFCC、高频比低频晚到的毫秒数
- 瑕疵：咔哒声、直流偏移、NaN

给 `--ref` 时逐项和参照录音比，每项有容差，超出的写成 findings。参照要是同一个音高的单音录音，采样率至少 44.1 kHz。仓库里有 `references/floor.json` 时，单项误差先除以 max(1, 这项在真实录音之间的中位误差)，自然差异不算缺陷。`excess` 是除掉之后的距离，1 大约等于同一音的两次录音。

`probe` 把一条轨道的音色放到音高 × 力度的网格上，每格测一遍，再检查多数声学乐器都有的规律：音准、力度越大越响也越亮、高音衰减更快、没有咔哒声。`--ref` 指向一个目录，文件名写成 `60.wav` 或 `60_0.9.wav`（音高_力度），对得上的格子会逐个比对。探针测的是干声分轨，不经过混响和总线。

## 安装

```bash
npm install visualtone
```

npm 注册表里目前没有这个包。仓库自带 `prepare` 脚本，用 git 地址安装时会先构建 `dist`。

## 快速开始

### 命令行使用

```bash
# 渲染乐谱文件
npx visualtone render examples/rising-pad.json -o output.wav

# 输出格式：16（默认，带 TPDF 抖动）| 24 | 32f（浮点，适合导入 DAW 再加工）
npx visualtone render examples/deep-house-v5.json -o out.wav --bit-depth 24

# 查看 JSON Schema
npx visualtone schema

# 听感报告：指标、问题清单、多面板 PNG
npx visualtone analyze examples/deep-house-v5.json --profile deep-house --json report.json --png report.png

# 只看某一块高清图：curves spectrogram stems bands loudness phase kick masking ssm space dynamics
npx visualtone analyze examples/deep-house-v5.json --panel spectrogram --png spectrogram.png

# 对比两次报告；从参考曲提取画像（WAV，不进仓库）
npx visualtone diff a.report.json b.report.json
npx visualtone profile ref.wav -o my-profile.json --name mine
```

### 编程使用

```typescript
import { ScoreSchema, render } from 'visualtone';
import { writeFileSync } from 'fs';

const score = ScoreSchema.parse({
  sampleRate: 44100,
  duration: 2.0,
  seed: 42,
  tracks: [
    {
      id: 'melody',
      hue: 180,
      channel: 0,
      points: [
        { t: 0.0, y: 60, size: 0.5 },
        { t: 1.0, y: 72, size: 0.7 },
        { t: 2.0, y: 60, size: 0.0 },
      ],
    },
  ],
});

const result = render(score);
writeFileSync('output.wav', result.wav);

console.log('Track report:', result.eventReport);
```

## 乐谱格式

乐谱是 JSON 文件，定义了一组彩色曲线轨道：

```json
{
  "sampleRate": 44100,
  "duration": 3.0,
  "seed": 42,
  "tracks": [
    {
      "id": "track-name",
      "hue": 200,
      "channel": 0,
      "points": [
        { "t": 0.0, "y": 48, "size": 0.3 },
        { "t": 1.0, "y": 60, "size": 0.5 },
        { "t": 2.0, "y": 72, "size": 0.4 }
      ]
    }
  ]
}
```

### 字段说明

- `sampleRate`: 音频采样率 (Hz)，默认 48000。视频成片用 48000；仓库里的音乐示例仍显式写 44100
- `duration`: 可选的显式持续时间 (秒)
- `seed`: 可选的随机种子，用于确定性合成
- `tracks`: 曲线轨道数组
  - `id`: 轨道唯一标识符
  - `hue`: 色调 (0-360°) 映射到音色
  - `channel`: `0` 或 `1` 只进左或右声道；`[0,1]` 立体声。底鼓和贝斯用 `[0,1]`，否则在立体声成片里会偏到一边
  - `points`: 曲线控制点数组
    - `t`: 时间 (秒)
    - `y`: 音高 (MIDI 音符 0-127，连续浮点数)
    - `size`: 归一化大小 0-1，映射到增益
    - `lightness`: 可选，0–1，控制低通截止频率（默认 0.5）

### 音高说明

音高使用 MIDI 音符编号 (连续浮点数)：

- 60 = C4 (中央 C)
- 69 = A4 (440 Hz)
- 可以使用小数，如 60.5 = C4 和 C#4 之间

## 示例

### 1. 上升的 Pad 音色

```json
{
  "sampleRate": 44100,
  "duration": 3.0,
  "tracks": [
    {
      "id": "rising-pad",
      "hue": 200,
      "channel": 0,
      "points": [
        { "t": 0.0, "y": 48, "size": 0.0 },
        { "t": 0.5, "y": 48, "size": 0.3 },
        { "t": 1.5, "y": 60, "size": 0.5 },
        { "t": 2.5, "y": 72, "size": 0.4 },
        { "t": 3.0, "y": 72, "size": 0.0 }
      ]
    }
  ]
}
```

### 2. 立体声双轨

```json
{
  "sampleRate": 44100,
  "duration": 4.0,
  "tracks": [
    {
      "id": "left-melody",
      "hue": 120,
      "channel": 0,
      "points": [
        { "t": 0.0, "y": 60, "size": 0.6 },
        { "t": 1.0, "y": 67, "size": 0.7 },
        { "t": 2.0, "y": 60, "size": 0.6 }
      ]
    },
    {
      "id": "right-harmony",
      "hue": 240,
      "channel": 1,
      "points": [
        { "t": 0.0, "y": 48, "size": 0.4 },
        { "t": 2.0, "y": 48, "size": 0.4 }
      ]
    }
  ]
}
```

### 3. 打击乐点状音符

```json
{
  "sampleRate": 44100,
  "duration": 2.0,
  "tracks": [
    {
      "id": "percussive-hits",
      "hue": 30,
      "channel": 0,
      "points": [
        { "t": 0.0, "y": 72, "size": 0.9 },
        { "t": 0.05, "y": 72, "size": 0.0 },
        { "t": 0.5, "y": 69, "size": 0.8 },
        { "t": 0.55, "y": 69, "size": 0.0 }
      ]
    }
  ]
}
```

## 音色映射

色调 (0-360°) 在波表引擎里映射到音色环上的家族，而不是一条从亮到暗的渐变：

| Hue | 家族 |
|-----|------|
| 0° | Kick |
| 30° | Bass |
| 70° | Pluck / arp |
| 110° | Bell / keys |
| 160° | Supersaw lead |
| 210° | Pad |
| 260° | Vocal / breath |
| 300° | Snare / clap |
| 335° | Hi-hat |

`lightness` 控制低通截止频率。`engine` 可以换成 `pluck`（拨弦）、`marimba`（打击条）、`epiano`（电钢）、`organ`（音轮风琴）、`drum`（鼓膜）、`wind`（长笛/单簧管）、`bow`（弓弦）、`piano`（钢琴）、`brass`（铜管/萨克斯）、`bass`（低音）、`reed`（双簧管/巴松）或 `cymbal`（镲）；这几种不跟波表插值。原声引擎按音符分配复音，一条轨可以叠和弦。

## API 参考

### `render(score: Score, options?: RenderOptions): RenderResult`

`RenderOptions` 还可以带 `stems: true`（分轨）、`clips`（外部音频，键是乐谱里的 `src`）和 `envelopes: { fps }`（按视频帧率采样的电平）。

渲染乐谱为音频。`WavOptions = { bitDepth?: 16 | 24 | 32, dither?: boolean, seed?: number }`。

**返回值：**

```typescript
{
  buffers: Float32Array[];      // 每个通道的音频缓冲区（内部全程浮点）
  sampleRate: number;
  duration: number;             // 秒
  eventReport: Array<{          // 每轨道统计信息
    trackId: string;
    channels: number[];
    samplesRendered: number;
    peakGain: number;
    rmsGain: number;
    onsets: number;
    spectralCentroid: number;   // Hz，Hann 窗 FFT 帧按能量加权
    gainReductionDb: number;    // 轨道压缩最大增益衰减
  }>;
  master: { peak: number; loudnessDb: number; gainReductionDb: number; limiterReductionDb: number };
  // loudnessDb：设了 master.lufs 时是实测 LUFS，否则是左声道 RMS dBFS
  wav: Buffer;                  // WAV 文件数据
  stems?: { id: string; l: Float32Array; r: Float32Array }[];
  inputs?: { src: string; sha256: string; sampleRate: number; channels: number; frames: number }[];
  envelopes?: { fps: number; tracks: Record<string, { onsets: number[]; level: Float32Array }>; master: { level: Float32Array } };
}
```

### 其他导出

- `ScoreSchema`: Zod schema，用于验证
- `getJsonSchema()`: 返回 JSON Schema
- `interpolateTrack()`: 曲线插值函数
- `hueToTimbre()`: 色调到音色向量
- `midiToFrequency()`: MIDI 音符到频率转换
- `writeWavFile(buffers, sampleRate, options?)` / `readWavFile()`: WAV 读写（16/24-bit PCM、32-bit float；读入也支持 WAVE_FORMAT_EXTENSIBLE）
- `mix()`: 把多段乐谱按本地时间合并
- `chord()` / `pattern()`: 和弦与节奏型，不进 schema
- `resampleBuffer()`: 采样轨用的重采样
- `Biquad` / `StereoEq` / `Compressor` / `lfoValue` / `keyframeAt`: 混音构件
- `swingTime()` / `applyGroove()`: swing 时间扭曲与 humanize

## AI 创作指南

使用 visualtone 让 AI 通过视觉思维创作音乐：

1. **描述曲线**: 告诉 AI "画一条从低到高的蓝色曲线"
2. **时间布局**: "在 2 秒内完成上升"
3. **音色选择**: "使用温暖的绿色音色 (hue 120)"
4. **节奏模式**: "每半秒一个点状音符 (快速 size 0→1→0 变化)"
5. **立体声效果**: "左声道高音，右声道低音"

**提示词示例：**

```
创建一个 3 秒的 visualtone 乐谱：
- 主旋律：蓝色曲线 (hue 240)，从 C4 平滑上升到 C5，音量从 0.3 渐强到 0.7
- 低音：红色曲线 (hue 0)，在 C2 持续，音量 0.5
```

## 开发

```bash
# 安装依赖
npm install

# 构建
npm run build

# 运行测试
npm test

# 开发模式 (监听)
npm run dev
```

## 视频

采样轨、音效、分段和按帧电平是给画面用的。TTS 不在这个库里：外面生成 WAV，再当采样轨交进来。

### 采样轨

```json
{ "id": "voice", "role": "voice", "clips": [{ "src": "tts/scene2.wav", "at": 3.2, "gain": 1, "fadeIn": 0.05, "fadeOut": 0.05, "trim": [0, 4.1] }] }
```

`clip` 是只有一个片段时的简写。`render` 不读文件，调用方把解码后的音频放进 `options.clips`，键是 `src`。命令行会按乐谱所在目录读取，并把 sha256 记进 `result.inputs` 和分析报告。采样率不同时用加窗 sinc 重采样。

其他轨可以写 `duck: { "by": "voice", "amount": 0.5, "holdMs": 80, "releaseMs": 280, "band": [1000, 4000] }`。`holdMs` 避免字与字之间抽动，`band` 只压这一段频率。

### 音效

```json
{ "id": "fx", "sfx": [{ "sfx": "whoosh", "t": 4.0, "duration": 0.4, "size": 0.7, "direction": 0.6 }] }
```

`whoosh`、`riser`、`swell`、`impact`、`pop`、`tick`、`key`、`shimmer` 会展开成现有的曲线轨。参数见 `llms.txt`。

### 分段

```typescript
import { mix } from 'visualtone';

const { score, warnings } = mix([
  { score: scene1, at: 0 },
  { score: scene2, at: 4.0, fadeIn: 0.2, fadeOut: 0.3, prefix: 's2/' },
], master);
```

每段先在自己的时间里展开写法和 swing，再平移。子段的 `master` 被忽略。JSON 可以写 `{ "segments": [{ "src": "scene2.json", "at": 4.0 }] }`，由命令行读取。

轨道 `offset` 是单轨平移。`seed` 固定这条轨的噪声，合并后不会因为序号变化而变音色。

### 交给画面

```typescript
const result = render(score, { envelopes: { fps: 30 } });
result.envelopes.tracks.kick.onsets; // 秒
result.envelopes.tracks.kick.level;  // 第 i 帧覆盖 [i/fps, (i+1)/fps)
result.envelopes.master.level;
```

命令行：`visualtone render score.json -o out.wav --envelopes env.json --fps 30`。

### 音乐单位

有 `bpm` 时，点和音符可以写 `at: "4:2"`（第 4 小节第 2 拍，从 1 起）、`pitch: "A3"`、`len: "1/8"`。`meter` 默认 `[4, 4]`。`chord("Am7", "A3")` 和 `pattern("x...x...x.x.", { bpm, y })` 是函数，不进 schema。

### 原声引擎

`engine` 为 `pluck`、`marimba`、`epiano`、`organ`、`drum`、`wind`、`bow`、`piano`、`brass`、`bass`、`reed` 或 `cymbal` 时按音符分配复音，重叠的音符不会被截短。色调不跟波表插值。

`organ` 是九根拉杆的加法音轮：16′、5⅓′、8′、4′、2⅔′、2′、1⅗′、1⅓′、1′。色调 0° 和 360° 是闭管长笛（8′ 加上奇次泛音），180° 是全开，中间经过开管长笛。低音管开口更慢。`size` 和 `lightness` 再把高频拉杆打开，所以更用力更亮。松开后按 `release` 做到大约 −60 dB。这一版没有莱斯利，音高保持稳定。持续时整排音管一起有大约 −30 dB 的不规则音量起伏（8–20 Hz）。16′ 收在 8′ 下面，按下的键仍是这个音。

`pluck` 是带分数延迟的拨弦。延迟长度对齐音高，环路里的平均滤波和色散全通的相位都补回去，所以高音不再整体偏低。色调 0°–139° 是钢弦吉他，140°–279° 是尼龙吉他，280°–360° 是竖琴。竖琴拨在弦的中段，环得更长，输出再低通一次。`size` 把拨点推向琴码，音更亮；`lightness` 让弦响得更久。钢弦的琴体在 118 Hz，尼龙在 150 Hz，竖琴在 220 Hz。

`drum` 是圆形鼓膜的模态合成，频率比取贝塞尔零点。色调 0°–44° 是底鼓（鼓槌有一点音高下落），45°–139° 是通鼓，140°–229° 是军鼓（膜加沙带噪声），230°–309° 是康加，310°–360° 是框鼓。音越高衰减越快。`size` 把高阶模态和击槌打得更响、留得更久，轻击则更暗；`lightness` 靠近 1 时更像打在鼓心。击槌先低通，底鼓再压低一截，所以敲击是闷的；军鼓沙带单独再滤一次。最低音可以到 20 Hz。

`wind` 是吹管。色调 0°–179° 是长笛：开管，延迟一整个周期。饱和本身只有奇次，偶次谐波在环路里另补，强奏时二次谐波接近基频；高音少一些环路损耗。180°–360° 是单簧管：闭管，半周期延迟再反相，管体本身是奇次谐波。低音区几乎只剩基频，过了换音区之后偶次谐波从管外补上，高音区二次谐波可以盖过基频。轻吹更暗、开口更慢。环路里用奇对称的饱和把能量补上，过零点仍落在延迟上，所以音高就是按下的那个音。`size` 加大吹气并打开环路滤波，所以更用力更亮。长笛的环路里有一个高通，直流不会越积越大、把气流推进饱和后让音熄掉。音高像演奏者一样有几个音分的漂移。音量加在管腔外面，另有一层 8–20 Hz 的不规则起伏：长笛大约 −30 dB，单簧管大约 −33 dB。

`brass` 是唇簧，用一列谐波，斜率随力度打开。色调 0°–89° 小号，90°–179° 圆号（高音即使强奏也更暗），180°–239° 长号，240°–299° 大号，300°–360° 萨克斯。相位错开，避免亮频谱排成锯齿。喇叭共振按乐器放在不同频段。`size` 把频谱摊平并带上一点噪声。音高有大约 1.5 音分的漂移（大号 3）。持续音的音量另有 8–20 Hz 的不规则起伏：小号大约 −30 dB，圆号 −32，长号 −30，大号 −26，萨克斯 −35。

`bass` 是低音弦。色调 0°–179° 是弓奏低音提琴，琴体大约在 70 Hz，揉弦更慢更浅（4.9 Hz ±6 音分），音量另有大约 −27 dB 的 8–20 Hz 起伏。180°–360° 是电贝斯：圆的持续音，加上一段很快消失的手指噪声，没有这层起伏。最低可以到大约 28 Hz。

`reed` 是双簧管。色调 0°–179° 是双簧管，鼻音共振大约在 1500 Hz。180°–360° 是巴松，共振大约在 540 Hz。锥形管每一阶谐波都有。`size` 把频谱摊开。音高有大约 1.5 音分的漂移。持续音的音量有 8–20 Hz 的不规则起伏：双簧管大约 −32 dB，巴松大约 −31 dB。

`cymbal` 是无音高的金属片。色调 0°–119° 是闭镲，120°–199° 是开镲，200°–360° 是吊镲。音高决定片子的大小，高音更亮、更小。松开时闭镲会被捂住。

`bow` 是弓弦的赫姆霍兹运动，用按指数衰减的谐波叠成，拐角是圆的。色调 0°–119° 是小提琴，120°–239° 是中提琴，240°–360° 是大提琴。`size` 让频谱落得更慢，并把琴体前面的低通打开。大约 0.2 秒后开始揉弦：小提琴约 5.6 Hz ±12 音分，中提琴 5.4 Hz ±11，大提琴 5.2 Hz ±9，音量也跟着轻微起伏。揉弦之上还有一层不规则的 8–20 Hz 音量起伏：小提琴大约 −26 dB，中提琴 −26，大提琴 −25。

`piano` 是击弦。分音按 `n·√(1+B·n²)` 略微偏高，B 从低音大约 0.00009 升到高音大约 0.002。高音和高次分音死得更快。两根弦差大约 0.7 音分。`size` 让槌子更硬，高次分音更响也留得更久。色调越靠近 360°，槌子越暗。琴板有一层跟着弦一起衰减的噪声。

`marimba` 按色调换音条：0°–119° 马林巴（1 : 3.92 : 10.08 : 15.8），120°–199° 木琴，200°–279° 颤音琴（带慢速颤音），280°–360° 钟琴。音越高衰减越快，钟琴的音高幂次更缓，所以高音还留得住。高阶模态按力度的 1.4 次方打开，轻击接近正弦；马林巴最低的几根音条才带上约 10 倍的模态。击打时有一段很短的槌击噪声。按住时按音条自己的衰减响，松开后在 `release` 里收掉。

波表音符在曲线收到静音后，会把大约 2 ms 的增益平滑走完，不再在结尾阶跃到零。`release` 仍是在这之后另加的尾巴。

音色对照用的是录音，不是 FluidSynth 或 GM 音色库。`node scripts/fetch-references.mjs` 拉取这三套单音：TinySOL（Ircam 录音，CC BY 4.0，长笛、单簧管、双簧管、巴松、小提琴、中提琴、大提琴、低音提琴、小号、圆号、长号、大号、萨克斯）、VSCO 2 社区版（CC0，马林巴、木琴、钟琴、竖琴、管风琴、底鼓、军鼓、康加、定音鼓）、Salamander Grand Piano V3（雅马哈 C5，CC BY 3.0）。`node scripts/compare-references.mjs` 把现有引擎和这些录音比，结果写到 `references/gap.json`。音频不进仓库。距离 0 表示和录音一样，单项误差封顶 3。`node scripts/measure-floor.mjs` 用 TinySOL 里小提琴和大提琴同一音、不同弦的 404 对录音，量每项的中位误差，写到 `references/floor.json`。泛音比例的地板是 3.90，音高是 1.66，这两项真录音自己就差得远；8–20 Hz 微起伏的地板只有 0.36。对照时单项先除掉这个地板。超出地板的平均距离：单簧管 1.52，长笛 1.40，双簧管 1.50，巴松 1.54，小号 1.58，圆号 1.62，长号 1.54，大号 1.60，萨克斯 1.56，管风琴 1.54，小提琴 1.74，中提琴 1.73，大提琴 1.76，低音提琴 1.74，钢琴 1.83，马林巴 1.72，木琴 1.60，竖琴 2.06，底鼓 2.00，军鼓 2.22，康加 1.70，定音鼓 2.19。钟琴 2.06。1 表示和同一音的两次录音一样远。持续音的 8–20 Hz 微起伏跟录音对齐，两边都在大约 −25 到 −35 dB，单项相差大约 1 dB。电贝斯、尼龙吉他、闭镲、开镲和吊镲没有录音对照。样本标注的音高如果和录音相差至少六个半音，对照时改用录音里实际的音高。

### 旁白画像

`visualtone analyze score.json --profile voiceover-bed` 检查：有旁白时音乐有没有让出 1–4 kHz、音效是否挡住音乐、音效是否太密。轨上写 `role: "voice" | "sfx" | "music"`。`master.lufs` 用 BS.1770 对齐目标响度，设置后不再用 RMS 的 `master.loudness`。

## 技术细节

- **插值**: 按 ease 规则在曲线控制点之间过渡
- **合成**: 带限 mip 波表 + 齐奏 + 共振 SVF（左右声道独立状态）+ 噪声/瞬态/音高包络
- **混音**: 每轨 EQ/压缩、LFO、自动化；大厅和房间是两条共享的立体声 FDN，延迟也是共享的
- **主总线**: EQ → 饱和 → 胶水压缩 → 软削波 → 响度对齐 → 前瞻真峰值限幅（默认 −1 dBTP，5 ms 前瞻）
- **输出**: 内部浮点，写出时一次量化；16/24-bit 默认 TPDF 抖动
- **确定性**: 相同的乐谱和种子产生逐字节相同的 WAV（抖动噪声也由种子决定）

## 限制与未来计划

- ✅ 曲线到音频渲染、多轨立体声
- ✅ hue 音色环 + 参数覆盖
- ✅ 混响、延迟、侧链、EQ、压缩、LFO、自动化、swing
- ✅ 听感分析（LUFS、遮蔽、画像对比、PNG 报告），含 `voiceover-bed`
- ✅ 前瞻真峰值限幅器
- ✅ 采样轨（引用外部 WAV）、音效预设、分段合并、按帧电平
- ✅ 拨弦 / 马林巴 / 电钢
- ⏳ SF2 采样音色
- ⏳ Remotion 集成

## 许可证

MIT

## 贡献

欢迎提交 issue 和 pull request！
