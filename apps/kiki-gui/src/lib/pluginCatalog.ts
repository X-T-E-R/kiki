/**
 * Plugin catalog shaping — pure, unit-tested. Feeds the Capabilities page's
 * marketplace (sections, recommendations, search) and the plugin detail
 * (what a plugin contributes, what it needs).
 *
 * The catalog carries no category field, so categories are derived: official
 * entries and workspace matches lead as "Featured", every other entry is
 * placed by its keywords into a small fixed category set, and anything
 * unplaced falls into "More". The order is the product order; an empty
 * category never renders.
 */

import type { PluginMarketplaceEntry, PluginSummary, PluginUpdateStatus } from './client';

export type CatalogShelfId = 'featured' | 'productivity' | 'coding' | 'web' | 'data' | 'more';

export const CATALOG_SHELF_ORDER: readonly CatalogShelfId[] = [
  'featured',
  'productivity',
  'coding',
  'web',
  'data',
  'more',
];

export function isCatalogShelf(value: string | null): value is CatalogShelfId {
  return value !== null && (CATALOG_SHELF_ORDER as readonly string[]).includes(value);
}

/** Keyword → category for non-featured entries. First hit wins. */
const SHELF_KEYWORDS: readonly (readonly [CatalogShelfId, readonly string[]])[] = [
  ['productivity', ['office', 'docx', 'xlsx', 'pptx', 'pdf', 'writing', 'manuscript', 'fiction', 'notes', 'notion', 'calendar', 'email']],
  ['coding', ['skills', 'planning', 'tdd', 'debugging', 'code-review', 'agents', 'git']],
  ['web', ['web', 'browser', 'css', 'frontend', 'vercel', 'deployment', 'nextjs', 'automation']],
  ['data', ['data', 'mcp', 'sql', 'analytics', 'datasource']],
];

export interface CatalogShelf {
  readonly id: CatalogShelfId;
  readonly entries: readonly PluginMarketplaceEntry[];
}

/** Category by keywords alone (the Featured lift happens in `shelveCatalog`). */
export function shelfOf(entry: PluginMarketplaceEntry): CatalogShelfId {
  if (entry.tier === 'official') return 'featured';
  const keywords = (entry.keywords ?? []).map((word) => word.toLowerCase());
  for (const [shelf, words] of SHELF_KEYWORDS) {
    if (keywords.some((word) => words.includes(word))) return shelf;
  }
  return 'more';
}

export function catalogMatches(entry: PluginMarketplaceEntry, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (query === '') return true;
  return [entry.displayName, entry.id, entry.description ?? '', ...(entry.keywords ?? [])]
    .some((field) => field.toLowerCase().includes(query));
}

/**
 * The public catalog in categories. Featured holds the official entries plus
 * any official/curated entry the server matched to the workspace (`relevant`
 * ids, which lead); every entry appears in exactly one category.
 * Third-party entries are never lifted into Featured.
 */
export function shelveCatalog(
  entries: readonly PluginMarketplaceEntry[],
  query: string,
  relevant: ReadonlySet<string> = new Set(),
): readonly CatalogShelf[] {
  const visible = entries.filter((entry) => catalogMatches(entry, query));
  const featured = (entry: PluginMarketplaceEntry) =>
    entry.tier === 'official' || (relevant.has(entry.id) && entry.tier !== 'third-party');
  const lead = [
    ...visible.filter((entry) => featured(entry) && relevant.has(entry.id)),
    ...visible.filter((entry) => featured(entry) && !relevant.has(entry.id)),
  ];
  return CATALOG_SHELF_ORDER
    .map((id) => ({
      id,
      entries: id === 'featured' ? lead : visible.filter((entry) => !featured(entry) && shelfOf(entry) === id),
    }))
    .filter((shelf) => shelf.entries.length > 0);
}

/** Where an installed plugin came from, as the Installed list labels it. */
export type PluginOrigin = 'official' | 'catalog' | 'local' | 'git' | 'zip';

/**
 * Official and catalog origins come from the catalog entry with the same id;
 * anything the catalog does not list is labelled by how it was installed.
 */
export function pluginOrigin(
  plugin: Pick<PluginSummary, 'id' | 'source'>,
  entries: readonly Pick<PluginMarketplaceEntry, 'id' | 'tier'>[],
): PluginOrigin {
  const entry = entries.find((candidate) => candidate.id === plugin.id);
  if (entry !== undefined) return entry.tier === 'official' ? 'official' : 'catalog';
  return plugin.source === 'github' ? 'git' : plugin.source === 'zip-url' ? 'zip' : 'local';
}

