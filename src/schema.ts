import { z } from 'zod';

export const PointSchema = z.object({
  t: z.number().describe('Time in seconds'),
  y: z.number().describe('Pitch as MIDI note float (0-127, continuous)'),
  size: z.number().min(0).max(1).describe('Normalized size 0-1 mapping to gain'),
  lightness: z.number().min(0).max(1).optional().describe('Reserved for future use'),
});

export const TrackSchema = z.object({
  id: z.string().describe('Unique track identifier'),
  hue: z.number().min(0).max(360).describe('Hue in degrees (0-360) mapping to timbre'),
  channel: z.number().int().min(0).default(0).describe('Channel index (0 = mono bus)'),
  points: z.array(PointSchema).describe('Curve control points, sorted by time'),
});

export const ScoreSchema = z.object({
  sampleRate: z.number().int().positive().default(44100).describe('Audio sample rate in Hz'),
  duration: z.number().positive().optional().describe('Optional explicit duration in seconds'),
  seed: z.number().int().optional().describe('Optional random seed for deterministic synthesis'),
  tracks: z.array(TrackSchema).describe('Array of curve tracks'),
});

export type Point = z.infer<typeof PointSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type Score = z.infer<typeof ScoreSchema>;

export function getJsonSchema() {
  const zodToJsonSchema = (schema: z.ZodType): any => {
    if (schema instanceof z.ZodObject) {
      const shape = schema._def.shape();
      const properties: any = {};
      const required: string[] = [];
      
      for (const [key, value] of Object.entries(shape)) {
        const zodValue = value as z.ZodType;
        properties[key] = zodToJsonSchema(zodValue);
        
        if (!(zodValue instanceof z.ZodOptional) && !(zodValue instanceof z.ZodDefault)) {
          required.push(key);
        }
      }
      
      const result: any = {
        type: 'object',
        properties,
      };
      
      if (required.length > 0) {
        result.required = required;
      }
      
      return result;
    }
    
    if (schema instanceof z.ZodArray) {
      return {
        type: 'array',
        items: zodToJsonSchema(schema.element),
      };
    }
    
    if (schema instanceof z.ZodString) {
      return { type: 'string' };
    }
    
    if (schema instanceof z.ZodNumber) {
      const result: any = { type: 'number' };
      const checks = (schema as any)._def.checks || [];
      
      for (const check of checks) {
        if (check.kind === 'min') result.minimum = check.value;
        if (check.kind === 'max') result.maximum = check.value;
        if (check.kind === 'int') result.type = 'integer';
      }
      
      return result;
    }
    
    if (schema instanceof z.ZodOptional) {
      return zodToJsonSchema(schema.unwrap());
    }
    
    if (schema instanceof z.ZodDefault) {
      const inner = zodToJsonSchema(schema.removeDefault());
      inner.default = schema._def.defaultValue();
      return inner;
    }
    
    return {};
  };
  
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Visualtone Score',
    description: 'Music as animated colored curves - audio as a pure function of visual data',
    ...zodToJsonSchema(ScoreSchema),
  };
}
