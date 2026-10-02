import { z } from 'zod';

export const usageGranularitySchema = z.enum(['day', 'week', 'month', 'session', 'five_hour']);
export const usageRangePresetSchema = z.enum([
  'today',
  'last_7_days',
  'this_week',
  'this_month',
  'all',
  'custom',
]);
export const usageDimensionSchema = z.enum(['agent', 'model', 'project', 'session']);

const repeatedStringSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional();

export const usageQuerySchema = z
  .object({
    granularity: usageGranularitySchema.optional(),
    range: usageRangePresetSchema.optional(),
    dimension: usageDimensionSchema.optional(),
    model: repeatedStringSchema,
    provider: repeatedStringSchema,
    'agent.id': repeatedStringSchema,
    'workspace.id': repeatedStringSchema,
    include_archived: z.enum(['true', 'false']).optional(),
    start_at: z.coerce.number().int().nonnegative().optional(),
    end_at: z.coerce.number().int().nonnegative().optional(),
    timezone_offset_minutes: z.coerce.number().int().min(-840).max(840).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    page_token: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    const range = value.range ?? 'all';
    if (range === 'custom') {
      if (value.start_at === undefined) {
        ctx.addIssue({ code: 'custom', path: ['start_at'], message: 'start_at is required for custom range' });
      }
      if (value.end_at === undefined) {
        ctx.addIssue({ code: 'custom', path: ['end_at'], message: 'end_at is required for custom range' });
      }
      if (
        value.start_at !== undefined &&
        value.end_at !== undefined &&
        value.start_at >= value.end_at
      ) {
        ctx.addIssue({ code: 'custom', path: ['end_at'], message: 'end_at must be greater than start_at' });
      }
    } else if (value.start_at !== undefined || value.end_at !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['range'],
        message: 'start_at and end_at are only available with range=custom',
      });
    }
  });

export const usageTokensSchema = z.object({
  input_other: z.number().nonnegative(),
  output: z.number().nonnegative(),
  input_cache_read: z.number().nonnegative(),
  input_cache_creation: z.number().nonnegative(),
});

export const usageAggregateSchema = z.object({
  tokens: usageTokensSchema,
  tokens_unknown: z.boolean().optional().describe('Some records lack token accounting or zero-record provenance; numeric tokens remain the recorded subtotal, not an inferred total.'),
  cost_usd_estimated: z.number().nonnegative(),
  cost_unknown: z.boolean(),
});

export const usageGroupSchema = usageAggregateSchema.extend({
  key: z.string(),
  provider: z.string().nullable(),
  model_alias: z.string().nullable(),
  agent_id: z.string().nullable(),
  parent_agent_id: z.string().nullable(),
  profile_name: z.string().nullable(),
});

export const usageTrendBucketSchema = z.object({
  key: z.string(),
  start_at: z.number().int().nonnegative(),
  end_at: z.number().int().nonnegative(),
  turn_count: z.number().int().nonnegative().optional(),
  request_count: z.number().int().nonnegative().optional(),
  groups: z.array(usageGroupSchema),
  drilldown: z.object({
    sessions: z.array(
      z.object({
        session_id: z.string(),
        turn_ids: z.array(z.number().int().nonnegative()),
        turn_count: z.number().int().nonnegative(),
        unknown_turn_records: z.number().int().nonnegative(),
        turn_ids_truncated: z.boolean(),
      }),
    ),
    sessions_truncated: z.boolean(),
  }),
});

export const usageSessionItemSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  title: z.string().nullable(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  archived: z.boolean(),
  deleted: z.boolean(),
  usage: usageAggregateSchema,
  primary_model: z.string().nullable().optional(),
  profile_names: z.array(z.string()).optional(),
  unknown_price_models: z.array(z.string()),
});

