import { interpolateTrack, getTrackDuration } from './interpolator.js';
import { SimpleSynth, hueToSynthParams, midiToFrequency } from './synth.js';
import { writeWavFile } from './wav.js';
export function render(score) {
    const sampleRate = score.sampleRate;
    let duration = score.duration;
    if (!duration) {
        duration = Math.max(...score.tracks.map(track => getTrackDuration(track.points)), 0);
    }
    const numSamples = Math.ceil(duration * sampleRate);
    const channelMap = new Map();
    const maxChannel = Math.max(...score.tracks.map(t => t.channel), 0);
    for (let ch = 0; ch <= maxChannel; ch++) {
        channelMap.set(ch, new Float32Array(numSamples));
    }
    const eventReport = [];
    for (const track of score.tracks) {
        const synth = new SimpleSynth(sampleRate, score.seed);
        const synthParams = hueToSynthParams(track.hue);
        const channelBuffer = channelMap.get(track.channel);
        const chunkSize = Math.floor(sampleRate / 100);
        let samplesRendered = 0;
        let sumSquares = 0;
        let peakGain = 0;
        for (let i = 0; i < numSamples; i += chunkSize) {
            const actualChunkSize = Math.min(chunkSize, numSamples - i);
            const time = i / sampleRate;
            const sampled = interpolateTrack(track.points, time);
            if (sampled) {
                const frequency = midiToFrequency(sampled.y);
                const gain = sampled.size;
                const chunk = synth.synthesize(frequency, gain, synthParams, actualChunkSize);
                for (let j = 0; j < actualChunkSize; j++) {
                    const sample = chunk[j];
                    channelBuffer[i + j] += sample;
                    sumSquares += sample * sample;
                    peakGain = Math.max(peakGain, Math.abs(sample));
                    samplesRendered++;
                }
            }
            else {
                synth.reset();
            }
        }
        const rmsGain = samplesRendered > 0 ? Math.sqrt(sumSquares / samplesRendered) : 0;
        eventReport.push({
            trackId: track.id,
            channel: track.channel,
            samplesRendered,
            peakGain,
            rmsGain,
        });
    }
    const buffers = Array.from(channelMap.values());
    for (const buffer of buffers) {
        let peak = 0;
        for (let i = 0; i < buffer.length; i++) {
            peak = Math.max(peak, Math.abs(buffer[i]));
        }
        if (peak > 1.0) {
            const scale = 0.95 / peak;
            for (let i = 0; i < buffer.length; i++) {
                buffer[i] *= scale;
            }
        }
    }
    const wav = writeWavFile(buffers, sampleRate);
    return {
        buffers,
        sampleRate,
        duration,
        eventReport,
        wav,
    };
}
//# sourceMappingURL=renderer.js.map