export function installedMatches(plugin: Pick<PluginSummary, 'id' | 'displayName' | 'originalSource'>, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (query === '') return true;
  return [plugin.displayName, plugin.id, plugin.originalSource ?? ''].some((field) => field.toLowerCase().includes(query));
}

/** Collapse a long category: the first `visible` cards, then "See N more" (never for one). */
export function shelfOverflow<T extends { readonly displayName: string }>(
  entries: readonly T[],
  visible: number,
): { readonly shown: readonly T[]; readonly hidden: readonly T[] } {
  // Folding away a single entry costs more than showing it.
  if (entries.length <= visible + 1) return { shown: entries, hidden: [] };
  return { shown: entries.slice(0, visible), hidden: entries.slice(visible) };
}

// ---------------------------------------------------------------------------
// Contributions and requirements, read from an installed plugin's manifest.

export interface PluginToolContribution {
  readonly name: string;
  readonly runtimeName: string;
  readonly description: string;
  readonly accesses: readonly string[];
}

export interface PluginContributions {
  readonly tools: readonly PluginToolContribution[];
  readonly panels: readonly { readonly id: string; readonly label: string; readonly slot: string }[];
  readonly commands: readonly { readonly name: string; readonly description?: string }[];
  readonly themes: readonly { readonly id: string; readonly label: string; readonly base?: string }[];
  readonly skills: number;
  readonly mcpServers: readonly string[];
  readonly hooks: number;
  readonly providerPresets: readonly { readonly id: string; readonly label: string }[];
  readonly hasSettings: boolean;
}

export interface PluginPermissionsView {
  readonly fs?: 'workspace' | 'outside';
  readonly net?: readonly string[];
  readonly exec?: readonly string[];
  readonly secrets?: boolean;
  readonly uiPanel?: boolean;
}

