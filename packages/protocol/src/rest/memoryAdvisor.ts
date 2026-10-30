import { z } from 'zod';
import { decisionSourceSchema, decisionSourceStatusSchema } from '../decision';

export const memoryAdvisorSelectorSchema = z
  .object({
    protocol: z.enum(['chat_json', 'system_one', 'pair_score']),
    model: z.string().trim().min(1),
    endpoint: z.string().url().optional(),
  })
  .strict();
export const memoryAdvisorConfigSchema = z
  .object({
    mode: z.enum(['off', 'rank', 'select']).default('rank'),
    selector: memoryAdvisorSelectorSchema.optional(),
    source: decisionSourceSchema.optional(),
    first_step_wait_ms: z.number().int().min(0).max(5_000).optional(),
    timeout_ms: z.number().int().min(100).max(60_000).default(6_000),
    max_calls_per_turn: z.number().int().min(1).max(10).default(3),
    candidate_chars: z.number().int().min(0).max(500).default(120),
    catalog_page_items: z.number().int().min(1).max(200).default(40),
    max_catalog_pages: z.number().int().min(1).max(20).default(2),
    max_full_units: z.number().int().min(1).max(50).default(8),
    judge_input_tokens: z.number().int().min(256).max(100_000).default(12_000),
    apply_to_children: z.boolean().default(true),
    egress_ack: z
      .array(z.object({ workspace_id: z.string().min(1), destination: z.string().min(1) }).strict())
      .default([]),
  })
  .strict();
export const memoryAdvisorPatchSchema = z
  .object({
    mode: memoryAdvisorConfigSchema.shape.mode.unwrap().optional(),
    selector: memoryAdvisorSelectorSchema.nullable().optional(),
    source: decisionSourceSchema.nullable().optional(),
    first_step_wait_ms: memoryAdvisorConfigSchema.shape.first_step_wait_ms.unwrap().nullable().optional(),
    timeout_ms: memoryAdvisorConfigSchema.shape.timeout_ms.unwrap().optional(),
    max_calls_per_turn: memoryAdvisorConfigSchema.shape.max_calls_per_turn.unwrap().optional(),
    candidate_chars: memoryAdvisorConfigSchema.shape.candidate_chars.unwrap().optional(),
    catalog_page_items: memoryAdvisorConfigSchema.shape.catalog_page_items.unwrap().optional(),
    max_catalog_pages: memoryAdvisorConfigSchema.shape.max_catalog_pages.unwrap().optional(),
    max_full_units: memoryAdvisorConfigSchema.shape.max_full_units.unwrap().optional(),
    judge_input_tokens: memoryAdvisorConfigSchema.shape.judge_input_tokens.unwrap().optional(),
    apply_to_children: memoryAdvisorConfigSchema.shape.apply_to_children.unwrap().optional(),
    egress_ack: memoryAdvisorConfigSchema.shape.egress_ack.unwrap().optional(),
  })
  .strict();
export const memorySettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    approval: z.enum(['auto', 'review', 'off']).optional(),
    budget: z.number().int().min(0).max(4_000).optional(),
    advisor: memoryAdvisorPatchSchema.nullable().optional(),
  })
  .strict();
export const memoryAdvisorFailureSchema = z.enum([
  'unconfigured',
  'not_permitted',
  'consent_required',
  'unsupported_store',
  'timeout',
  'aborted',
  'auth',
  'rate_limited',
  'protocol',
  'invalid_output',
  'capability_mismatch',
  'input_budget',
  'unavailable',
]);
export const memoryAdvisorStatusSchema = z.object({
  state: z.enum([
    'off',
    'unconfigured',
    'ready',
    'pending',
    'selected',
    'none',
    'failed',
    'unsupported_store',
    'disabled',
    'limited',
  ]),
  reason: memoryAdvisorFailureSchema.optional(),
  source_status: decisionSourceStatusSchema.optional(),
  destination: z.string().optional(),
  provider: z.string().optional(),
  origin: z.string().optional(),
  protocol: z.enum(['chat_json', 'system_one', 'pair_score']).optional(),
  model: z.string().optional(),
  first_step_wait_ms: z.number().int().optional(),
  first_step_wait_default_ms: z.number().int().optional(),
  consent_required: z.boolean(),
  enumeration: z.enum(['complete', 'partial']).optional(),
  applicability: z.enum(['full_units', 'rank_only']).optional(),
  recommended_count: z.number().int().optional(),
  logical_calls: z.number().int().default(0),
  requests: z.number().int().default(0),
  retries: z.number().int().default(0),
  displaced_ids: z.array(z.string()).default([]),
  unjudged_count: z.number().int().default(0),
});
export const memoryAdvisorProbeInputSchema = z
  .object({ confirm_destination: z.string().min(1) })
  .strict();
export const memoryAdvisorProbeResultSchema = z.object({
  ok: z.boolean(),
  status: memoryAdvisorStatusSchema,
  duration_ms: z.number(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  usage_known: z.boolean(),
});
export const memorySettingsResponseSchema = z.object({
  enabled: z.boolean(),
  approval: z.enum(['auto', 'review', 'off']),
  budget: z.number(),
  workspaces: z.record(z.string(), z.boolean()),
  advisor: memoryAdvisorConfigSchema.optional(),
  effective_enabled: z.boolean(),
  advisor_status: memoryAdvisorStatusSchema,
});
export type MemoryAdvisorConfig = z.infer<typeof memoryAdvisorConfigSchema>;
export type MemoryAdvisorProtocol = MemoryAdvisorSelector['protocol'];
/** First-step wait used when `first_step_wait_ms` is not set: decision services answer within about 1.5 s, chat models need longer than the wait can cover. */
export const MEMORY_ADVISOR_FIRST_STEP_WAIT_DEFAULTS: Readonly<Record<MemoryAdvisorProtocol, number>> = {
  chat_json: 1_500,
  system_one: 3_000,
  pair_score: 3_000,
};
/** The first-step wait in effect: an explicit value wins; otherwise the default of the resolved protocol, or the chat default when it is unknown. */
export function memoryAdvisorFirstStepWaitMs(
  config: Pick<MemoryAdvisorConfig, 'first_step_wait_ms'> | undefined,
  protocol: MemoryAdvisorProtocol | undefined,
): number {
  return config?.first_step_wait_ms ?? MEMORY_ADVISOR_FIRST_STEP_WAIT_DEFAULTS[protocol ?? 'chat_json'];
}
export type MemoryAdvisorSelector = z.infer<typeof memoryAdvisorSelectorSchema>;
export type MemoryAdvisorPatch = z.infer<typeof memoryAdvisorPatchSchema>;
export type MemoryAdvisorStatus = z.infer<typeof memoryAdvisorStatusSchema>;
export type MemoryAdvisorFailure = z.infer<typeof memoryAdvisorFailureSchema>;
export type MemoryAdvisorProbeResult = z.infer<typeof memoryAdvisorProbeResultSchema>;
export type MemorySettingsResponse = z.infer<typeof memorySettingsResponseSchema>;
export type MemorySettingsPatch = z.infer<typeof memorySettingsPatchSchema>;
