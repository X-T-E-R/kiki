import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';
import { collectRemovedKeyDiagnostics } from '#/app/config/deprecations';

export const AGENTS_SECTION = 'agents';

const AgentsConfigBaseSchema = z.object({
  enabled: z.boolean().optional(),
  notify_parent: z.boolean().default(true),
  delegation: z
    .object({
      sub: z.boolean().optional(),
      independent: z.boolean().optional(),
    })
    .strict()
    .optional(),
}).strict();

export const AgentsConfigSchema = z.preprocess((raw) => {
  if (typeof raw === 'object' && raw !== null && 'notifyParent' in raw && !('notify_parent' in raw)) {
    const { notifyParent, ...rest } = raw as Record<string, unknown>;
    return { ...rest, notify_parent: notifyParent };
  }
  return raw;
}, AgentsConfigBaseSchema);

export type AgentsConfig = z.infer<typeof AgentsConfigBaseSchema>;

export function isParentNotifyEnabled(config: AgentsConfig | undefined): boolean {
  return config?.notify_parent !== false;
}

const REMOVED_AGENTS_KEYS = [
  'default_subagent_model',
  'default_subagent_reasoning_effort',
] as const;

registerConfigSection(AGENTS_SECTION, AgentsConfigSchema, {
  defaultValue: { enabled: true, notify_parent: true },
  collectDiagnostics: (rawSection) =>
    collectRemovedKeyDiagnostics(AGENTS_SECTION, rawSection, REMOVED_AGENTS_KEYS),
});