export interface PluginPrerequisiteView {
  readonly id: string;
  readonly kind: string;
  readonly required: boolean;
  readonly version?: string;
  readonly setting?: string;
  readonly executionHost?: string;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function list(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(value) ? value.map(record).filter((item) => item !== undefined) : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function accessLabel(access: Readonly<Record<string, unknown>>): string | undefined {
  if (access['kind'] !== 'file') return undefined;
  const operation = text(access['operation']);
  return operation === undefined ? undefined : operation;
}

/**
 * The manifest reaches the GUI in two spellings: the raw `x-kiki` block
 * (fixtures, older servers) or the parsed `kiki` extension (live server).
 */
function extensionOf(manifest: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> {
  return record(manifest?.['kiki']) ?? record(manifest?.['x-kiki']) ?? {};
}

export function pluginContributions(
  pluginId: string,
  manifest: Readonly<Record<string, unknown>> | undefined,
  counts: { readonly skillCount?: number; readonly hookCount?: number; readonly mcpServers?: readonly string[] } = {},
): PluginContributions {
  const extension = extensionOf(manifest);
  const tools = list(extension['tools']).flatMap((tool) => {
    const name = text(tool['name']);
    if (name === undefined) return [];
    const accesses = [...new Set(list(tool['accesses']).map(accessLabel).filter((label) => label !== undefined))];
    return [{ name, runtimeName: pluginToolRuntimeName(pluginId, name), description: text(tool['description']) ?? '', accesses }];
  });
  const panels = list(extension['panels']).flatMap((panel) => {
    const id = text(panel['id']);
    return id === undefined ? [] : [{ id, label: text(panel['label']) ?? id, slot: text(panel['slot']) ?? 'workspace' }];
  });
  const commands = [
    ...list(extension['commands']),
    ...list(manifest?.['commands']),
  ].flatMap((command) => {
    const name = text(command['name']);
    return name === undefined ? [] : [{ name, description: text(command['description']) }];
  });
  const themes = list(extension['themes']).flatMap((theme) => {
    const id = text(theme['id']);
    return id === undefined ? [] : [{ id, label: text(theme['label']) ?? id, base: text(theme['base']) }];
  });
  const providerPresets = list(extension['providerPresets']).flatMap((preset) => {
    const id = text(preset['id']);
    return id === undefined ? [] : [{ id, label: text(preset['label']) ?? id }];
  });
  return {
    tools,
    panels,
    commands,
    themes,
    skills: counts.skillCount ?? 0,
    mcpServers: counts.mcpServers ?? Object.keys(record(manifest?.['mcpServers']) ?? {}),
    hooks: counts.hookCount ?? 0,
    providerPresets,
    hasSettings: extension['settings'] !== undefined,
  };
}

export function pluginPermissions(manifest: Readonly<Record<string, unknown>> | undefined): PluginPermissionsView {
  const raw = record(extensionOf(manifest)['permissions']) ?? {};
  const strings = (value: unknown) => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
  return {
    fs: raw['fs'] === 'workspace' || raw['fs'] === 'outside' ? raw['fs'] : undefined,
    net: strings(raw['net']),
    exec: strings(raw['exec']),
    secrets: raw['secrets'] === true ? true : undefined,
    uiPanel: raw['uiPanel'] === true ? true : undefined,
  };
}

export function hasAnyPermission(permissions: PluginPermissionsView | undefined): boolean {
  if (permissions === undefined) return false;
  return permissions.fs !== undefined
    || (permissions.net?.length ?? 0) > 0
    || (permissions.exec?.length ?? 0) > 0
    || permissions.secrets === true
    || permissions.uiPanel === true;
}

export function pluginPrerequisites(
  info: { readonly prerequisites?: { readonly items: { readonly items: readonly Readonly<Record<string, unknown>>[] } } } | undefined,
  manifest: Readonly<Record<string, unknown>> | undefined,
): readonly PluginPrerequisiteView[] {
  const declared = info?.prerequisites?.items.items
    ?? list(record(extensionOf(manifest)['prerequisites'])?.['items']);
  return declared.flatMap((item) => {
    const id = text(item['id']);
    if (id === undefined) return [];
    return [{
      id,
      kind: text(item['kind']) ?? 'executable',
      required: item['required'] === true,
      version: text(item['version']),
      setting: text(item['setting']),
      executionHost: text(item['executionHost']),
    }];
  });
}

/** Runtime tool id the engine registers for a plugin tool. */
export function pluginToolRuntimeName(pluginId: string, tool: string): string {
  return `plugin__${pluginId}__${tool}`;
}

/**
 * Human label for a runtime tool name: `plugin__kiki-office__office_view`
 * reads as `office_view`; MCP `mcp__server__tool` reads as `tool`. Any other
 * name is returned unchanged.
 */
export function toolDisplayName(name: string): string {
  const match = /^(?:plugin|mcp)__[^_](?:[^_]|_(?!_))*__(.+)$/.exec(name);
  return match === null ? name : match[1]!;
}

/**
 * Contribution ids from a preview plan (`tool:office_view`, `panel:manuscript`,
 * `skill:0`) grouped by kind with counts, in a stable display order.
 */
export function planContributionGroups(contributions: readonly string[]): readonly { readonly kind: string; readonly names: readonly string[] }[] {
  const order = ['tool', 'panel', 'command', 'theme', 'skill', 'mcp', 'hook', 'provider', 'agent', 'settings'];
  const groups = new Map<string, string[]>();
  for (const item of contributions) {
    const separator = item.indexOf(':');
    const kind = separator < 0 ? item : item.slice(0, separator);
    const name = separator < 0 ? '' : item.slice(separator + 1);
    const bucket = groups.get(kind) ?? [];
    if (name !== '' && !/^\d+$/.test(name) && !/^\d+:/.test(name)) bucket.push(name);
    else bucket.push('');
    groups.set(kind, bucket);
  }
  return [...groups.entries()]
    .toSorted(([a], [b]) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)))
    .map(([kind, names]) => ({ kind, names }));
}

// ---------------------------------------------------------------------------
// Updates: one answer per installed plugin, whichever channel knows.

/**
 * An available update and where it comes from. Catalog updates reinstall the
 * catalog entry's source; GitHub updates reinstall the plugin's own recorded
 * source, which resolves the tracked branch or default ref again. Either way
 * the install sheet previews first and asks again when anything changed —
 * nothing here installs on its own.
 */
export interface PluginUpdateView {
  readonly via: 'catalog' | 'github';
  readonly source: string;
  /** Catalog version or tag; a branch commit's short sha. */
  readonly version?: string;
  /** Set when a GitHub branch moved: the branch whose head is newer. */
  readonly branch?: string;
}

export function pluginUpdate(
  plugin: Pick<PluginSummary, 'id' | 'source' | 'originalSource'> | undefined,
  entry: Pick<PluginMarketplaceEntry, 'source' | 'version' | 'updateAvailable'> | undefined,
  github: readonly PluginUpdateStatus[] | undefined,
): PluginUpdateView | undefined {
  if (plugin === undefined) return undefined;
  if (entry?.updateAvailable === true) return { via: 'catalog', source: entry.source, version: entry.version };
  if (plugin.source !== 'github' || plugin.originalSource === undefined) return undefined;
  const status = github?.find((item) => item.id === plugin.id);
  if (status?.updateAvailable !== true) return undefined;
  return {
    via: 'github',
    source: plugin.originalSource,
    version: status.displayVersion,
    ...(status.latest.kind === 'branch' ? { branch: status.latest.value } : {}),
  };
}

