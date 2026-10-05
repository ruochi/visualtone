import { z } from 'zod';
export declare const PointSchema: z.ZodObject<{
    t: z.ZodNumber;
    y: z.ZodNumber;
    size: z.ZodNumber;
    lightness: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    t: number;
    y: number;
    size: number;
    lightness?: number | undefined;
}, {
    t: number;
    y: number;
    size: number;
    lightness?: number | undefined;
}>;
export declare const TrackSchema: z.ZodObject<{
    id: z.ZodString;
    hue: z.ZodNumber;
    channel: z.ZodDefault<z.ZodNumber>;
    points: z.ZodArray<z.ZodObject<{
        t: z.ZodNumber;
        y: z.ZodNumber;
        size: z.ZodNumber;
        lightness: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        t: number;
        y: number;
        size: number;
        lightness?: number | undefined;
    }, {
        t: number;
        y: number;
        size: number;
        lightness?: number | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    id: string;
    hue: number;
    channel: number;
    points: {
        t: number;
        y: number;
        size: number;
        lightness?: number | undefined;
    }[];
}, {
    id: string;
    hue: number;
    points: {
        t: number;
        y: number;
        size: number;
        lightness?: number | undefined;
    }[];
    channel?: number | undefined;
}>;
export declare const ScoreSchema: z.ZodObject<{
    sampleRate: z.ZodDefault<z.ZodNumber>;
    duration: z.ZodOptional<z.ZodNumber>;
    seed: z.ZodOptional<z.ZodNumber>;
    tracks: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        hue: z.ZodNumber;
        channel: z.ZodDefault<z.ZodNumber>;
        points: z.ZodArray<z.ZodObject<{
            t: z.ZodNumber;
            y: z.ZodNumber;
            size: z.ZodNumber;
            lightness: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            t: number;
            y: number;
            size: number;
            lightness?: number | undefined;
        }, {
            t: number;
            y: number;
            size: number;
            lightness?: number | undefined;
        }>, "many">;
    }, "strip", z.ZodTypeAny, {
        id: string;
        hue: number;
        channel: number;
        points: {
            t: number;
            y: number;
            size: number;
            lightness?: number | undefined;
        }[];
    }, {
        id: string;
        hue: number;
        points: {
            t: number;
            y: number;
            size: number;
            lightness?: number | undefined;
        }[];
        channel?: number | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    sampleRate: number;
    tracks: {
        id: string;
        hue: number;
        channel: number;
        points: {
            t: number;
            y: number;
            size: number;
            lightness?: number | undefined;
        }[];
    }[];
    duration?: number | undefined;
    seed?: number | undefined;
}, {
    tracks: {
        id: string;
        hue: number;
        points: {
            t: number;
            y: number;
            size: number;
            lightness?: number | undefined;
        }[];
        channel?: number | undefined;
    }[];
    sampleRate?: number | undefined;
    duration?: number | undefined;
    seed?: number | undefined;
}>;
export type Point = z.infer<typeof PointSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type Score = z.infer<typeof ScoreSchema>;
export declare function getJsonSchema(): any;
//# sourceMappingURL=schema.d.ts.map