export const usageResponseSchema = z.object({
  query: z.object({
    granularity: usageGranularitySchema,
    range: z.object({
      preset: usageRangePresetSchema,
      start_at: z.number().int().nonnegative().nullable(),
      end_at: z.number().int().nonnegative().nullable(),
      defaulted_to_all_history: z.boolean(),
    }),
    dimension: usageDimensionSchema,
    models: z.array(z.string()),
    providers: z.array(z.string()),
    agent_ids: z.array(z.string()),
    workspace_ids: z.array(z.string()),
    include_archived: z.boolean(),
    timezone_offset_minutes: z.number().int(),
  }),
  summary: usageAggregateSchema.extend({ session_count: z.number().int().nonnegative() }),
  trend: z.array(usageTrendBucketSchema),
  sessions: z.object({
    items: z.array(usageSessionItemSchema),
    total: z.number().int().nonnegative(),
    has_more: z.boolean(),
    next_page_token: z.string().nullable(),
  }),
  reliability: z.object({
    complete: z.boolean(),
    usage_coverage: z.object({
      known_records: z.number().int().nonnegative(),
      missing_records: z.number().int().nonnegative(),
      legacy_zero_records: z.number().int().nonnegative().describe('Unmarked historical zero records whose provenance is unknown; not classified as confirmed missing usage.'),
    }).optional(),
    coverage: z.object({
      earliest_at: z.number().int().nonnegative().nullable(),
      latest_at: z.number().int().nonnegative().nullable(),
    }),
    scanned_sessions: z.number().int().nonnegative(),
    incomplete_sessions: z.number().int().nonnegative(),
    unknown_price_models: z.array(z.string()),
    includes_deleted_sessions: z.boolean(),
    incomplete_reason: z.enum(['session_cap', 'record_budget', 'deadline']).nullable(),
  }),
});

export type UsageQuery = z.infer<typeof usageQuerySchema>;
export type UsageResponse = z.infer<typeof usageResponseSchema>;
export type UsageAggregateWire = z.infer<typeof usageAggregateSchema>;

export const modelPriceOverrideSchema = z.object({
  input_cost_per_token: z.number().finite().nonnegative(),
  output_cost_per_token: z.number().finite().nonnegative(),
  cache_read_input_token_cost: z.number().finite().nonnegative().optional(),
  cache_creation_input_token_cost: z.number().finite().nonnegative().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();

export const usagePricingQuerySchema = z.object({
  model: z.union([z.string().trim().min(1), z.array(z.string().trim().min(1)).max(500)]).optional(),
});

export const usagePricingUpdateSchema = z.object({
  overrides: z.record(z.string().trim().min(1).max(512), modelPriceOverrideSchema.nullable()),
}).strict();

export const usagePricingResponseSchema = z.object({
  items: z.array(z.object({
    model: z.string(),
    pricing_model: z.string().nullable(),
    matched_key: z.string().nullable(),
    source: z.enum(['override', 'litellm-cache', 'vendored', 'unknown']),
    prices: modelPriceOverrideSchema.nullable(),
  })),
  overrides: z.record(z.string(), modelPriceOverrideSchema),
});

export type ModelPriceOverride = z.infer<typeof modelPriceOverrideSchema>;
export type UsagePricingQuery = z.infer<typeof usagePricingQuerySchema>;
export type UsagePricingUpdate = z.infer<typeof usagePricingUpdateSchema>;
export type UsagePricingResponse = z.infer<typeof usagePricingResponseSchema>;

export const usageRescanStatusSchema = z.object({
  state: z.enum(['idle', 'running', 'completed', 'failed']),
  scanned_sessions: z.number().int().nonnegative(),
  total_sessions: z.number().int().nonnegative(),
  scanned_records: z.number().int().nonnegative(),
  started_at: z.number().nonnegative().nullable(),
  finished_at: z.number().nonnegative().nullable(),
  error: z.string().nullable(),
});

export type UsageRescanStatus = z.infer<typeof usageRescanStatusSchema>;
