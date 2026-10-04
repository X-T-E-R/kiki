import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { z } from 'zod';
import {
  DEFAULT_SPACE_PREFERENCES, spacePreferenceValuesSchema, spaceSelectionSchema, spaceDomainSchema,
  type SpaceDetail, type SpaceItem, type SpaceDomain, type SpacePlanRequest, type SpacePreview,
  type SpaceMutationResponse, type SpacePreferenceImport, type SpacePreferenceImportResponse,
} from '@kiki/protocol';
import type { IConfigRegistry, IConfigService } from '@kiki/agent-core-v2';
import { readSpaceHome } from '@kiki/agent-core-v2/app/bootstrap/spaceHome';
import { spacePresetDefaults } from '@kiki/agent-core-v2/app/bootstrap/spacePresets';
import { splitConfigCredentials } from '@kiki/agent-core-v2/app/config/credentials';
import { transformTomlData, camelToSnake, applySectionToToml } from '@kiki/agent-core-v2/app/config/toml';
import { listSpaceResources, containsInlineMcpCredentials, type SpaceResource } from './resources';
import { listLiveServerInstances } from '../../instanceRegistry';

const stateSchema = z.object({
  schema: z.literal(2),
  preferences: spacePreferenceValuesSchema.partial().optional(),
  groups: z.partialRecord(spaceDomainSchema, z.enum(['follow', 'fixed'])).default({}),
  selections: z.record(z.string(), spaceSelectionSchema).default({}),
  imported_from: z.string().optional(),
  undo_id: z.string().optional(),
});
type State = z.infer<typeof stateSchema>;
type Files = Record<string, string | null>;
interface Snapshot { detail: SpaceDetail; state: State; local: Record<string, unknown>; base: Record<string, unknown>; localResources: SpaceResource[]; baseResources: SpaceResource[] }
interface Plan { preview: SpacePreview; request: SpacePlanRequest; snapshot: Snapshot; mainSnapshot: Snapshot; versions: Record<string, string>; mainVersions: Record<string, string> }
interface Undo { id: string; files: Files; after: Record<string, string> }
const STATE = 'space-preferences.json';
const GROUPS = spaceDomainSchema.options;
const prefNames: Record<string, string> = { theme: 'Theme mode', skin: 'Skin selection', tweaks: 'Appearance adjustments', background: 'Background', proseFont: 'Reading font', defaultAppendTiming: 'Append timing', foldSteps: 'Fold tool steps', worktreeSkipConfirm: 'Worktree confirmation' };
const configNames: Record<string, string> = { default_model: 'Default model', default_permission_mode: 'Default permission mode', default_plan_mode: 'Default plan mode', 'thinking.effort': 'Default thinking effort', 'session_title.model': 'Session title model', 'space_ui.landing_page': 'Landing page' };
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex'); }
function at(root: unknown, path: string[]): unknown { return path.reduce((value, key) => object(value) ? value[key] : undefined, root); }
function set(root: Record<string, unknown>, path: string[], value: unknown): void {
  if (path.some((part) => ['__proto__', 'constructor', 'prototype'].includes(part))) throw new Error('Invalid configuration item identity');
  let current = root;
  for (const key of path.slice(0, -1)) { if (!object(current[key])) current[key] = {}; current = current[key] as Record<string, unknown>; }
  const key = path.at(-1)!;
  if (value === undefined || value === null) delete current[key]; else current[key] = value;
}
function leaves(root: Record<string, unknown>, path: string[] = []): string[] {
  return Object.entries(root).flatMap(([key, value]) => object(value) && Object.keys(value).length > 0 ? leaves(value, [...path, key]) : [[...path, key].join('.')]);
}
function merge(base: unknown, patch: unknown): unknown {
  if (!object(base) || !object(patch)) return patch === undefined ? base : patch;
  const result = { ...base }; for (const [key, value] of Object.entries(patch)) result[key] = merge(result[key], value); return result;
}
async function text(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function state(home: string): Promise<State> {
  const contents = await text(join(home, STATE));
  return contents === undefined ? { schema: 2, groups: {}, selections: {} } : stateSchema.parse(JSON.parse(contents));
}
async function config(home: string): Promise<Record<string, unknown>> {
  const contents = await text(join(home, 'config.toml'));
  return contents === undefined ? {} : splitConfigCredentials(parse(contents)).config as Record<string, unknown>;
}
function inherit(home: string) {
  const entry = readSpaceHome(home).space;
  return { config: entry?.inherit.config ?? true, agents: entry?.inherit.agents ?? false, instructions: entry?.inherit.instructions ?? false,
    skills: entry?.inherit.skills ?? false, mcp: entry?.inherit.mcp ?? false, appearance: entry?.inherit.appearance ?? false,
    plugins: entry?.inherit.plugins ?? false, credentials: entry?.inherit.credentials ?? 'isolated', generic_roots: entry?.inherit.genericRoots ?? true };
}
function preferenceDomain(key: string): SpaceDomain { return ['theme', 'skin', 'tweaks', 'background', 'proseFont'].includes(key) ? 'appearance' : 'config'; }
function preferenceDependencies(key: string, value: unknown): string[] {
  if (key === 'skin' && object(value) && typeof value['id'] === 'string') {
    if (value['source'] === 'pack') return [`resource:appearance:themes/${value['id']}`];
    if (value['source'] === 'user') return value['id'].includes(':') ? [`resource:plugins:${value['id'].split(':')[0]}`] : [`resource:appearance:themes/${value['id']}.json`];
  }
  if (key === 'background' && object(value)) {
    const result = new Set<string>();
    for (const slot of [value['light'], value['dark']]) if (object(slot)) for (const media of [...(Array.isArray(slot['media']) ? slot['media'] : []), slot['poster']]) {
      if (object(media) && typeof media['id'] === 'string' && media['id'].startsWith('pack:')) result.add(`resource:appearance:themes/${media['id'].slice(5).split('/')[0]}`);
    }
    return [...result];
  }
  return [];
}
function same(a: unknown, b: unknown): boolean { return hash(a) === hash(b); }
async function fileHash(path: string): Promise<string> { return hash(await readFile(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; })); }

