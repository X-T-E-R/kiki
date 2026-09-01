import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const DEFAULT_PLAN_MODE_SECTION = 'defaultPlanMode';
export const PLAN_SECTION = 'plan';

export const DefaultPlanModeSchema = z.boolean().optional();
export const PlanGateSchema = z.enum(['free', 'gated']);
export const PlanConfigSchema = z.object({
  gate: PlanGateSchema,
  enterApprovalTimeoutMs: z.number().int().min(5000),
});

export type DefaultPlanMode = z.infer<typeof DefaultPlanModeSchema>;
export type PlanGate = z.infer<typeof PlanGateSchema>;
export type PlanConfig = z.infer<typeof PlanConfigSchema>;

export const DEFAULT_PLAN_CONFIG: PlanConfig = {
  gate: 'free',
  enterApprovalTimeoutMs: 60_000,
};

registerConfigSection(DEFAULT_PLAN_MODE_SECTION, DefaultPlanModeSchema, {
  defaultValue: false,
});
registerConfigSection(PLAN_SECTION, PlanConfigSchema, {
  defaultValue: DEFAULT_PLAN_CONFIG,
});
