import { z } from 'zod';

import type { IConfigService } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { DEFAULT_SESSION_TITLE_PROMPT, sessionTitlePromptOverride } from './defaultPrompt';

export const SESSION_TITLE_SECTION = 'sessionTitle';
export const FAST_MODEL_SECTION = 'fastModel';

export const SessionTitleTriggerSchema = z.enum([
  'first_user_message', 'first_turn_completed', 'context_compacted',
]);

export type SessionTitleTrigger = z.infer<typeof SessionTitleTriggerSchema>;

export const DEFAULT_SESSION_TITLE_TRIGGERS: readonly SessionTitleTrigger[] = ['first_turn_completed'];

export const SessionTitleConfigSchema = z.object({
  model: z.string().optional(),
  triggers: z.array(SessionTitleTriggerSchema).optional(),
  prompt: z.string().optional(),
});

export const SessionTitleConfigPatchSchema = SessionTitleConfigSchema.extend({
  model: z.string().nullable().optional(),
  prompt: z.string().nullable().optional(),
}).strict();

function mergeSessionTitleConfig(base: SessionTitleConfig | undefined, patch: unknown): SessionTitleConfig {
  const value = SessionTitleConfigPatchSchema.parse(patch);
  const next = { ...base, ...value };
  const model = next.model?.trim() || undefined;
  const prompt = sessionTitlePromptOverride(next.prompt ?? undefined);
  return { model, triggers: next.triggers, prompt };
}

export type SessionTitleConfig = z.infer<typeof SessionTitleConfigSchema>;

export function resolveSessionTitleModelAlias(config: IConfigService): string | undefined {
  return config.get<SessionTitleConfig | undefined>(SESSION_TITLE_SECTION)?.model?.trim() || undefined;
}

export function resolveSessionTitleTriggers(config: IConfigService): readonly SessionTitleTrigger[] {
  return config.get<SessionTitleConfig | undefined>(SESSION_TITLE_SECTION)?.triggers ?? DEFAULT_SESSION_TITLE_TRIGGERS;
}

export function resolveSessionTitlePrompt(config: IConfigService): string {
  return sessionTitlePromptOverride(config.get<SessionTitleConfig | undefined>(SESSION_TITLE_SECTION)?.prompt)
    ?? DEFAULT_SESSION_TITLE_PROMPT;
}

registerConfigSection(SESSION_TITLE_SECTION, SessionTitleConfigSchema, { merge: mergeSessionTitleConfig });
registerConfigSection(FAST_MODEL_SECTION, z.string().trim().min(1));
