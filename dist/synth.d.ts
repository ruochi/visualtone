export interface SynthParams {
    brightness: number;
    thickness: number;
    noise: number;
}
export declare function hueToSynthParams(hue: number): SynthParams;
export declare function midiToFrequency(midiNote: number): number;
export declare class SimpleSynth {
    private sampleRate;
    private seed;
    private phase;
    private prevFreq;
    private prevGain;
    constructor(sampleRate: number, seed?: number);
    private seededRandom;
    synthesize(frequency: number, gain: number, params: SynthParams, numSamples: number): Float32Array;
    reset(): void;
}
//# sourceMappingURL=synth.d.ts.map