import { Point } from './schema.js';
export interface SampledPoint {
    y: number;
    size: number;
}
export declare function interpolateTrack(points: Point[], time: number): SampledPoint | null;
export declare function getTrackDuration(points: Point[]): number;
//# sourceMappingURL=interpolator.d.ts.map