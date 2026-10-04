import { z } from 'zod';

export function questionSettingsFromToml(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [
    key.replaceAll(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
    questionSettingsFromToml(field),
  ]));
}

export const askUserQuestionGuardConfigSchema = z.object({
  enabled: z.boolean().optional(),
  maxPerUserRound: z.number().int().min(1).max(1000).optional(),
  maxPerWindow: z.number().int().min(1).max(1000).optional(),
  windowMs: z.number().int().min(1).max(86_400_000).optional(),
}).strict();
export type AskUserQuestionGuardConfig = z.infer<typeof askUserQuestionGuardConfigSchema>;

export const interactionConfigSchema = z.object({
  askUserQuestion: z.enum(['background', 'blocking']).default('background'),
  askUserQuestionGuard: askUserQuestionGuardConfigSchema.optional(),
});
export const interactionConfigCamelPatchSchema = interactionConfigSchema.extend({
  askUserQuestion: interactionConfigSchema.shape.askUserQuestion.removeDefault().optional(),
}).strict();
export const modelBehaviorConfigSchema = z.object({
  askUserQuestionGuard: askUserQuestionGuardConfigSchema.optional(),
}).strict();
export type ModelBehaviorConfig = z.infer<typeof modelBehaviorConfigSchema>;

export const askUserQuestionGuardWireSchema = z.object({
  enabled: askUserQuestionGuardConfigSchema.shape.enabled,
  max_per_user_round: askUserQuestionGuardConfigSchema.shape.maxPerUserRound,
  max_per_window: askUserQuestionGuardConfigSchema.shape.maxPerWindow,
  window_ms: askUserQuestionGuardConfigSchema.shape.windowMs,
}).strict();
export const modelBehaviorWireSchema = z.object({
  ask_user_question_guard: askUserQuestionGuardWireSchema.optional(),
}).strict();
export type ModelBehaviorWire = z.infer<typeof modelBehaviorWireSchema>;
export const askUserQuestionGuardPatchSchema = z.object({
  enabled: askUserQuestionGuardWireSchema.shape.enabled.unwrap().nullable().optional(),
  max_per_user_round: askUserQuestionGuardWireSchema.shape.max_per_user_round.unwrap().nullable().optional(),
  max_per_window: askUserQuestionGuardWireSchema.shape.max_per_window.unwrap().nullable().optional(),
  window_ms: askUserQuestionGuardWireSchema.shape.window_ms.unwrap().nullable().optional(),
}).strict();
export const modelBehaviorPatchSchema = z.object({
  ask_user_question_guard: askUserQuestionGuardPatchSchema.nullable().optional(),
}).strict();
export type ModelBehaviorPatch = z.infer<typeof modelBehaviorPatchSchema>;

export function modelBehaviorFromWire(value: ModelBehaviorWire | undefined): ModelBehaviorConfig | undefined {
  if (value === undefined) return undefined;
  const guard = value.ask_user_question_guard;
  return { askUserQuestionGuard: guard === undefined ? undefined : {
    enabled: guard.enabled,
    maxPerUserRound: guard.max_per_user_round,
    maxPerWindow: guard.max_per_window,
    windowMs: guard.window_ms,
  } };
}

export function modelBehaviorToWire(value: ModelBehaviorConfig | undefined): ModelBehaviorWire | undefined {
  if (value === undefined) return undefined;
  const guard = value.askUserQuestionGuard;
  return { ask_user_question_guard: guard === undefined ? undefined : {
    enabled: guard.enabled,
    max_per_user_round: guard.maxPerUserRound,
    max_per_window: guard.maxPerWindow,
    window_ms: guard.windowMs,
  } };
}

export function interactionConfigFromWire(value: { ask_user_question?: 'background' | 'blocking'; ask_user_question_guard?: z.infer<typeof askUserQuestionGuardWireSchema> }): { askUserQuestion?: 'background' | 'blocking'; askUserQuestionGuard?: AskUserQuestionGuardConfig } {
  return { askUserQuestion: value.ask_user_question, ...modelBehaviorFromWire(value) };
}

export function interactionConfigToWire(value: { askUserQuestion?: 'background' | 'blocking'; askUserQuestionGuard?: AskUserQuestionGuardConfig }): { ask_user_question?: 'background' | 'blocking'; ask_user_question_guard?: z.infer<typeof askUserQuestionGuardWireSchema> } {
  return { ask_user_question: value.askUserQuestion, ...modelBehaviorToWire(value) };
}

export function patchModelBehavior(current: ModelBehaviorConfig | undefined, patch: ModelBehaviorPatch | null): ModelBehaviorConfig | undefined {
  if (patch === null) return undefined;
  const next = { ...current };
  if (patch.ask_user_question_guard === null) next.askUserQuestionGuard = undefined;
  else if (patch.ask_user_question_guard !== undefined) {
    const guard = { ...current?.askUserQuestionGuard };
    const fields = { enabled: 'enabled', max_per_user_round: 'maxPerUserRound', max_per_window: 'maxPerWindow', window_ms: 'windowMs' } as const;
    for (const [wire, field] of Object.entries(fields)) {
      const value = patch.ask_user_question_guard[wire as keyof typeof fields];
      if (value !== undefined) Object.assign(guard, { [field]: value ?? undefined });
    }
    next.askUserQuestionGuard = guard;
  }
  return next;
}

export const DEFAULT_ASK_USER_QUESTION_GUARD = {
  enabled: false,
  maxPerUserRound: 1,
  maxPerWindow: 3,
  windowMs: 600_000,
} as const;

export function resolveAskUserQuestionGuard(global: AskUserQuestionGuardConfig | undefined, model: ModelBehaviorConfig | undefined): Required<AskUserQuestionGuardConfig> {
  const override = model?.askUserQuestionGuard;
  return {
    enabled: override?.enabled ?? global?.enabled ?? DEFAULT_ASK_USER_QUESTION_GUARD.enabled,
    maxPerUserRound: override?.maxPerUserRound ?? global?.maxPerUserRound ?? DEFAULT_ASK_USER_QUESTION_GUARD.maxPerUserRound,
    maxPerWindow: override?.maxPerWindow ?? global?.maxPerWindow ?? DEFAULT_ASK_USER_QUESTION_GUARD.maxPerWindow,
    windowMs: override?.windowMs ?? global?.windowMs ?? DEFAULT_ASK_USER_QUESTION_GUARD.windowMs,
  };
}
