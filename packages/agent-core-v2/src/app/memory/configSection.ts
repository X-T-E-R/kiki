import { z } from 'zod';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const MEMORY_SECTION = 'memory';
export const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  approval: z.enum(['auto', 'review', 'off']).default('auto'),
  budget: z.number().int().min(0).max(4_000).default(2_000).describe('Saved-memory projection budget in JavaScript string length units, not tokens; includes status, metadata, and framing. Zero disables projection text.'),
  workspaces: z.record(z.string(), z.boolean()).default({}),
}).strict();
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

registerConfigSection(MEMORY_SECTION, MemoryConfigSchema, {
  defaultValue: { enabled: true, approval: 'auto', budget: 2_000, workspaces: {} },
});

export function memoryEnabled(config: MemoryConfig | undefined, workspaceId?: string): boolean {
  return config?.enabled === true && (workspaceId === undefined || config.workspaces[workspaceId] !== false);
}
