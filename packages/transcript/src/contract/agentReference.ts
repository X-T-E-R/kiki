import { z } from 'zod';

export const agentReferenceSchema = z.object({
  refId: z.string().min(1), profile: z.string().min(1), executor: z.string().min(1),
  configuration: z.enum(['native', 'profile']), label: z.string(), engine_label: z.string().optional(),
});
export const agentRunSourceSchema = agentReferenceSchema.extend({ messageId: z.string().min(1) });

export interface AgentReference {
  readonly refId: string;
  readonly profile: string;
  readonly executor: string;
  readonly configuration: 'native' | 'profile';
  readonly label: string;
  readonly engine_label?: string;
}

export interface AgentRunSource extends AgentReference {
  readonly messageId: string;
}
