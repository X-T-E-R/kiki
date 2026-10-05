import { satisfies, validRange } from 'semver';

import { KIKI_PLUGIN_ENGINE_VERSION } from './contributions';
import { parsePluginMarketplace, type PluginMarketplace, type PluginMarketplaceEntry, type PluginMarketplaceEntryLocalization } from './marketplace';
import { pluginRelevanceSchema, type PluginRelevance } from './relevance';
import metadata from './officialPlugins.metadata.json' with { type: 'json' };

/** Stable identity of the default catalog, whether served from the network or its bundled snapshot. */
export const OFFICIAL_PLUGIN_CATALOG_SOURCE = 'builtin:kiki-official-plugins';
export const DEFAULT_PLUGIN_CATALOG_ID = OFFICIAL_PLUGIN_CATALOG_SOURCE;

/** Public catalog; an unavailable or stalled request falls back to bundled metadata. */
export const OFFICIAL_PLUGIN_CATALOG_URL = 'https://x-t-e-r.github.io/kiki-plugins/marketplace.json';

const CATALOG_FETCH_TIMEOUT_MS = 5_000;

interface BundledOfficialMetadata {
  readonly version: number;
  readonly engineVersion: string;
  readonly official: readonly BundledOfficial[];
  readonly curated: readonly PluginMarketplaceEntry[];
}

interface BundledOfficial {
  readonly id: string;
  readonly version?: string;
  readonly displayName: string;
  readonly description?: string;
  readonly homepage?: string;
  readonly keywords?: readonly string[];
  readonly relevance?: PluginRelevance;
  readonly icon?: string;
  readonly engines?: { readonly kiki?: string };
  readonly license?: string;
  readonly author: string;
  readonly group?: string;
  readonly localizations?: Readonly<Record<string, PluginMarketplaceEntryLocalization>>;
  readonly source: string;
  readonly sha256: string;
}

const bundled = metadata as BundledOfficialMetadata;

/** Whether this build can satisfy an engine range, for the entry's own filter. */
export function entryAcceptsEngine(engines: { readonly kiki?: string } | undefined): boolean {
  if (engines?.kiki === undefined) return true;
  return engines.kiki.length > 0 && validRange(engines.kiki) !== null && satisfies(KIKI_PLUGIN_ENGINE_VERSION, engines.kiki);
}

export interface DefaultCatalogResult {
  readonly marketplace: PluginMarketplace;
  /** Entries with an install source, not a check of current download reachability. */
  readonly installable: number;
}

/**
 * Prefer the published catalog and fall back to the bundled metadata on failure.
 * Browsing needs no plugin payload tree. Installing still requires a reachable
 * package source, and remote ZIPs are verified against their catalog digest.
 */
export async function readDefaultPluginCatalog(
  options: { readonly fetchImpl?: typeof fetch; readonly url?: string } = {},
): Promise<DefaultCatalogResult> {
  const published = await readPublishedCatalog(options.fetchImpl ?? fetch, options.url ?? OFFICIAL_PLUGIN_CATALOG_URL);
  if (published !== undefined) {
    return {
      marketplace: { source: OFFICIAL_PLUGIN_CATALOG_SOURCE, plugins: published },
      installable: published.filter((entry) => entry.source !== '').length,
    };
  }

  const entries: PluginMarketplaceEntry[] = bundled.official.map((plugin) => ({
    id: plugin.id,
    tier: 'official',
    displayName: plugin.displayName,
    description: plugin.description,
    homepage: plugin.homepage,
    version: plugin.version,
    icon: plugin.icon,
    source: plugin.source,
    sha256: plugin.sha256,
    keywords: plugin.keywords,
    relevance: plugin.relevance === undefined ? undefined : pluginRelevanceSchema.parse(plugin.relevance),
    engines: plugin.engines,
    license: plugin.license,
    author: plugin.author,
    group: plugin.group,
    localizations: plugin.localizations,
  }));
  entries.push(...bundled.curated.map((entry) => ({
    ...entry,
    tier: entry.tier ?? 'curated',
    displayName: entry.displayName ?? entry.id,
  })));
  return {
    marketplace: { source: OFFICIAL_PLUGIN_CATALOG_SOURCE, plugins: entries },
    installable: bundled.official.filter((entry) => entry.source !== '').length,
  };
}

async function readPublishedCatalog(
  fetchImpl: typeof fetch,
  url: string,
): Promise<PluginMarketplaceEntry[] | undefined> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    const raw = await response.text();
    const parsed = parsePluginMarketplace(raw, { raw, kind: 'remote', resolved: url });
    return [...parsed.plugins];
  } catch {
    return undefined;
  }
}

export { KIKI_PLUGIN_ENGINE_VERSION };
