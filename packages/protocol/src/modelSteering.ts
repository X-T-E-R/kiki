import { z } from 'zod';

export const modelSteeringCadenceSchema = z.object({
  steering_on_turn: z.boolean().optional(),
  steering_on_input: z.boolean().optional(),
  steering_interval_steps: z.number().int().nonnegative().safe().optional(),
});
