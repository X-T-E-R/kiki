/**
 * Plugin catalog shaping — pure, unit-tested. Feeds the Capabilities page's
 * marketplace (sections, recommendations, search) and the plugin detail
 * (what a plugin contributes, what it needs).
 *
 * The catalog is data, not code. Every grouping rule below reads a field the
 * catalog states about an entry (its declared sub-group, then its tier, then
 * its author), never a package name. Adding a package to
 * `plugins/marketplace.json` is therefore enough for it to appear, be
 * searched and be installable, with no change to this file: the market must
 * not need a client release to learn about a new plugin.
 */

import type { PluginMarketplaceEntry, PluginSummary, PluginUpdateStatus } from './client';

export type CatalogShelfId = 'recommended' | 'official' | 'community' | 'more';

/** The language the UI is reading in, as a catalog localization key. */
export type CatalogLocale = 'en' | 'zh';

/**
 * The entry's own text for the reader's language, field by field.
 *
 * A catalog entry may translate its name, its description or its search words,
 * in any combination, and may translate nothing at all. Each field falls back
 * to the top-level value, so a third-party entry with no localization reads
 * exactly as it was written, and a name the catalog did not translate keeps
 * its original spelling — brand names are not the catalog's to rewrite.
 */
export function localizeEntry(
  entry: PluginMarketplaceEntry,
  locale: CatalogLocale,
): { readonly displayName: string; readonly description?: string; readonly keywords: readonly string[] } {
  const localized = entry.localizations?.[locale];
  return {
    displayName: localized?.displayName ?? entry.displayName,
    description: localized?.description ?? entry.description,
    keywords: localized?.keywords ?? entry.keywords ?? [],
  };
}

export const CATALOG_SHELF_ORDER: readonly CatalogShelfId[] = [
  'recommended',
  'official',
  'community',
  'more',
];

export interface CatalogShelf {
  readonly id: CatalogShelfId;
  /**
   * A catalog-declared sub-group, drawn as its own block inside the shelf. A
   * package family (the media entry and its providers) declares one string
   * and reads as a block without the client naming any member.
   */
  readonly group?: string;
  readonly entries: readonly PluginMarketplaceEntry[];
}

/** Where an entry belongs, by what the catalog says about it. */
function shelfKey(entry: PluginMarketplaceEntry): CatalogShelfId {
  if (entry.tier === 'official') return 'official';
  if (entry.tier === 'curated') return 'community';
  return 'more';
}

/** One block per declared sub-group; entries without one stay together. */
function groupParts(shelf: CatalogShelf): readonly CatalogShelf[] {
  const groups = new Map<string, PluginMarketplaceEntry[]>();
  for (const entry of shelf.entries) {
    const key = entry.group ?? '';
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, [entry]);
    else existing.push(entry);
  }
  // A tier whose entries all declare one group is still that group, and says
  // so; a tier with no declared group keeps the tier's own heading. Either
  // way the heading is read off the entries themselves, never assumed.
  return [...groups.entries()].map(([group, entries]) => ({
    id: shelf.id,
    ...(group === '' ? {} : { group }),
    entries,
  }));
}

/**
 * The public catalog, grouped. Workspace matches lead as their own shelf, then
 * the rest by tier, and a tier that declares sub-groups breaks into blocks. An
 * empty shelf never renders, and a searching reader sees one flat list rather
 * than the same handful split under four headings.
 */
export function shelveCatalog(
  entries: readonly PluginMarketplaceEntry[],
  query: string,
  relevant: ReadonlySet<string> = new Set(),
): readonly CatalogShelf[] {
  const visible = entries.filter((entry) => catalogMatches(entry, query));
  const recommended = visible.filter((entry) => relevant.has(entry.id) && entry.tier !== 'third-party');
  const recommendedIds = new Set(recommended.map((entry) => entry.id));
  const shelves: CatalogShelf[] = recommended.length > 0 ? [{ id: 'recommended', entries: recommended }] : [];

  const buckets = new Map<CatalogShelfId, PluginMarketplaceEntry[]>();
  for (const entry of visible) {
    if (recommendedIds.has(entry.id)) continue;
    const key = shelfKey(entry);
    const existing = buckets.get(key);
    if (existing === undefined) buckets.set(key, [entry]);
    else existing.push(entry);
  }
  for (const id of CATALOG_SHELF_ORDER) {
    const entries = buckets.get(id);
    if (entries === undefined) continue;
    shelves.push(...groupParts({ id, entries }));
  }
  return shelves;
}

export function catalogMatches(entry: PluginMarketplaceEntry, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (query === '') return true;
  // Every language the catalog declares is searchable, not only the one on
  // screen. A reader who knows a package by the name they have always seen
  // finds it even while the window is in another language, and vice versa.
  const words = (texts: readonly (string | undefined)[]): readonly string[] => texts
    .filter((text): text is string => text !== undefined)
    .flatMap((text) => (text === '' ? [] : [text]));
  return [
    ...words([entry.displayName, entry.id, entry.description, entry.author, ...(entry.keywords ?? [])]),
    ...Object.values(entry.localizations ?? {}).flatMap((localized) => words([
      localized?.displayName,
      localized?.description,
      ...(localized?.keywords ?? []),
    ])),
  ].some((field) => field.toLowerCase().includes(query));
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

/**
 * The extra management surface a plugin contributes, read from its own
 * manifest (`x-kiki.mediaSurface`). A plugin asks for a surface by declaring
 * it, so a new one is a package change rather than a client change, and the
 * detail page can offer it without naming any plugin.
 */
export function pluginSurface(
  manifest: Readonly<Record<string, unknown>> | undefined,
): { readonly view: 'media' } | undefined {
  const surface = record(extensionOf(manifest)['mediaSurface']);
  return surface?.['view'] === 'media' ? { view: 'media' } : undefined;
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
 * An available update and where it comes from. A catalog update reinstalls
 * that entry's published source, carrying its digest so a published archive
 * can actually be verified; a GitHub update reinstalls the plugin's own
 * recorded source, which resolves the tracked branch or default ref again.
 * Either way the install sheet previews first and asks again when anything
 * changed, and nothing here installs on its own.
 */
export interface PluginUpdateView {
  readonly via: 'catalog' | 'github';
  readonly source: string;
  /** Catalog version or tag; a branch commit's short sha. */
  readonly version?: string;
  /** Set when a GitHub branch moved: the branch whose head is newer. */
  readonly branch?: string;
  /** The published archive's digest, when the catalog ships one. */
  readonly sha256?: string;
}

export function pluginUpdate(
  plugin: Pick<PluginSummary, 'id' | 'source' | 'originalSource'> | undefined,
  entry: Pick<PluginMarketplaceEntry, 'source' | 'version' | 'updateAvailable' | 'sha256'> | undefined,
  github: readonly PluginUpdateStatus[] | undefined,
): PluginUpdateView | undefined {
  if (plugin === undefined) return undefined;
  if (entry?.updateAvailable === true) {
    return { via: 'catalog', source: entry.source, version: entry.version, sha256: entry.sha256 };
  }
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

