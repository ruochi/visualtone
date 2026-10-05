# visualtone

**音乐即动画彩色曲线 — 音频作为视觉数据的纯函数**

visualtone 是一个 TypeScript 库，它将彩色曲线转换为音频。每条曲线的时间、音高、音量和音色都由其视觉属性定义。

## 核心概念

### 视觉到音频的映射

- **x 轴** → 时间 (秒)
- **y 轴** → 音高 (MIDI 音符，0-127，连续浮点数)
- **点的大小** → 音量 (0-1 归一化值映射到增益)
- **色调 (Hue)** → 音色 (0-360° 映射到连续的合成器参数)
- **亮度 (Lightness)** → 保留供将来使用

### 多轨道与立体声

- 每条轨道是一条单色曲线 (每条轨道一个色调值)
- 立体声 = 两条单声道轨道 (L 和 R)，而不是声像参数
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

### `render(score: Score): RenderResult`

渲染乐谱为音频。

**返回值：**

```typescript
{
  buffers: Float32Array[];      // 每个通道的音频缓冲区
  sampleRate: number;            // 采样率
  duration: number;              // 持续时间 (秒)
  eventReport: Array<{           // 每轨道统计信息
    trackId: string;
    channel: number;
    samplesRendered: number;
    peakGain: number;
    rmsGain: number;
  }>;
  wav: Buffer;                   // WAV 文件数据
}
```

### 其他导出

- `ScoreSchema`: Zod schema，用于验证
- `getJsonSchema()`: 返回 JSON Schema
- `interpolateTrack()`: 曲线插值函数
- `hueToSynthParams()`: 色调到合成器参数映射
- `midiToFrequency()`: MIDI 音符到频率转换
- `SimpleSynth`: 合成器类
- `writeWavFile()`: WAV 文件写入工具

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

- **插值**: 线性插值，曲线控制点之间平滑过渡
- **合成**: 简单的减法合成器 (振荡器 + 滤波器 + 包络)
- **间隙处理**: 轨道点之外的时间区域产生静音
- **归一化**: 自动峰值归一化防止削波
- **确定性**: 相同的乐谱和种子产生相同的音频

## 限制与未来计划

当前版本 (v0.1) 保持最小范围：

- ✅ 基础曲线到音频渲染
- ✅ 多轨道和多通道
- ✅ 简单的音色映射
- ⏳ 混音总线处理 (未来)
- ⏳ 效果器 (混响、延迟等) (未来)
- ⏳ Remotion 集成 (未来)

## 许可证

MIT

## 贡献

欢迎提交 issue 和 pull request！
