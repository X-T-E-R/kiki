import { z } from 'zod';

import type { IConfigService } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const SESSION_TITLE_SECTION = 'sessionTitle';

export const SessionTitleConfigSchema = z.object({
  model: z.string().optional(),
});

export type SessionTitleConfig = z.infer<typeof SessionTitleConfigSchema>;

export function resolveSessionTitleModelAlias(config: IConfigService): string | undefined {
  const configured = config.get<SessionTitleConfig | undefined>(SESSION_TITLE_SECTION)?.model;
  const trimmed = configured?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

registerConfigSection(SESSION_TITLE_SECTION, SessionTitleConfigSchema);
