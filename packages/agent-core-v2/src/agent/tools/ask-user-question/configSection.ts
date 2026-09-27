import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const INTERACTION_SECTION = 'interaction';
export const InteractionConfigSchema = z.object({
  askUserQuestion: z.enum(['background', 'blocking']).default('background'),
});
export type InteractionConfig = z.infer<typeof InteractionConfigSchema>;

registerConfigSection(INTERACTION_SECTION, InteractionConfigSchema);
