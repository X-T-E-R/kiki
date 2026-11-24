import { z } from 'zod';
import { messageContentSchema } from '../message';
import { promptThinkingSchema, promptTurnUsageSchema } from './prompt';

export const llmCompleteMessageSchema = /* @__PURE__ */ z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(messageContentSchema).min(1)]),
}).strict();
export type LlmCompleteMessage = z.infer<typeof llmCompleteMessageSchema>;

export const llmCompleteContextFromSchema = /* @__PURE__ */ z.object({
  session_id: z.string().min(1),
  as_of_seq: z.number().int().nonnegative().optional(),
  agent_id: z.string().min(1).optional(),
}).strict();
export type LlmCompleteContextFrom = z.infer<typeof llmCompleteContextFromSchema>;

export const llmCompleteRequestSchema = /* @__PURE__ */ z.object({
  model: z.string().min(1).optional(),
  system: z.string().optional(),
  messages: z.array(llmCompleteMessageSchema).min(1),
  output_schema: z.record(z.string(), z.unknown()).optional(),
  include_thinking: z.boolean().optional(),
  thinking: promptThinkingSchema.optional(),
  max_tokens: z.number().int().min(1).optional(),
  stream: z.boolean().optional(),
  context_from: llmCompleteContextFromSchema.optional(),
}).strict();
export type LlmCompleteRequest = z.infer<typeof llmCompleteRequestSchema>;

export const llmCompleteResponseSchema = /* @__PURE__ */ z.object({
  model: z.string().min(1),
  text: z.string(),
  structured_output: z.unknown().optional(),
  thinking: z.string().optional(),
  stop_reason: z.string().optional(),
  usage: promptTurnUsageSchema.optional(),
});
export type LlmCompleteResponse = z.infer<typeof llmCompleteResponseSchema>;

export const llmCompleteStreamEventSchema = /* @__PURE__ */ z.discriminatedUnion('type', [
  z.object({ type: z.literal('started'), model: z.string().min(1) }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('thinking_delta'), text: z.string() }),
  z.object({ type: z.literal('reset') }),
  z.object({
    type: z.literal('completed'),
    model: z.string().min(1),
    text: z.string(),
    structured_output: z.unknown().optional(),
    thinking: z.string().optional(),
    stop_reason: z.string().optional(),
    usage: promptTurnUsageSchema.optional(),
  }),
  z.object({ type: z.literal('cancelled') }),
  z.object({ type: z.literal('failed'), message: z.string(), code: z.string().optional() }),
]);
export type LlmCompleteStreamEvent = z.infer<typeof llmCompleteStreamEventSchema>;
