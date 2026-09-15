/**
 * `#/utils/plugin-marketplace` — CLI-side wrapper over the shared plugin
 * marketplace client/parser (`@kiki/agent-core-v2`,
 * `app/plugin/marketplace`). The shared module owns catalog reading, the
 * lenient entry normalization, source resolution, and version derivation;
 * this wrapper adds only the CLI's configured-source resolution (option →
 * env → config), the source-checkout catalog for local development, and the
 * caller-supplied built-in capability entry injection.
 */

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  nonemptyMarketplaceSource,
  parsePluginMarketplace,
  readPluginMarketplace,
  resolvePluginMarketplaceSource,
  withBuiltInEntries,
  withLatestVersions,
  type MarketplaceLocation,
  type PluginMarketplace,
  type PluginMarketplaceEntry,
} from '@kiki/agent-core-v2/app/plugin/marketplace';
import type { KimiConfig } from '@kiki/node-sdk';

import { KIKI_PLUGIN_MARKETPLACE_URL_ENV } from '#/constant/app';

export {
  computeUpdateStatus,
  PLUGIN_MARKETPLACE_TIERS,
  withBuiltInEntries,
  withLatestVersions,
  type PluginMarketplace,
  type PluginMarketplaceEntry,
  type PluginMarketplaceTier,
  type MarketplaceUpdateStatus,
} from '@kiki/agent-core-v2/app/plugin/marketplace';

export const BUILT_IN_PLUGIN_MARKETPLACE_SOURCE = 'builtin:kimi-code-capabilities';
export const LOCAL_DEV_PLUGIN_MARKETPLACE_SOURCE = resolve(
  import.meta.dirname,
  '../../../../plugins/marketplace.json',
);

export interface LoadPluginMarketplaceOptions {
  readonly workDir: string;
  readonly source?: string;
  readonly configSource?: string;
  readonly fetchImpl?: typeof fetch;
  /**
   * Built-in capability rows to inject, supplied by the caller from the
   * engine's capability registry (this util owns no product knowledge).
   * Undefined means no injection.
   */
  readonly builtInEntries?: readonly PluginMarketplaceEntry[];
  /**
   * Skip the per-entry "latest GitHub release" lookups so the catalog can be
   * rendered as soon as it is parsed; the caller resolves versions in a second
   * phase with {@link withLatestVersions} and re-renders.
   */
  readonly skipLatestVersions?: boolean;
}

export function pluginMarketplaceConfigSource(config: Pick<KimiConfig, 'raw'>): string | undefined {
  const plugins = config.raw?.['plugins'];
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) return undefined;
  const value = (plugins as Record<string, unknown>)['marketplace_url'];
  return typeof value === 'string' ? value : undefined;
}

export function isDefaultPluginMarketplaceSource(
  source: string | undefined,
  configSource: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const resolved = resolvePluginMarketplaceSource({
    optionUrl: source,
    envUrl: env[KIKI_PLUGIN_MARKETPLACE_URL_ENV],
    configUrl: configSource,
  });
  if (resolved === undefined) return true;
  return (
    source === undefined &&
    env['KIKI_PLUGIN_MARKETPLACE_FROM_DEV_SERVER'] === '1' &&
    resolved === nonemptyMarketplaceSource(env[KIKI_PLUGIN_MARKETPLACE_URL_ENV])
  );
}

export function isLocalDevPluginMarketplaceSource(
  source: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (source === LOCAL_DEV_PLUGIN_MARKETPLACE_SOURCE) return true;
  const devSource = nonemptyMarketplaceSource(env[KIKI_PLUGIN_MARKETPLACE_URL_ENV]);
  return env['KIKI_PLUGIN_MARKETPLACE_FROM_DEV_SERVER'] === '1' && source === devSource;
}

export async function loadPluginMarketplace(
  options: LoadPluginMarketplaceOptions,
): Promise<PluginMarketplace> {
  const configuredSource = resolvePluginMarketplaceSource({
    optionUrl: options.source,
    envUrl: process.env[KIKI_PLUGIN_MARKETPLACE_URL_ENV],
    configUrl: options.configSource,
  });
  const localDevLocation =
    configuredSource === undefined ? await getSourceCheckoutMarketplaceLocation() : undefined;
  const source = configuredSource ?? localDevLocation?.raw;
  if (source === undefined) {
    return addBuiltInEntries(
      { source: BUILT_IN_PLUGIN_MARKETPLACE_SOURCE, plugins: [] },
      options.builtInEntries,
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  let read: { raw: string; location: MarketplaceLocation };
  try {
    read = await readPluginMarketplace({
      source,
      workDir: options.workDir,
      fetchImpl,
    });
  } catch (error) {
    if (options.builtInEntries !== undefined) {
      return withBuiltInEntries({ source, plugins: [] }, options.builtInEntries);
    }
    throw error;
  }
  const parsed = parsePluginMarketplace(read.raw, read.location);
  const marketplace =
    configuredSource === undefined || options.skipLatestVersions === true
      ? parsed
      : await withLatestVersions(parsed, fetchImpl);
  return addBuiltInEntries(marketplace, options.builtInEntries);
}

function addBuiltInEntries(
  marketplace: PluginMarketplace,
  builtInEntries: readonly PluginMarketplaceEntry[] | undefined,
): PluginMarketplace {
  return builtInEntries === undefined
    ? marketplace
    : withBuiltInEntries(marketplace, builtInEntries);
}

async function getSourceCheckoutMarketplaceLocation(): Promise<MarketplaceLocation | undefined> {
  const info = await stat(LOCAL_DEV_PLUGIN_MARKETPLACE_SOURCE).catch(() => undefined);
  if (info?.isFile() !== true) return undefined;
  return {
    raw: LOCAL_DEV_PLUGIN_MARKETPLACE_SOURCE,
    kind: 'local',
    resolved: LOCAL_DEV_PLUGIN_MARKETPLACE_SOURCE,
  };
}
