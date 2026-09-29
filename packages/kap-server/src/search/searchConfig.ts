import { z } from 'zod';
import { registerConfigSection } from '@kiki/agent-core-v2/app/config/configSectionContributions';

export const SearchConfigSchema = z.object({
  enabled: z.boolean().optional(),
  index_subagents: z.boolean().optional(),
}).passthrough();
export type SearchConfig = z.infer<typeof SearchConfigSchema>;
export const SEARCH_BACKEND_SECTION = 'search_backend';
registerConfigSection('search', SearchConfigSchema);
registerConfigSection(SEARCH_BACKEND_SECTION, z.enum(['sqlite', 'minidb']));