function secretMcp(value: unknown): boolean { return containsInlineMcpCredentials(value); }
function publicSnapshot(path: string, value: string | null): string | null {
  if (value === null) return null;
  const contents = Buffer.from(value, 'base64').toString();
  if (basename(path) === 'config.toml') return Buffer.from(stringify(splitConfigCredentials(parse(contents)).config)).toString('base64');
  if (basename(path) === 'mcp.json') {
    const data = JSON.parse(contents);
    data.mcpServers = Object.fromEntries(Object.entries(data.mcpServers ?? {}).filter(([, entry]) => !secretMcp(entry)));
    return Buffer.from(JSON.stringify(data)).toString('base64');
  }
  return value;
}
async function restorePublicSnapshot(path: string, value: string | null): Promise<string | null> {
  const current = await text(path);
  if (basename(path) === 'config.toml' && current !== undefined) {
    const publicValue = value === null ? {} : parse(Buffer.from(value, 'base64').toString());
    const credentials = splitConfigCredentials(parse(current)).credentials;
    const result = merge(publicValue, credentials) as Parameters<typeof stringify>[0];
    return Object.keys(result).length === 0 && value === null ? null : Buffer.from(stringify(result)).toString('base64');
  }
  if (basename(path) === 'mcp.json' && current !== undefined) {
    const data = value === null ? {} : JSON.parse(Buffer.from(value, 'base64').toString());
    const secrets = Object.fromEntries(Object.entries(JSON.parse(current).mcpServers ?? {}).filter(([, entry]) => secretMcp(entry)));
    data.mcpServers = { ...data.mcpServers, ...secrets };
    return Buffer.from(JSON.stringify(data)).toString('base64');
  }
  return value;
}
function allowedUndoPath(path: string, home: string, main: string): boolean {
  const local = relative(home, path).replaceAll('\\', '/');
  const parent = relative(main, path).replaceAll('\\', '/');
  const allowed = (value: string) => !isAbsolute(value) && !value.startsWith('../') && (['config.toml', 'home.toml', 'space-preferences.json', 'mcp.json', 'SYSTEM.md', 'AGENTS.md'].includes(value) || /^(?:agents|skills|commands|themes|plugins|\.space-resources)\//.test(value));
  return allowed(local) || allowed(parent) && !parent.startsWith(`${basename(home)}/`);
}

export class SpacePreferencesStore {
  private readonly plans = new Map<string, Plan>();
  private readonly runtime = new Map<string, SpaceDetail>();
  constructor(private readonly registry: IConfigRegistry, private readonly runningHome?: string, private readonly runtimeConfig?: IConfigService) {}

  private readonly runtimeId = randomUUID();
  private readonly runtimeStartedAt = Date.now();
  private runtimeWrites: Promise<void> = Promise.resolve();
  private saveRuntime(home: string, detail: SpaceDetail): Promise<void> {
    const payload = JSON.stringify({ pid: process.pid, started_at: this.runtimeStartedAt, detail });
    this.runtimeWrites = this.runtimeWrites.catch(() => undefined).then(async () => {
      const directory = join(home, '.space-resources/runtime');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const destination = join(directory, `${this.runtimeId}.json`);
      const temporary = `${destination}.tmp`;
      try {
        await writeFile(temporary, payload, { mode: 0o600 });
        await rename(temporary, destination);
      } finally { await rm(temporary, { force: true }); }
    });
    return this.runtimeWrites;
  }
  async captureRuntime(home: string, main: string): Promise<void> {
    const detail = (await this.snapshot(home, main)).detail;
    this.runtime.set(home, detail);
    await this.saveRuntime(home, detail);
  }
  async refreshRuntimeConfig(): Promise<void> {
    if (this.runningHome === undefined || this.runtimeConfig === undefined) return;
    const detail = this.runtime.get(this.runningHome);
    if (detail === undefined) return;
    await this.runtimeConfig.ready;
    const values: Record<string, unknown> = {};
    for (const [domain, value] of Object.entries(this.runtimeConfig.getAll())) applySectionToToml(values, domain, value, this.registry);
    const publicValues = splitConfigCredentials(values).config;
    for (const item of detail.items) if (item.kind === 'config') {
      const path = item.id.slice(7).split('.');
      item.actual = at(publicValues, path) ?? null;
      const domain = path[0]!.replaceAll(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase());
      const originKey = path.slice(1).map((part) => part.replaceAll(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase())).join('.');
      const origin = this.runtimeConfig.origins(domain)[originKey];
      item.origin = origin === 'env' || origin === 'memory' ? 'environment' : origin === 'base' ? 'main' : origin === 'default' ? 'builtin' : origin === 'preset' ? 'preset' : 'home';
    }
    await this.saveRuntime(this.runningHome, detail);
  }
  async close(): Promise<void> {
    await this.runtimeWrites.catch(() => undefined);
    if (this.runningHome !== undefined) await rm(join(this.runningHome, '.space-resources/runtime', `${this.runtimeId}.json`), { force: true });
  }
  private async activeDetail(home: string): Promise<SpaceDetail | undefined> {
    const own = this.runtime.get(home);
    if (own !== undefined) return own;
    const live = await listLiveServerInstances(home);
    if (live.length === 0) return undefined;
    const directory = join(home, '.space-resources/runtime');
    const names = await readdir(directory).catch(() => []);
    const records: { pid: number; started_at: number; detail: SpaceDetail }[] = [];
    for (const name of names.filter((entry) => entry.endsWith('.json')).slice(0, 128)) {
      const value = await text(join(directory, name));
      if (value === undefined) continue;
      const record = JSON.parse(value) as { pid: number; started_at: number; detail: SpaceDetail };
      if (live.some((instance) => instance.pid === record.pid)) records.push(record);
    }
    return records.toSorted((left, right) => right.started_at - left.started_at)[0]?.detail;
  }

  private mergedConfig(base: Record<string, unknown>, local: Record<string, unknown>): Record<string, unknown> {
    const result = merge(base, local) as Record<string, unknown>;
    for (const section of this.registry.listSections()) {
      const key = camelToSnake(section.domain);
      if (section.layerMerge === 'union' && Array.isArray(base[key]) && Array.isArray(local[key])) result[key] = [...new Set([...base[key], ...local[key]])];
    }
    for (const key of ['providers', 'models']) {
      if (!object(result[key]) || !object(local[key])) continue;
      for (const [id, value] of Object.entries(local[key])) if (object(value) && value['enabled'] === false) delete result[key][id];
    }
    return result;
  }

  private async snapshot(home: string, main: string): Promise<Snapshot> {
    const primary = home === main;
    const metadata = readSpaceHome(home).space;
    const current = await state(home);
    const parent = primary ? current : await state(main);
    const source = inherit(home);
    const local = await config(home);
    const base = primary ? {} : await config(main);
    const localResources = await listSpaceResources(home);
    const baseResources = primary ? [] : await listSpaceResources(main);
    if (source.instructions === 'stack') {
      const supplement = localResources.find((item) => item.id === 'resource:instructions:AGENTS.md');
      if (supplement !== undefined) { supplement.id = 'resource:instructions:local-supplement'; supplement.name = 'Local instruction supplement'; }
      const frozen = await text(join(home, '.space-resources/instructions-fixed.md'));
      if (frozen !== undefined) localResources.push({ id: 'resource:instructions:AGENTS.md', name: 'Main instructions', domain: 'instructions', value: { bytes: Buffer.byteLength(frozen), files: ['AGENTS.md'] }, files: { 'AGENTS.md': Buffer.from(frozen).toString('base64') }, dependencies: [] });
    }
    const items: SpaceItem[] = [];
    const groups: SpaceDetail['groups'] = GROUPS.map((domain) => ({ domain, mode: current.groups[domain] ?? (primary || source[domain] === false || source[domain] === 'isolated' ? 'fixed' : 'follow'), fixed_count: 0, follow_count: 0 }));
    const groupMode = (domain: SpaceDomain) => groups.find((group) => group.domain === domain)!.mode;
    const prefs = { ...DEFAULT_SPACE_PREFERENCES };
    for (const key of Object.keys(DEFAULT_SPACE_PREFERENCES) as (keyof typeof DEFAULT_SPACE_PREFERENCES)[]) {
      const id = `pref:${key}`;
      const stored = current.preferences?.[key];
      const mainValue = parent.preferences?.[key] ?? DEFAULT_SPACE_PREFERENCES[key];
      const selection = current.selections[id] ?? { mode: primary || stored !== undefined || current.preferences === undefined ? 'fixed' : groupMode(preferenceDomain(key)), reason: current.preferences === undefined || stored !== undefined ? 'migrated' : undefined };
      const value = primary || selection.mode === 'fixed' ? stored ?? DEFAULT_SPACE_PREFERENCES[key] : mainValue;
      Object.assign(prefs, { [key]: value });
      items.push({ id, name: prefNames[key]!, domain: preferenceDomain(key), kind: 'preference', selection,
        stored: stored ?? null, effective: value, main: mainValue, actual: value,
        origin: selection.mode === 'follow' ? 'main' : stored === undefined ? 'builtin' : 'home', available: true, pending: false,
        activation: 'immediate', revision: hash([selection, stored, value]), main_revision: hash(mainValue), dependencies: preferenceDependencies(key, value), can_push: !primary });
    }
    const defaults: Record<string, unknown> = {};
    for (const section of this.registry.listSections()) {
      applySectionToToml(defaults, section.domain, this.registry.defaultValue(section.domain), this.registry);
    }
    const preset = primary ? {} : spacePresetDefaults(metadata?.preset);
    const effectiveBase = this.mergedConfig(defaults, this.mergedConfig(preset, base));
    const effectiveIndependent = this.mergedConfig(defaults, preset);
    const filteredBase = structuredClone(groupMode('config') === 'follow' ? base : {});
    for (const [id, selection] of Object.entries(current.selections)) {
      if (!id.startsWith('config:')) continue;
      const path = id.slice(7).split('.');
      set(filteredBase, path, selection.mode === 'follow' ? at(base, path) : undefined);
    }
    const effective = this.mergedConfig(this.mergedConfig(defaults, this.mergedConfig(preset, filteredBase)), local);
    const paths = new Set([...leaves(splitConfigCredentials(defaults).config as Record<string, unknown>), ...leaves(preset), ...leaves(local), ...leaves(base), ...Object.keys(current.selections).filter((id) => id.startsWith('config:')).map((id) => id.slice(7)), ...Object.keys(configNames)]);
    for (const path of paths) {
      const id = `config:${path}`;
      const stored = at(local, path.split('.'));
      const value = at(effective, path.split('.'));
      const authoredSelection = current.selections[id];
      const selection = stored !== undefined && authoredSelection?.mode === 'follow' ? { mode: 'fixed' as const, reason: 'edited' as const } : authoredSelection ?? { mode: primary || stored !== undefined ? 'fixed' : groupMode('config'), reason: stored !== undefined ? 'migrated' : undefined };
      items.push({ id, name: configNames[path] ?? path.replaceAll('_', ' ').split('.').join(' · '), domain: 'config', kind: 'config', selection,
        stored: stored ?? null, effective: value ?? at(effectiveIndependent, path.split('.')) ?? null,
        main: at(effectiveBase, path.split('.')) ?? null, actual: value ?? null,
        origin: stored !== undefined ? 'home' : selection.mode === 'follow' ? 'main' : at(preset, path.split('.')) !== undefined ? 'preset' : 'builtin',
        available: true, pending: false, activation: 'immediate', revision: hash([selection, stored, value]), main_revision: hash(at(effectiveBase, path.split('.'))), dependencies: [], can_push: !primary });
    }
    for (const id of new Set([...localResources.map((item) => item.id), ...baseResources.map((item) => item.id), ...Object.keys(current.selections).filter((id) => id.startsWith('resource:'))])) {
      const own = localResources.find((item) => item.id === id);
      const upstream = baseResources.find((item) => item.id === id);
      const domain = (own ?? upstream)?.domain ?? id.split(':')[1] as SpaceDomain;
      const selection = current.selections[id] ?? { mode: primary || own !== undefined ? 'fixed' : groupMode(domain), reason: own !== undefined ? 'migrated' : undefined };
      const selected = selection.excluded ? undefined : own ?? (selection.mode === 'follow' ? upstream : undefined);
      const value = selected === undefined ? null : { ...objectValue(selected.value), content_revision: hash(selected.files) };
      const mainValue = upstream === undefined ? null : { ...objectValue(upstream.value), content_revision: hash(upstream.files) };
      items.push({ id, name: (own ?? upstream)?.name ?? id.split(':').slice(2).join(':'), domain, kind: 'resource', selection,
        stored: own?.value ?? null, effective: value, main: mainValue, actual: value,
        origin: selected === undefined ? 'unavailable' : selected === own ? 'home' : 'main', available: selected !== undefined,
        pending: false, activation: 'restart', revision: hash([selection, own?.files, own?.value, value]), main_revision: hash([upstream?.files, upstream?.value]),
        dependencies: selected?.dependencies ?? [], can_push: !primary && selected !== undefined && selected.blockedReason === undefined && !selection.excluded,
        blocked_reason: selected?.blockedReason });
    }
    for (const domain of ['credentials', 'generic_roots', 'instructions'] as const) {
      const value = source[domain];
      const id = `source:${domain}`;
      items.push({ id, domain, name: domain === 'credentials' ? 'Accounts and keys' : domain === 'instructions' ? 'Instruction layering' : 'Generic skills and agents', kind: 'source',
        selection: { mode: domain === 'credentials' ? value === 'shared' ? 'follow' : 'fixed' : value ? 'follow' : 'fixed' },
        stored: value, effective: value, main: null, actual: value,
        origin: domain === 'credentials' ? value === 'shared' ? 'shared' : 'isolated' : 'home', available: true,
        pending: false, activation: 'restart', revision: hash(value), main_revision: hash(null), dependencies: [], can_push: false });
    }
    for (const item of items) if (item.kind === 'preference' && item.dependencies.some((id) => !items.find((entry) => entry.id === id)?.available)) {
      item.available = false; item.origin = 'unavailable'; item.blocked_reason = 'Selected appearance resource is unavailable; choose another appearance';
    }
    const active = await this.activeDetail(home);
    let restartRequired = active !== undefined && !same(active.inherit, source);
    const actualConfig: Record<string, unknown> = {};
    if (home === this.runningHome && this.runtimeConfig !== undefined) {
      await this.runtimeConfig.ready;
      for (const [domain, value] of Object.entries(this.runtimeConfig.getAll())) applySectionToToml(actualConfig, domain, value, this.registry);
    }
    for (const item of items) {
      const previous = active?.items.find((entry) => entry.id === item.id);
      if (item.activation === 'restart' && active !== undefined && !same([item.selection, item.effective], previous === undefined ? undefined : [previous.selection, previous.effective])) {
        item.actual = previous?.effective ?? null; item.pending = true; restartRequired = true;
      }
      if (item.kind === 'config' && home === this.runningHome && this.runtimeConfig !== undefined) {
        const path = item.id.slice(7).split('.');
        item.actual = at(splitConfigCredentials(actualConfig).config, path) ?? null;
        const domain = path[0]!.replaceAll(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase());
        const originKey = path.slice(1).map((part) => part.replaceAll(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase())).join('.');
        const actualOrigin = this.runtimeConfig.origins(domain)[originKey];
        if (actualOrigin === 'env' || actualOrigin === 'memory') item.origin = 'environment';
        else if (!same(item.actual, item.effective)) { item.activation = 'restart'; item.pending = true; restartRequired = true; }
      } else if (item.kind === 'config' && home !== this.runningHome) {
        item.actual = previous?.actual ?? null;
        if (previous?.origin === 'environment') item.origin = 'environment';
        else if (active !== undefined && !same(item.actual, item.effective)) { item.activation = 'restart'; item.pending = true; restartRequired = true; }
      }
      const group = groups.find((entry) => entry.domain === item.domain)!;
      if (item.selection.mode === 'fixed') group.fixed_count++; else group.follow_count++;
    }
    const detail: SpaceDetail = { schema: 2, id: metadata?.id ?? 'main', name: metadata?.name ?? 'Main space', primary,
      revision: hash([current, local, localResources.map((item) => [item.id, item.files, item.value]), source]), inherit: source,
      groups, items, preferences: spacePreferenceValuesSchema.parse(prefs), preference_authority: current.preferences !== undefined,
      undo_id: current.undo_id, restart_required: restartRequired };
    return { detail, state: current, local, base, localResources, baseResources };
  }

  async detail(home: string, main: string): Promise<SpaceDetail> { return (await this.snapshot(home, main)).detail; }

  async preview(home: string, main: string, request: SpacePlanRequest): Promise<SpacePreview> {
    const snapshot = await this.snapshot(home, main);
    const mainSnapshot = await this.snapshot(main, main);
    if (snapshot.detail.primary && request.action !== 'edit' && request.action !== 'fixed') throw new Error('Main space has no parent source');
    const requested = new Set(request.items ?? []);
    for (const change of request.changes ?? []) requested.add(change.id);
    for (const domain of request.groups ?? []) for (const item of snapshot.detail.items) if (item.domain === domain) requested.add(item.id);
    const rows: SpacePreview['rows'] = [];
    const versions: Record<string, string> = {};
    const mainVersions: Record<string, string> = {};
    for (const id of requested) {
      const item = snapshot.detail.items.find((entry) => entry.id === id);
      if (item === undefined) throw new Error(`Unknown space item: ${id}`);
      const change = request.changes?.find((entry) => entry.id === id);
      if (request.action === 'edit' && change === undefined) throw new Error('Every edited item needs an explicit value');
      const mainChanged = item.selection.baseline_revision !== undefined && item.selection.baseline_revision !== item.main_revision;
      const conflict = mainChanged && !same(item.effective, item.main) && !same(item.effective, item.selection.baseline);
      let blocked = item.kind === 'preference' ? undefined : item.blocked_reason;
      if (request.action === 'follow' && item.kind === 'resource' && !snapshot.localResources.some((entry) => entry.id === id && entry.blockedReason !== undefined)) blocked = undefined;
      if (request.action === 'push-to-main' && !item.can_push) blocked = 'This item cannot be shared through the ordinary push flow';
      if (request.action === 'exclude' && item.kind !== 'resource') blocked = 'Only resources can be excluded';
      if (request.action === 'edit' && item.kind === 'resource') blocked = 'Edit this resource through its resource editor';
      if (request.action === 'fixed' && item.kind === 'resource' && !item.available) blocked = 'Resource content is unavailable';
      if (change !== undefined && item.kind === 'preference') spacePreferenceValuesSchema.shape[id.slice(5) as keyof typeof DEFAULT_SPACE_PREFERENCES].parse(change.value);
      const sourceAfter = item.domain === 'credentials' ? request.action === 'follow' ? 'shared' : 'isolated' : request.action === 'follow';
      const after = item.kind === 'source' ? change?.value ?? sourceAfter : request.action === 'follow' ? item.main : request.action === 'exclude' ? null : change?.value ?? item.effective;
      const dependencies = item.kind === 'preference' ? preferenceDependencies(id.slice(5), after) : item.dependencies;
      for (const dependency of dependencies) {
        const catalog = request.action === 'push-to-main' ? mainSnapshot.detail.items : snapshot.detail.items;
        if (!catalog.find((entry) => entry.id === dependency)?.available && !(request.action === 'push-to-main' && requested.has(dependency))) blocked = 'Required appearance resource is unavailable in the destination space';
      }
      rows.push({ id, name: item.name, domain: item.domain, before: request.action === 'push-to-main' ? item.main : item.effective,
        after, selected: blocked === undefined && !(item.id === 'source:instructions' && request.groups?.includes('instructions') && !request.items?.includes(item.id) && request.action !== 'edit') && !(request.action === 'follow' && item.kind === 'resource' && item.main === null) && !(request.action === 'push-to-main' && (conflict || item.selection.baseline_revision === undefined || item.main === null)),
        same_value: same(request.action === 'push-to-main' ? item.main : item.effective, after), main_changed: mainChanged, conflict,
        dependencies, blocked_reason: blocked });
      versions[id] = item.revision; mainVersions[id] = item.main_revision;
    }
    for (const domain of request.groups ?? []) {
      const id = `group:${domain}`;
      rows.push({ id, domain, name: `Future ${domain} items`, before: snapshot.detail.groups.find((group) => group.domain === domain)!.mode,
        after: request.action === 'follow' ? 'follow' : 'fixed', selected: request.action !== 'push-to-main', same_value: false, main_changed: false, conflict: false, dependencies: [] });
      versions[id] = hash([snapshot.state.groups[domain], snapshot.detail.inherit[domain], snapshot.detail.items.filter((item) => item.domain === domain).map((item) => [item.id, item.revision, item.main_revision])]);
    }
    const token = randomUUID();
    const preview: SpacePreview = { schema: 2, token, action: request.action, rows, revision: snapshot.detail.revision,
      main_revision: mainSnapshot.detail.revision, restart_required: rows.some((row) => snapshot.detail.items.find((item) => item.id === row.id)?.activation === 'restart' || row.id.startsWith('group:')), expires_at: new Date(Date.now() + 10 * 60_000).toISOString() };
    this.plans.set(token, { preview, request, snapshot, mainSnapshot, versions, mainVersions });
    if (this.plans.size > 128) this.plans.delete(this.plans.keys().next().value!);
    return preview;
  }

  async apply(home: string, main: string, token: string, selected: string[], allowPush: boolean): Promise<SpaceMutationResponse> {
    const plan = this.plans.get(token);
    if (plan === undefined || Date.parse(plan.preview.expires_at) < Date.now() || plan.snapshot.detail.id !== (readSpaceHome(home).space?.id ?? 'main')) throw new Error('Preview expired; confirm a new preview');
    if (plan.request.action === 'push-to-main' && !allowPush) throw new Error('Updating main space requires main-space management authority');
    if (new Set(selected).size !== selected.length) throw new Error('Duplicate selection');
    if (selected.length === 0) return { detail: await this.detail(home, main), applied: [] };
    return this.locked(main, async () => {
      const current = await this.snapshot(home, main);
      const parent = await this.snapshot(main, main);
      const selectedSet = new Set(selected);
      for (const id of selected) {
        const row = plan.preview.rows.find((entry) => entry.id === id);
        if (row === undefined || row.blocked_reason !== undefined) throw new Error('Selected item is not available in this preview');
        if (id.startsWith('group:')) {
          const domain = spaceDomainSchema.parse(id.slice(6));
          if (hash([current.state.groups[domain], current.detail.inherit[domain], current.detail.items.filter((item) => item.domain === domain).map((item) => [item.id, item.revision, item.main_revision])]) !== plan.versions[id]) throw new Error('Space source changed; confirm a new preview');
        } else {
          const item = current.detail.items.find((entry) => entry.id === id);
          if (item === undefined || item.revision !== plan.versions[id] || item.main_revision !== plan.mainVersions[id]) throw new Error('Settings changed; confirm a new preview');
          for (const dependency of row.dependencies) {
            const expected = plan.snapshot.detail.items.find((entry) => entry.id === dependency);
            const now = current.detail.items.find((entry) => entry.id === dependency);
            if (!same(expected?.revision, now?.revision) || !same(expected?.main_revision, now?.main_revision)) throw new Error('Resource dependency changed; confirm a new preview');
            if (plan.request.action === 'fixed' && item.kind === 'resource' && now?.selection.mode === 'follow' && !selectedSet.has(dependency)) throw new Error('Select the required resource dependency too');
            if (plan.request.action === 'push-to-main' && !parent.detail.items.find((entry) => entry.id === dependency)?.available && !selectedSet.has(dependency)) throw new Error('Select the resource required in main space too');
            if (plan.request.action === 'exclude' && selectedSet.has(dependency)) throw new Error('A selected item still requires this resource');
          }
        }
      }
      const files: Files = {};
      const next = structuredClone(current.state);
      const nextParent = structuredClone(parent.state);
      const local = structuredClone(current.local);
      const mainConfig = structuredClone(parent.local);
      const rawLocal = await text(join(home, 'config.toml'));
      const rawMain = await text(join(main, 'config.toml'));
      const homeToml = await text(join(home, 'home.toml'));
      const metadata: Record<string, unknown> | undefined = homeToml === undefined ? undefined : parse(homeToml);
      const action = plan.request.action;
      for (const id of selected) {
        if (id.startsWith('group:')) {
          const domain = spaceDomainSchema.parse(id.slice(6));
          next.groups[domain] = action === 'follow' ? 'follow' : 'fixed';
          for (const item of current.detail.items) if (item.domain === domain && !selectedSet.has(item.id) && item.kind !== 'source') next.selections[item.id] = structuredClone(item.selection);
          if (metadata !== undefined) {
            const table = object(metadata['inherit']) ? metadata['inherit'] : {};
            if (domain !== 'credentials' && domain !== 'generic_roots' && !(domain === 'instructions' && table[domain] === 'stack')) table[domain] = action === 'follow';
            metadata['inherit'] = table;
          }
          continue;
        }
        const item = current.detail.items.find((entry) => entry.id === id)!;
        const change = plan.request.changes?.find((entry) => entry.id === id);
        if (item.kind === 'source') {
          if (metadata === undefined) throw new Error('Main-space source cannot be changed');
          const table = object(metadata['inherit']) ? metadata['inherit'] : {};
          table[item.domain] = action === 'edit' ? change!.value : item.domain === 'credentials' ? action === 'follow' ? 'shared' : 'isolated' : action === 'follow';
          if (item.domain === 'credentials' && table[item.domain] !== 'shared' && table[item.domain] !== 'isolated') throw new Error('Invalid credential mode');
          if (item.domain === 'generic_roots' && typeof table[item.domain] !== 'boolean') throw new Error('Invalid generic resource source');
          if (item.domain === 'instructions' && typeof table[item.domain] !== 'boolean' && table[item.domain] !== 'stack') throw new Error('Invalid instruction layering mode');
          metadata['inherit'] = table; continue;
        }
        const previousSelection = item.selection;
        next.selections[id] = action === 'follow' || action === 'push-to-main' ? { mode: 'follow' } : {
          mode: 'fixed', reason: action === 'edit' ? 'edited' : 'frozen', excluded: action === 'exclude' ? true : undefined,
          baseline: previousSelection.baseline ?? item.main, baseline_revision: previousSelection.baseline_revision ?? item.main_revision,
        };
        if (item.kind === 'preference') {
          const key = id.slice(5) as keyof typeof DEFAULT_SPACE_PREFERENCES;
          next.preferences ??= {};
          if (action === 'push-to-main') { nextParent.preferences ??= {}; Object.assign(nextParent.preferences, { [key]: item.effective }); nextParent.selections[id] = { mode: 'fixed', reason: 'edited' }; }
          if (action === 'follow' || action === 'push-to-main') delete next.preferences[key];
          else Object.assign(next.preferences, { [key]: change?.value ?? item.effective });
        } else if (item.kind === 'config') {
          const path = id.slice(7).split('.');
          if (action === 'push-to-main') set(mainConfig, path, item.effective);
          set(local, path, action === 'follow' || action === 'push-to-main' ? undefined : change?.value ?? item.effective);
        } else {
          const own = current.localResources.find((entry) => entry.id === id);
          const upstream = current.baseResources.find((entry) => entry.id === id);
          const resource = own ?? upstream;
          if (action === 'push-to-main') await this.writeResource(main, resource!, files, parent.localResources.find((entry) => entry.id === id));
          if (action === 'follow' || action === 'push-to-main' || action === 'exclude') {
            if (own !== undefined) await this.deactivateResource(home, own, files);
            if (action === 'follow' && upstream === undefined) next.selections[id] = { mode: 'fixed', excluded: true, reason: 'frozen' };
          } else if (resource !== undefined) await this.writeResource(home, resource, files, own);
        }
      }
      const validate = (value: Record<string, unknown>) => {
        const transformed = transformTomlData(value, this.registry);
        for (const [domain, entry] of Object.entries(transformed)) if (this.registry.getSection(domain) !== undefined) this.registry.validate(domain, entry);
      };
      validate(local); validate(mainConfig);
      const restoreSecrets = (raw: string | undefined, publicConfig: Record<string, unknown>) => {
        const original = raw === undefined ? {} : parse(raw);
        const parts = splitConfigCredentials(original);
        return stringify(merge(publicConfig, parts.credentials) as Parameters<typeof stringify>[0]);
      };
      if (!same(local, current.local)) files[join(home, 'config.toml')] = Buffer.from(restoreSecrets(rawLocal, local)).toString('base64');
      if (!same(mainConfig, parent.local)) files[join(main, 'config.toml')] = Buffer.from(restoreSecrets(rawMain, mainConfig)).toString('base64');
      if (metadata !== undefined && homeToml !== undefined && !same(metadata, parse(homeToml))) {
        files[join(home, 'home.toml')] = Buffer.from(stringify(metadata as Parameters<typeof stringify>[0])).toString('base64');
      }
      const undoId = randomUUID();
      next.undo_id = undoId;
      files[join(home, STATE)] = Buffer.from(JSON.stringify(next)).toString('base64');
      if (action === 'push-to-main') files[join(main, STATE)] = Buffer.from(JSON.stringify(nextParent)).toString('base64');
      const withinHome = (path: string) => !relative(home, path).startsWith('..') && !isAbsolute(relative(home, path));
      const ordered = Object.fromEntries(Object.entries(files).toSorted(([left], [right]) => Number(withinHome(left)) - Number(withinHome(right)) || Number(left === join(home, STATE)) - Number(right === join(home, STATE))));
      await this.publish(home, ordered, undoId);
      if (home === this.runningHome) await this.runtimeConfig?.reload();
      this.plans.delete(token);
      return { detail: await this.detail(home, main), applied: selected, undo_id: undoId };
    });
  }

  private async writeResource(home: string, resource: SpaceResource, files: Files, previous?: SpaceResource): Promise<void> {
    if (resource.blockedReason !== undefined) throw new Error(resource.blockedReason);
    if (previous?.blockedReason !== undefined) throw new Error('The destination resource requires its dedicated account flow');
    for (const [relative, data] of Object.entries(previous?.files ?? {})) if (resource.files[relative] === undefined) {
      files[join(home, '.space-resources/retained', hash(resource.id).slice(0, 16), relative)] = data;
      files[join(home, relative)] = null;
    }
    if (resource.id === 'resource:instructions:AGENTS.md' && readSpaceHome(home).space?.inherit.instructions === 'stack') {
      files[join(home, '.space-resources/instructions-fixed.md')] = resource.files['AGENTS.md'] ?? null;
      return;
    }
    if (resource.domain === 'mcp') {
      const path = join(home, 'mcp.json');
      const existing = files[path] === undefined ? await text(path) : Buffer.from(files[path]!, 'base64').toString();
      const data = existing === undefined ? {} : JSON.parse(existing);
      data.mcpServers ??= {}; data.mcpServers[resource.name] = resource.value;
      files[path] = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
    } else {
      for (const [relative, data] of Object.entries(resource.files)) files[join(home, relative)] = data;
      if (resource.domain === 'plugins') {
        const path = join(home, 'plugins/installed.json');
        const original = files[path] === undefined ? await text(path) : Buffer.from(files[path]!, 'base64').toString();
        const data = original === undefined ? { version: 1, plugins: [] } : JSON.parse(original);
        const existing = data.plugins.find((entry: { id: string }) => entry.id === resource.name);
        data.plugins = data.plugins.filter((entry: { id: string }) => entry.id !== resource.name);
        data.plugins.push({ id: resource.name, root: join(home, 'plugins/managed', resource.name), source: 'local', enabled: existing?.enabled ?? false, installedAt: new Date().toISOString(), capabilities: existing?.capabilities });
        files[path] = Buffer.from(JSON.stringify(data)).toString('base64');
      }
    }
  }

  private async deactivateResource(home: string, resource: SpaceResource, files: Files): Promise<void> {
    if (resource.blockedReason !== undefined) throw new Error(resource.blockedReason);
    for (const [relative, value] of Object.entries(resource.files)) {
      files[join(home, '.space-resources/retained', hash(resource.id).slice(0, 16), relative)] = value;
      const stackedMain = resource.id === 'resource:instructions:AGENTS.md' && readSpaceHome(home).space?.inherit.instructions === 'stack';
      files[join(home, stackedMain ? '.space-resources/instructions-fixed.md' : relative)] = null;
    }
    if (resource.domain === 'mcp') {
      const path = join(home, 'mcp.json');
      const original = files[path] === undefined ? await text(path) : Buffer.from(files[path]!, 'base64').toString();
      const data = original === undefined ? {} : JSON.parse(original);
      delete data.mcpServers?.[resource.name];
      files[path] = Buffer.from(JSON.stringify(data)).toString('base64');
    }
    if (resource.domain === 'plugins') {
      const path = join(home, 'plugins/installed.json');
      const original = files[path] === undefined ? await text(path) : Buffer.from(files[path]!, 'base64').toString();
      const data = original === undefined ? { version: 1, plugins: [] } : JSON.parse(original);
      data.plugins = data.plugins.filter((entry: { id: string }) => entry.id !== resource.name);
      files[path] = Buffer.from(JSON.stringify(data)).toString('base64');
    }
  }

  private async locked<T>(main: string, work: () => Promise<T>): Promise<T> {
    const lock = join(main, '.space-preferences-lock');
    try { await mkdir(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another space update is in progress; retry after it finishes', { cause: error }); throw error; }
    try { return await work(); } finally { await rm(lock, { recursive: true, force: true }); }
  }

  private async publish(home: string, files: Files, undoId: string): Promise<void> {
    const previous: Files = {};
    const staged: Record<string, string> = {};
    const published: string[] = [];
    const after: Record<string, string> = {};
    for (const path of Object.keys(files)) {
      const contents = await readFile(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      previous[path] = contents?.toString('base64') ?? null;
    }
    const undo: Undo = { id: undoId, files: Object.fromEntries(Object.entries(previous).map(([path, contents]) => [path, publicSnapshot(path, contents)])), after };
    const journal = join(home, '.space-preferences-transaction.json');
    try {
      for (const [path, contents] of Object.entries(files)) {
        if (contents === null) continue;
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.space-${undoId}`;
        await writeFile(temporary, Buffer.from(contents, 'base64'), { flag: 'wx', mode: 0o600 });
        staged[path] = temporary;
      }
      await writeFile(journal, JSON.stringify(undo), { flag: 'wx', mode: 0o600 });
      for (const [path, contents] of Object.entries(files)) {
        if (contents === null) await rm(path, { force: true }); else await rename(staged[path]!, path);
        published.push(path); after[path] = await fileHash(path);
      }
      await writeFile(join(home, '.space-preferences-undo.json'), JSON.stringify(undo), { mode: 0o600 });
      await rm(journal);
    } catch (error) {
      for (const path of published.toReversed()) {
        const contents = previous[path];
        if (contents === null) await rm(path, { force: true }); else await writeFile(path, Buffer.from(contents!, 'base64'), { mode: 0o600 });
      }
      await rm(journal, { force: true });
      throw error;
    } finally { for (const path of Object.values(staged)) await rm(path, { force: true }); }
  }

  async undo(home: string, main: string, undoId: string, allowPush: boolean): Promise<SpaceMutationResponse> {
    return this.locked(main, async () => {
      const value = await text(join(home, '.space-preferences-undo.json'));
      if (value === undefined) throw new Error('No recent change to undo');
      const undo = JSON.parse(value) as Undo;
      if (undo.id !== undoId || (await state(home)).undo_id !== undoId) throw new Error('Only the most recent change can be undone');
      for (const [path, revision] of Object.entries(undo.after)) {
        if (!allowedUndoPath(path, home, main)) throw new Error('Undo target is outside this space operation');
        if (!allowPush && (relative(home, path).startsWith('..') || isAbsolute(relative(home, path)))) throw new Error('Undoing main-space changes requires main-space management authority');
        if (await fileHash(path) !== revision) throw new Error('Settings changed after this operation; undo would overwrite a later change');
      }
      const restored: Files = {};
      for (const [path, contents] of Object.entries(undo.files)) {
        if (!allowedUndoPath(path, home, main)) throw new Error('Undo target is outside this space operation');
        restored[path] = await restorePublicSnapshot(path, contents);
      }
      await this.publish(home, restored, randomUUID());
      if (home === this.runningHome) await this.runtimeConfig?.reload();
      return { detail: await this.detail(home, main), applied: [] };
    });
  }

  async importPreferences(home: string, main: string, request: SpacePreferenceImport): Promise<SpacePreferenceImportResponse> {
    return this.locked(main, async () => {
      const current = await state(home);
      if (current.preferences !== undefined) {
        const detail = await this.detail(home, main);
        const deviceConflict = Object.entries(request.values).some(([key, value]) => !same(value, detail.preferences[key as keyof typeof detail.preferences]));
        return { detail, imported: false, device_conflict: deviceConflict };
      }
      current.preferences = spacePreferenceValuesSchema.partial().parse(request.values);
      current.imported_from = request.device_id;
      for (const key of Object.keys(DEFAULT_SPACE_PREFERENCES)) current.selections[`pref:${key}`] = { mode: 'fixed', reason: 'migrated' };
      await this.publish(home, { [join(home, STATE)]: Buffer.from(JSON.stringify(current)).toString('base64') }, randomUUID());
      return { detail: await this.detail(home, main), imported: true, device_conflict: false };
    });
  }

  async initializeCreated(home: string, main: string): Promise<void> {
    const current = await state(home);
    current.preferences = {};
    const source = inherit(home);
    for (const key of Object.keys(DEFAULT_SPACE_PREFERENCES)) {
      const domain = preferenceDomain(key);
      current.selections[`pref:${key}`] = { mode: source[domain] === false ? 'fixed' : 'follow' };
    }
    await writeFile(join(home, STATE), JSON.stringify(current), { flag: 'wx', mode: 0o600 });
    void main;
  }
}
function objectValue(value: unknown): Record<string, unknown> { return object(value) ? value : { value }; }
