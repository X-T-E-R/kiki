import { z } from 'zod';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { isPlainObject, plainObjectToToml, transformPlainObject } from '#/app/config/toml';

export const REQUEST_GOVERNANCE_SECTION = 'requestGovernance';
export const RequestConcurrencyRuleSchema = z.object({
  id: z.string().min(1),
  resource: z.literal('model_request').default('model_request'),
  scope: z.enum(['global', 'each_session']).default('global'),
  models: z.array(z.string().min(1)).min(1).optional(),
  providers: z.array(z.string().min(1)).min(1).optional(),
  subagentsOnly: z.boolean().default(false),
  maxConcurrent: z.number().int().positive().optional(),
  overflow: z.enum(['queue', 'reject']).default('queue'),
  maxWaitMs: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
}).strict();

export const RequestGovernanceConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  maxWaitMs: z.number().int().positive().default(300_000),
  maxQueueSize: z.number().int().positive().default(1024),
  rules: z.array(RequestConcurrencyRuleSchema).default([]),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  value.rules.forEach((rule, index) => {
    if (ids.has(rule.id)) context.addIssue({ code: 'custom', path: ['rules', index, 'id'], message: 'Rule IDs must be unique.' });
    ids.add(rule.id);
  });
});

export type RequestConcurrencyRule = z.infer<typeof RequestConcurrencyRuleSchema>;
export type RequestGovernanceConfig = z.infer<typeof RequestGovernanceConfigSchema>;

export function requestGovernanceFromToml(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const value = transformPlainObject(raw);
  if (Array.isArray(value['rules'])) value['rules'] = value['rules'].map((rule) => isPlainObject(rule) ? transformPlainObject(rule) : rule);
  return value;
}

export function requestGovernanceToToml(value: unknown, raw: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const converted = plainObjectToToml(value, raw);
  if (Array.isArray(value['rules'])) converted['rules'] = value['rules'].map((rule) => isPlainObject(rule) ? plainObjectToToml(rule, undefined) : rule);
  return converted;
}

registerConfigSection(REQUEST_GOVERNANCE_SECTION, RequestGovernanceConfigSchema, {
  defaultValue: RequestGovernanceConfigSchema.parse({}),
  fromToml: requestGovernanceFromToml,
  toToml: requestGovernanceToToml,
});
