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

### 曲线语法 (v0.2)

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

### Hue 音色环（v3 电子乐引擎）

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

轨道可选：`space`（混响）、`echo`（延迟）、`duck`（侧链）、`saturation`、`channel: [0,1]` 立体声路由；乐谱级 `bpm` 与 `master` 总线响度/效果。

### 混音、调制与律动

信号链（每轨）：曲线 → 音色 Voice → `eq` → `comp` → 增益/声像 LFO 与自动化 → `duck` → 混响/延迟发送 → 主总线 `comp` → 软削波 → 响度对齐。

| 字段 | 作用 | 示例 |
|------|------|------|
| `eq` | RBJ 双二阶：`lowCut` / `highCut`（Hz）、`lowShelf` / `highShelf` `{freq, gain}`、`peaks` `[{freq, gain, q}]` | `{ "lowCut": 180, "peaks": [{ "freq": 600, "gain": -2, "q": 1 }] }` |
| `comp` | 软拐点立体声联动压缩：`threshold` `ratio` `attackMs` `releaseMs` `knee` `makeup` | `{ "threshold": -14, "ratio": 4, "attackMs": 8 }` |
| `lfo` | `[{ target, depth, rate|beats, shape, phase }]`；target = `lightness`（滤波扫频）/ `pitch`（颤音，半音）/ `gain`（tremolo）/ `pan`（±1 = 左右） | `{ "target": "pitch", "depth": 0.16, "rate": 5.3 }` |
| `automation` | 关键帧线性插值：`lightness`（加到亮度上的偏移）、`gain`（乘数） | `{ "gain": [{ "t": 0, "v": 0.6 }, { "t": 4, "v": 1 }] }` |
| `swing` | 乐谱级（或轨道覆盖）0 = 平直，1 = 三连音；`swingGrid` 8 或 16 | `"swing": 0.42` |
| `humanize` | 确定性微抖动：`timeMs`、`size` | `{ "timeMs": 4, "size": 0.25 }` |
| `master.comp` | 总线胶水压缩，阈值相对目标响度 | `{ "threshold": -9, "ratio": 2 }` |

完整示例见 `examples/deep-house-v5.json`（由 `examples/scripts/deep-house-v5.mjs` 生成）。

详见 `llms.txt`（面向 AI 作者的速查与示例）。

### 多轨道与立体声

- 每条轨道是一条单色曲线 (每条轨道一个色调值)
- `channel: 0` / `1` 把单声道曲线送到左 / 右；`channel: [0,1]` 走立体声（居中，齐奏与 `pan` LFO 会展开声像）
- 立体声乐谱里只写 `channel: 0` 的轨道只在左声道出声，底鼓、贝斯请用 `[0,1]`
- 多轨道 = 多条平行曲线
- 音乐 = 这些值随时间变化 (平滑插值或阶跃式打击乐)

## 安装

```bash
npm install visualtone
```

## 快速开始

### 命令行使用

```bash
# 渲染乐谱文件
npx visualtone render examples/rising-pad.json -o output.wav

# 输出格式：16（默认，带 TPDF 抖动）| 24 | 32f（浮点，适合导入 DAW 再加工）
npx visualtone render examples/deep-house-v5.json -o out.wav --bit-depth 24

# 查看 JSON Schema
npx visualtone schema
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

- `sampleRate`: 音频采样率 (Hz)，默认 44100
- `duration`: 可选的显式持续时间 (秒)
- `seed`: 可选的随机种子，用于确定性合成
- `tracks`: 曲线轨道数组
  - `id`: 轨道唯一标识符
  - `hue`: 色调 (0-360°) 映射到音色
  - `channel`: 通道索引 (0 = 单声道总线，1 = 第二通道，等等)
  - `points`: 曲线控制点数组
    - `t`: 时间 (秒)
    - `y`: 音高 (MIDI 音符 0-127，连续浮点数)
    - `size`: 归一化大小 0-1，映射到增益
    - `lightness`: 可选，保留供将来使用

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

色调 (0-360°) 被映射到连续的合成器参数：

- **brightness (亮度)**: 控制滤波器截止频率和高频泛音
- **thickness (厚度)**: 控制泛音的厚度和丰富度
- **noise (噪声)**: 添加噪声纹理

不同的色调产生不同的音色特征：

- 红色 (0°): 明亮、清晰
- 绿色 (120°): 柔和、温暖
- 蓝色 (240°): 深沉、共鸣

## API 参考

### `render(score: Score, options?: { wav?: WavOptions }): RenderResult`

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
  master: { peak: number; loudnessDb: number; gainReductionDb: number };
  wav: Buffer;                  // WAV 文件数据
}
```

### 其他导出

- `ScoreSchema`: Zod schema，用于验证
- `getJsonSchema()`: 返回 JSON Schema
- `interpolateTrack()`: 曲线插值函数
- `hueToSynthParams()`: 色调到合成器参数映射
- `midiToFrequency()`: MIDI 音符到频率转换
- `SimpleSynth`: 合成器类
- `writeWavFile(buffers, sampleRate, options?)`: WAV 写入（16/24-bit PCM + TPDF 抖动，或 32-bit float）
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

## 技术细节

- **插值**: 按 ease 规则在曲线控制点之间过渡
- **合成**: 带限 mip 波表 + 齐奏 + 共振 SVF（左右声道独立状态）+ 噪声/瞬态/音高包络
- **混音**: 每轨 EQ/压缩、LFO、自动化；每轨独立混响/延迟实例（尾音不串轨）
- **主总线**: 胶水压缩 → 软削波 → 响度对齐 → 峰值上限 0.891
- **输出**: 内部浮点，写出时一次量化；16/24-bit 默认 TPDF 抖动
- **确定性**: 相同的乐谱和种子产生逐字节相同的 WAV（抖动噪声也由种子决定）

## 限制与未来计划

- ✅ 曲线到音频渲染、多轨立体声
- ✅ hue 音色环 + 参数覆盖
- ✅ 混响、延迟、侧链、EQ、压缩、LFO、自动化、swing
- ⏳ 采样鼓 / 采样音色（尚未引入）
- ⏳ 前瞻式限幅器（目前峰值上限是整体缩放）
- ⏳ Remotion 集成

## 许可证

MIT

## 贡献

欢迎提交 issue 和 pull request！
