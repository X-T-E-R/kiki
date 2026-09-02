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
  groups: z.array(usageGroupSchema),
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
