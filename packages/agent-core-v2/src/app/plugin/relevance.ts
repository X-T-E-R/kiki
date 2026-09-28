import picomatch from 'picomatch';
import { z } from 'zod';

import type { PluginMarketplaceEntry } from './marketplace';

export const pluginRelevanceSchema = z.object({
  cwd: z.array(z.string().min(1).max(128)).max(20).optional(),
  fileGlobs: z.array(z.string().min(1).max(128)).max(20).optional(),
  commands: z.array(z.string().min(1).max(64)).max(20).optional(),
  dependencies: z.array(z.string().min(1).max(128)).max(20).optional(),
}).strict();

export const pluginRelevanceSignalsSchema = z.object({
  cwd: z.string().max(4096).optional(),
  files: z.array(z.string().max(4096)).max(100).default([]),
  commands: z.array(z.string().max(64)).max(30).default([]),
  dependencies: z.array(z.string().max(128)).max(100).default([]),
}).strict();

export type PluginRelevance = z.infer<typeof pluginRelevanceSchema>;
export type PluginRelevanceSignals = z.infer<typeof pluginRelevanceSignalsSchema>;

export function relevantPlugins(
  entries: readonly PluginMarketplaceEntry[],
  signals: PluginRelevanceSignals,
  installed: ReadonlySet<string>,
  dismissed: ReadonlySet<string>,
): readonly PluginMarketplaceEntry[] {
  const matches = (patterns: readonly string[] | undefined, values: readonly string[]) =>
    patterns?.some((pattern) => {
      const test = picomatch(pattern.replaceAll('\\', '/'), { nocase: true, dot: true });
      return values.some((value) => test(value.replaceAll('\\', '/')));
    }) === true;
  return entries.filter((entry) => {
    if ((entry.tier !== 'official' && entry.tier !== 'curated') ||
      installed.has(entry.id) || dismissed.has(entry.id) || entry.relevance === undefined) return false;
    return matches(entry.relevance.cwd, signals.cwd === undefined ? [] : [signals.cwd]) ||
      matches(entry.relevance.fileGlobs, signals.files) ||
      matches(entry.relevance.commands, signals.commands) ||
      matches(entry.relevance.dependencies, signals.dependencies);
  });
}
