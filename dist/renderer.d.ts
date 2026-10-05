import { Score } from './schema.js';
export interface RenderResult {
    buffers: Float32Array[];
    sampleRate: number;
    duration: number;
    eventReport: {
        trackId: string;
        channel: number;
        samplesRendered: number;
        peakGain: number;
        rmsGain: number;
    }[];
    wav: Buffer;
}
export declare function render(score: Score): RenderResult;
//# sourceMappingURL=renderer.d.ts.map