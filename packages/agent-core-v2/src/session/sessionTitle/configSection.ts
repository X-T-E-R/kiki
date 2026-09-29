import { z } from 'zod';

import type { IConfigService } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const SESSION_TITLE_SECTION = 'sessionTitle';
export const FAST_MODEL_SECTION = 'fastModel';

export const SessionTitleConfigSchema = z.object({
  model: z.string().optional(),
});

export type SessionTitleConfig = z.infer<typeof SessionTitleConfigSchema>;

/** `session_title.model` takes priority; `fast_model` is the optional auxiliary fallback. */
export function resolveSessionTitleModelAlias(config: IConfigService): string | undefined {
  const configured = config.get<SessionTitleConfig | undefined>(SESSION_TITLE_SECTION)?.model?.trim();
  if (configured) return configured;
  return config.get<string | undefined>(FAST_MODEL_SECTION)?.trim() || undefined;
}

registerConfigSection(SESSION_TITLE_SECTION, SessionTitleConfigSchema);
registerConfigSection(FAST_MODEL_SECTION, z.string().trim().min(1));
