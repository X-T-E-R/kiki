import { z } from 'zod';

import type { IConfigService } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

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
});

export type SessionTitleConfig = z.infer<typeof SessionTitleConfigSchema>;

export function resolveSessionTitleModelAlias(config: IConfigService): string | undefined {
  return config.get<SessionTitleConfig | undefined>(SESSION_TITLE_SECTION)?.model?.trim() || undefined;
}

export function resolveSessionTitleTriggers(config: IConfigService): readonly SessionTitleTrigger[] {
  return config.get<SessionTitleConfig | undefined>(SESSION_TITLE_SECTION)?.triggers ?? DEFAULT_SESSION_TITLE_TRIGGERS;
}

registerConfigSection(SESSION_TITLE_SECTION, SessionTitleConfigSchema);
registerConfigSection(FAST_MODEL_SECTION, z.string().trim().min(1));
