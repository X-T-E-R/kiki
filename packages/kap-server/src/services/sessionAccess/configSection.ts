import { registerConfigSection } from '@kiki/agent-core-v2';
import { z } from 'zod';

export const SESSION_ACCESS_SECTION = 'sessionAccess';
export const sessionAccessConfigSchema = z.object({
  enabled: z.boolean().default(true),
  terminalHandoff: z.boolean().default(true),
}).strict();
export type SessionAccessConfig = z.infer<typeof sessionAccessConfigSchema>;

registerConfigSection(SESSION_ACCESS_SECTION, sessionAccessConfigSchema, {
  defaultValue: { enabled: true, terminalHandoff: true },
});
