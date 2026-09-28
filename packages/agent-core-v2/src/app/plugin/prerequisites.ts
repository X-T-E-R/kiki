import { z } from 'zod';

const dependencyId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

const prerequisiteSchema = z.object({
  id: dependencyId,
  kind: z.enum(['host-capability', 'daemon', 'browser-extension', 'executable', 'configuration']),
  required: z.boolean(),
  provider: z.enum(['kiki.compat.webbridge', 'kiki.compat.cu']).optional(),
  executionHost: z.literal('plugin-runtime').optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  setting: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/).optional(),
  dependsOn: z.array(dependencyId).max(20).optional(),
  capabilityImpact: z.array(z.string().max(64)).max(20).optional(),
}).strict();

export const pluginPrerequisitesSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(prerequisiteSchema).max(32),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const item of value.items) {
    if (ids.has(item.id)) {
      context.addIssue({ code: 'custom', message: `Duplicate prerequisite: ${item.id}` });
    }
    ids.add(item.id);
  }
  const byId = new Map(value.items.map((item) => [item.id, item]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      context.addIssue({ code: 'custom', message: `Prerequisite cycle at ${id}` });
      return;
    }
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dependency)) {
        context.addIssue({ code: 'custom', message: `Unknown prerequisite: ${dependency}` });
      } else {
        visit(dependency);
      }
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
});

export type PluginPrerequisites = z.infer<typeof pluginPrerequisitesSchema>;

const WEBBRIDGE_DEPENDENCIES: PluginPrerequisites = {
  schemaVersion: 1,
  items: [
    { id: 'webbridge-daemon', kind: 'daemon', required: true,
      executionHost: 'plugin-runtime' },
    { id: 'webbridge-extension', kind: 'browser-extension', required: true,
      executionHost: 'plugin-runtime',
      dependsOn: ['webbridge-daemon'] },
  ],
};

export function isRecognizedWebbridgePluginSource(id: string, source?: string): boolean {
  return id === 'kimi-webbridge' &&
    (source === 'https://code.kimi.com/kimi-code/plugins/official/kimi-webbridge.zip' ||
      source === 'https://code.kimi.ai/kimi-code/plugins/official/kimi-webbridge.zip');
}

export function resolvePluginPrerequisites(input: {
  readonly id: string;
  readonly version?: string;
  readonly source?: string;
  readonly declared?: PluginPrerequisites;
}): { readonly items: PluginPrerequisites; readonly origin: 'kiki-compatibility' | 'plugin-declared' } | undefined {
  if (isRecognizedWebbridgePluginSource(input.id, input.source)) {
    return { items: WEBBRIDGE_DEPENDENCIES, origin: 'kiki-compatibility' };
  }
  if (input.declared !== undefined) return { items: input.declared, origin: 'plugin-declared' };
  return undefined;
}
