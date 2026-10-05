export interface SynthParams {
  brightness: number;
  thickness: number;
  noise: number;
}

export function hueToSynthParams(hue: number): SynthParams {
  const h = ((hue % 360) + 360) % 360;
  
  const brightness = Math.sin((h / 360) * Math.PI * 2) * 0.5 + 0.5;
  
  const thickness = Math.cos((h / 360) * Math.PI * 3) * 0.5 + 0.5;
  
  const noise = Math.sin((h / 360) * Math.PI * 5) * 0.3 + 0.3;
  
  return { brightness, thickness, noise };
}

export function midiToFrequency(midiNote: number): number {
  return 440 * Math.pow(2, (midiNote - 69) / 12);
}

export class SimpleSynth {
  private phase: number = 0;
  private prevFreq: number = 0;
  private prevGain: number = 0;
  
  constructor(
    private sampleRate: number,
    private seed: number = 0,
  ) {}
  
  private seededRandom(): number {
    this.seed = (this.seed * 9301 + 49297) % 233280;
    return this.seed / 233280;
  }
  
  synthesize(
    frequency: number,
    gain: number,
    params: SynthParams,
    numSamples: number,
  ): Float32Array {
    const buffer = new Float32Array(numSamples);
    
    const smoothing = 0.99;
    let currentFreq = this.prevFreq;
    let currentGain = this.prevGain;
    
    const targetFreq = frequency;
    const targetGain = gain;
    
    for (let i = 0; i < numSamples; i++) {
      currentFreq = currentFreq * smoothing + targetFreq * (1 - smoothing);
      currentGain = currentGain * smoothing + targetGain * (1 - smoothing);
      
      const omega = (2 * Math.PI * currentFreq) / this.sampleRate;
      this.phase += omega;
      
      if (this.phase > 2 * Math.PI) {
        this.phase -= 2 * Math.PI;
      }
      
      let sample = 0;
      
      const fundamental = Math.sin(this.phase);
      const harmonics = 
        Math.sin(this.phase * 2) * 0.3 * params.thickness +
        Math.sin(this.phase * 3) * 0.15 * params.thickness +
        Math.sin(this.phase * 4) * 0.1 * params.brightness;
      
      const oscillator = fundamental + harmonics;
      
      const noiseValue = (this.seededRandom() - 0.5) * 2 * params.noise * 0.1;
      
      sample = oscillator * (1 - params.noise * 0.3) + noiseValue;
      
      const filterCutoff = params.brightness;
      sample = sample * filterCutoff;
      
      buffer[i] = sample * currentGain;
    }
    
    this.prevFreq = currentFreq;
    this.prevGain = currentGain;
    
    return buffer;
  }
  
  reset() {
    this.phase = 0;
    this.prevFreq = 0;
    this.prevGain = 0;
  }
}
