import {
  DEFAULT_ASK_USER_QUESTION_GUARD,
  askUserQuestionGuardConfigSchema,
  interactionConfigToWire,
  modelBehaviorFromWire,
  modelBehaviorToWire,
  type AskUserQuestionGuardConfig,
  type ModelBehaviorWire,
  type ModelBehaviorPatch,
} from '@kiki/protocol';

export interface QuestionGuardDraft {
  enabled: 'inherit' | 'on' | 'off';
  maxPerUserRound: string;
  maxPerWindow: string;
  windowMs: string;
}

export function questionGuardDraftFromConfig(value: AskUserQuestionGuardConfig | undefined): QuestionGuardDraft {
  return {
    enabled: value?.enabled === undefined ? 'inherit' : value.enabled ? 'on' : 'off',
    maxPerUserRound: value?.maxPerUserRound === undefined ? '' : String(value.maxPerUserRound),
    maxPerWindow: value?.maxPerWindow === undefined ? '' : String(value.maxPerWindow),
    windowMs: value?.windowMs === undefined ? '' : String(value.windowMs),
  };
}

export function questionGuardDraftFromBehavior(value: ModelBehaviorWire | undefined): QuestionGuardDraft {
  return questionGuardDraftFromConfig(modelBehaviorFromWire(value)?.askUserQuestionGuard);
}

export function questionGuardConfigFromDraft(draft: QuestionGuardDraft): AskUserQuestionGuardConfig {
  const number = (value: string): number | undefined => value.trim() === '' ? undefined : Number(value);
  return askUserQuestionGuardConfigSchema.parse({
    enabled: draft.enabled === 'inherit' ? undefined : draft.enabled === 'on',
    maxPerUserRound: number(draft.maxPerUserRound),
    maxPerWindow: number(draft.maxPerWindow),
    windowMs: number(draft.windowMs),
  });
}

export function questionGuardModelPatch(draft: QuestionGuardDraft, baseline: QuestionGuardDraft): ModelBehaviorPatch | undefined {
  const next = modelBehaviorToWire({ askUserQuestionGuard: questionGuardConfigFromDraft(draft) })!.ask_user_question_guard!;
  const before = modelBehaviorToWire({ askUserQuestionGuard: questionGuardConfigFromDraft(baseline) })!.ask_user_question_guard!;
  const patch: NonNullable<ModelBehaviorPatch['ask_user_question_guard']> = {};
  for (const key of ['enabled', 'max_per_user_round', 'max_per_window', 'window_ms'] as const) {
    if (next[key] !== before[key]) Object.assign(patch, { [key]: next[key] ?? null });
  }
  return Object.keys(patch).length === 0 ? undefined : { ask_user_question_guard: patch };
}

export function questionGuardGlobalPatch(draft: QuestionGuardDraft, baseline: QuestionGuardDraft): { ask_user_question_guard: NonNullable<ReturnType<typeof interactionConfigToWire>['ask_user_question_guard']> } | undefined {
  const modelPatch = questionGuardModelPatch(draft, baseline);
  if (modelPatch === undefined) return undefined;
  const next = questionGuardConfigFromDraft(draft);
  const fields = modelPatch.ask_user_question_guard!;
  return { ask_user_question_guard: {
    enabled: fields.enabled === undefined ? undefined : next.enabled ?? DEFAULT_ASK_USER_QUESTION_GUARD.enabled,
    max_per_user_round: fields.max_per_user_round === undefined ? undefined : next.maxPerUserRound ?? DEFAULT_ASK_USER_QUESTION_GUARD.maxPerUserRound,
    max_per_window: fields.max_per_window === undefined ? undefined : next.maxPerWindow ?? DEFAULT_ASK_USER_QUESTION_GUARD.maxPerWindow,
    window_ms: fields.window_ms === undefined ? undefined : next.windowMs ?? DEFAULT_ASK_USER_QUESTION_GUARD.windowMs,
  } };
}
