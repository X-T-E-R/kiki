import { z } from 'zod';
import { dangerousBashGuardSchema, permissionRuleConfigSchema } from '@kiki/protocol';

import type { PermissionMode } from '#/agent/permissionPolicy/types';
import type { IConfigService } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import {
  cloneRecord,
  isPlainObject,
  plainObjectToToml,
  setDefined,
  transformPlainObject,
} from '#/app/config/toml';

export const PERMISSION_SECTION = 'permission';

export const PermissionRuleDecisionSchema = permissionRuleConfigSchema.shape.decision;
export const PermissionRuleScopeSchema = permissionRuleConfigSchema.shape.scope.removeDefault();
export const PermissionRuleSchema = permissionRuleConfigSchema;
export const DangerousBashGuardSchema = dangerousBashGuardSchema;

export const ReviewerCategorySchema = z.enum([
  'policy_compliance',
  'no_secret_egress',
  'no_irreversible_damage',
  'no_outward_effect',
  'prompt_injection_absent',
]);

export const PermissionReviewerConfigSchema = z.object({
  backend: z.enum(['model', 'jev']).default('model'),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
  allowThreshold: z.number().min(0.5).max(1).default(0.9),
  denyThreshold: z.number().min(0.5).max(1).default(0.9),
  categories: z.array(ReviewerCategorySchema).min(1).default([
    'policy_compliance',
    'no_secret_egress',
    'no_irreversible_damage',
    'no_outward_effect',
    'prompt_injection_absent',
  ]),
});

export const PermissionConfigSchema = z.object({
  rules: z.array(PermissionRuleSchema).optional(),
  dangerousBash: DangerousBashGuardSchema.optional(),
  reviewer: PermissionReviewerConfigSchema.optional(),
});

export type PermissionConfig = z.infer<typeof PermissionConfigSchema>;
export type DangerousBashGuard = z.infer<typeof DangerousBashGuardSchema>;

export function isDangerousBashGuardEnabled(
  config: IConfigService,
  mode: PermissionMode,
): boolean {
  const setting =
    config.get<PermissionConfig | undefined>(PERMISSION_SECTION)?.dangerousBash ?? 'default';
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return mode !== 'yolo';
}

export const permissionFromToml = (rawSnake: unknown): unknown => {
  if (!isPlainObject(rawSnake)) return rawSnake;
  const raw = transformPlainObject(rawSnake);
  const rules: unknown[] = [];
  appendPermissionRules(rules, raw['rules']);
  appendPermissionRules(rules, raw['deny'], 'deny');
  appendPermissionRules(rules, raw['allow'], 'allow');
  appendPermissionRules(rules, raw['ask'], 'ask');
  const out: Record<string, unknown> = {};
  if (rules.length > 0) out['rules'] = rules;
  if (raw['dangerousBash'] !== undefined) out['dangerousBash'] = raw['dangerousBash'];
  if (raw['reviewer'] !== undefined) {
    out['reviewer'] = isPlainObject(raw['reviewer'])
      ? transformPlainObject(raw['reviewer'])
      : raw['reviewer'];
  }
  return out;
};

function appendPermissionRules(
  target: unknown[],
  value: unknown,
  decision?: 'allow' | 'deny' | 'ask',
): void {
  if (value === undefined) return;
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    target.push(transformPermissionRule(entry, decision));
  }
}

function transformPermissionRule(value: unknown, decision?: 'allow' | 'deny' | 'ask'): unknown {
  if (!isPlainObject(value)) return value;
  const rule = transformPlainObject(value);
  const tool = rule['tool'];
  const match = rule['match'];
  const pattern = rule['pattern'];
  const out: Record<string, unknown> = {
    decision: decision !== undefined ? decision : rule['decision'],
    scope: rule['scope'],
    reason: rule['reason'],
  };
  if (typeof tool === 'string') {
    const argPattern = typeof match === 'string' ? match : pattern;
    out['pattern'] = typeof argPattern === 'string' ? `${tool}(${argPattern})` : tool;
  } else {
    out['pattern'] = pattern;
  }
  return out;
}

export const permissionToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const out = cloneRecord(rawSnake);
  delete out['deny'];
  delete out['allow'];
  delete out['ask'];
  const rules = value['rules'];
  if (Array.isArray(rules)) {
    out['rules'] = rules.map((rule) =>
      isPlainObject(rule) ? plainObjectToToml(rule, undefined) : rule,
    );
  } else {
    delete out['rules'];
  }
  setDefined(out, 'dangerous_bash', value['dangerousBash']);
  setDefined(
    out,
    'reviewer',
    isPlainObject(value['reviewer'])
      ? plainObjectToToml(value['reviewer'], out['reviewer'])
      : value['reviewer'],
  );
  return out;
};

registerConfigSection(PERMISSION_SECTION, PermissionConfigSchema, {
  fromToml: permissionFromToml,
  toToml: permissionToToml,
});
