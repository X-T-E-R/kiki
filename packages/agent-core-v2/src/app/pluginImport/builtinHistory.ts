import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { sessionSourceDefinitionSchema } from '@kiki/protocol';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { settingsContributionSchema } from '#/app/plugin/contributions';
import definition from './builtin/definition.json?raw';

export const builtinHistory = z.object({
  id: z.literal('kiki-history'),
  sessionSources: z.array(sessionSourceDefinitionSchema),
  settings: settingsContributionSchema,
}).strict().parse(JSON.parse(definition));

export function builtinHistoryEntry(bootstrap: IBootstrapService): string {
  return bootstrap.getEnv('KIKI_HISTORY_IMPORT_ENTRY') ?? fileURLToPath(new URL('./builtin/entry.mjs', import.meta.url));
}
