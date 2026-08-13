import type { ModelCatalogItem, ProviderCatalogItem } from '@moonshot-ai/protocol';

import { LocalizedError, type I18nKey, type ValidationIssue } from '../i18n/locale';

/** Client-local preferences stored in localStorage (`kiki.settings`). */
export type SendShortcut = 'enter' | 'cmd-enter';

export interface DesktopSettings {
  defaultPermissionMode: 'manual' | 'auto' | 'yolo';
  defaultPlanMode: boolean;
  sendShortcut: SendShortcut;
  draftPersistence: boolean;
  defaultModel: string | undefined;
  defaultEffort: string | undefined;
  desktopNotifications: boolean;
  closeToTray: boolean;
}

export interface DesktopNativePrefs {
  notifications: boolean;
  closeToTray: boolean;
  /** UI locale mirrored to the native side (tray menu labels); frontend-owned. */
  locale?: string;
}

export interface RestartRequirement {
  required: boolean;
  changedAt: string | undefined;
  fields: string[];
}

export interface ServerConnection {
  url: string;
  token: string;
}

export type ProviderWireType =
  | 'kimi'
  | 'openai'
  | 'openai_responses'
  | 'anthropic'
  | 'google-genai'
  | 'vertexai';

export const PROVIDER_WIRE_TYPES: readonly ProviderWireType[] = [
  'kimi',
  'openai',
  'openai_responses',
  'anthropic',
  'google-genai',
  'vertexai',
];

export interface ProviderModelDraft {
  model: string;
  maxContextSize: number;
  displayName: string;
  capabilities: string[];
  supportEfforts: string[];
}

export interface ProviderDraft {
  id: string;
  type: ProviderWireType;
  baseUrl: string;
  defaultModel: string;
  apiKey: string;
  clearApiKey: boolean;
  models: ProviderModelDraft[];
}

const STORAGE_KEY = 'kiki.settings';
const LAST_SESSION_KEY = 'kiki.lastSessionId';
const DESKTOP_PREFS_KEY = 'kiki.desktopPrefs';
const RESTART_REQUIRED_KEY = 'kiki.restartRequired';

const DEFAULTS: DesktopSettings = {
  defaultPermissionMode: 'manual',
  defaultPlanMode: false,
  sendShortcut: 'enter',
  draftPersistence: true,
  defaultModel: undefined,
  defaultEffort: undefined,
  desktopNotifications: true,
  closeToTray: true,
};

const DESKTOP_PREFS_DEFAULTS: DesktopNativePrefs = {
  notifications: true,
  closeToTray: true,
};

function readObject(key: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function readSettings(): DesktopSettings {
  const stored = readObject(STORAGE_KEY) as Partial<DesktopSettings>;
  return {
    ...DEFAULTS,
    ...stored,
    defaultPermissionMode: isPermissionMode(stored.defaultPermissionMode)
      ? stored.defaultPermissionMode
      : DEFAULTS.defaultPermissionMode,
    defaultPlanMode:
      typeof stored.defaultPlanMode === 'boolean'
        ? stored.defaultPlanMode
        : DEFAULTS.defaultPlanMode,
    sendShortcut:
      stored.sendShortcut === 'enter' || stored.sendShortcut === 'cmd-enter'
        ? stored.sendShortcut
        : DEFAULTS.sendShortcut,
    draftPersistence:
      typeof stored.draftPersistence === 'boolean'
        ? stored.draftPersistence
        : DEFAULTS.draftPersistence,
    defaultModel: typeof stored.defaultModel === 'string' && stored.defaultModel !== ''
      ? stored.defaultModel
      : undefined,
    defaultEffort: typeof stored.defaultEffort === 'string' && stored.defaultEffort !== ''
      ? stored.defaultEffort
      : undefined,
    closeToTray:
      typeof stored.closeToTray === 'boolean' ? stored.closeToTray : DEFAULTS.closeToTray,
  };
}

// Local settings fan out through a tiny pub/sub so Composer / overlays react
// the moment Settings writes — a cached snapshot keeps useSyncExternalStore
// from looping on a fresh object per read. Cross-document writes arrive via
// the `storage` event (same-window setItem does not fire it).
const settingsListeners = new Set<() => void>();
let settingsSnapshotCache: DesktopSettings | undefined;
let storageListening = false;

function handleSettingsStorageEvent(event: StorageEvent): void {
  if (event.storageArea !== undefined && event.storageArea !== null) {
    try {
      if (event.storageArea !== localStorage) return;
    } catch {
      return;
    }
  }
  if (event.key !== null && event.key !== STORAGE_KEY) return;
  publishSettings(readSettings());
}

function attachSettingsStorageListener(): void {
  if (storageListening) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  window.addEventListener('storage', handleSettingsStorageEvent);
  storageListening = true;
}

function detachSettingsStorageListener(): void {
  if (!storageListening) return;
  if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
    window.removeEventListener('storage', handleSettingsStorageEvent);
  }
  storageListening = false;
}

export function subscribeSettings(listener: () => void): () => void {
  settingsListeners.add(listener);
  if (settingsListeners.size === 1) attachSettingsStorageListener();
  return () => {
    settingsListeners.delete(listener);
    if (settingsListeners.size === 0) detachSettingsStorageListener();
  };
}

export function settingsSnapshot(): DesktopSettings {
  settingsSnapshotCache ??= readSettings();
  return settingsSnapshotCache;
}

/** Stable SSR/server snapshot — never allocate a new object per read. */
export function settingsServerSnapshot(): DesktopSettings {
  return DEFAULTS;
}

function publishSettings(next: DesktopSettings): DesktopSettings {
  settingsSnapshotCache = next;
  for (const listener of settingsListeners) listener();
  return next;
}

export function writeSettings(patch: Partial<DesktopSettings>): void {
  const next = { ...readObject(STORAGE_KEY), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Browser storage is a convenience; server-backed settings remain authoritative.
  }
  publishSettings(readSettings());
}

export type ComposerModelSource = 'server-default' | 'local-default' | 'session' | 'override';

/** Local default is never an implicit session override — only an explicit pick or nav hand-off. */
function presentModel(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
}

export function resolveSessionModelOverride(explicitModel: string | undefined): string | undefined {
  return presentModel(explicitModel);
}

export function resolveEffectiveModel(
  override: string | undefined,
  sessionModel: string | undefined,
  inheritedDefault: string | undefined,
): string | undefined {
  return presentModel(override) ?? presentModel(sessionModel) ?? presentModel(inheritedDefault);
}

export function resolveModelSource(
  override: string | undefined,
  sessionModel: string | undefined,
  localDefault?: string,
  _serverDefault?: string,
): ComposerModelSource {
  if (presentModel(override) !== undefined) return 'override';
  if (presentModel(sessionModel) !== undefined) return 'session';
  if (presentModel(localDefault) !== undefined) return 'local-default';
  return 'server-default';
}

export interface ComposerKeyLike {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

/** True when the key event should send (or queue) according to the saved shortcut. */
export function isComposerSendKey(event: ComposerKeyLike, shortcut: SendShortcut): boolean {
  if (event.key !== 'Enter' || event.shiftKey) return false;
  const modified = event.metaKey || event.ctrlKey;
  return shortcut === 'cmd-enter' ? modified : !modified;
}

export function readLastSessionId(): string | undefined {
  try {
    return localStorage.getItem(LAST_SESSION_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeLastSessionId(sessionId: string | undefined): void {
  try {
    if (sessionId === undefined) localStorage.removeItem(LAST_SESSION_KEY);
    else localStorage.setItem(LAST_SESSION_KEY, sessionId);
  } catch {
    // ignore
  }
}

export function readDesktopPrefs(): DesktopNativePrefs {
  const stored = readObject(DESKTOP_PREFS_KEY) as Partial<DesktopNativePrefs>;
  return {
    notifications:
      typeof stored.notifications === 'boolean'
        ? stored.notifications
        : DESKTOP_PREFS_DEFAULTS.notifications,
    closeToTray:
      typeof stored.closeToTray === 'boolean'
        ? stored.closeToTray
        : DESKTOP_PREFS_DEFAULTS.closeToTray,
  };
}

export function writeDesktopPrefs(prefs: Partial<DesktopNativePrefs>): void {
  const next = { ...readDesktopPrefs(), ...prefs };
  try {
    localStorage.setItem(DESKTOP_PREFS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

export function readRestartRequirement(): RestartRequirement {
  const stored = readObject(RESTART_REQUIRED_KEY);
  const fields = Array.isArray(stored['fields'])
    ? stored['fields'].filter((field): field is string => typeof field === 'string')
    : [];
  return {
    required: stored['required'] === true,
    changedAt: typeof stored['changedAt'] === 'string' ? stored['changedAt'] : undefined,
    fields,
  };
}

// The restart requirement is app-global chrome (a banner outside the settings
// tree renders it), so mutations fan out through a tiny pub/sub; the snapshot
// cache keeps `useSyncExternalStore` happy (a fresh object per read would loop).
const restartListeners = new Set<() => void>();
let restartSnapshotCache: RestartRequirement | undefined;

export function subscribeRestartRequirement(listener: () => void): () => void {
  restartListeners.add(listener);
  return () => { restartListeners.delete(listener); };
}

export function restartRequirementSnapshot(): RestartRequirement {
  restartSnapshotCache ??= readRestartRequirement();
  return restartSnapshotCache;
}

function publishRestartRequirement(next: RestartRequirement): RestartRequirement {
  restartSnapshotCache = next;
  for (const listener of restartListeners) listener();
  return next;
}

export function markRestartRequired(fields: readonly string[]): RestartRequirement {
  const current = readRestartRequirement();
  const next: RestartRequirement = {
    required: true,
    changedAt: new Date().toISOString(),
    fields: [...new Set([...current.fields, ...fields])],
  };
  try {
    localStorage.setItem(RESTART_REQUIRED_KEY, JSON.stringify(next));
  } catch {
    // The UI still keeps the returned in-memory state for this visit.
  }
  return publishRestartRequirement(next);
}

export function clearRestartRequirement(): RestartRequirement {
  const next: RestartRequirement = { required: false, changedAt: undefined, fields: [] };
  try {
    localStorage.removeItem(RESTART_REQUIRED_KEY);
  } catch {
    // ignore
  }
  return publishRestartRequirement(next);
}

export function validateServerDefaults(permissionMode: string): ValidationIssue | null {
  return isPermissionMode(permissionMode) ? null : { key: 'val.permissionMode' };
}

export function validateExtraSkillDirs(value: string): ValidationIssue | null {
  const entries = value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (entries.some((entry) => entry.includes('\0'))) return { key: 'val.skillDirsNul' };
  return null;
}

export function parseExperimentalFlags(value: string): Record<string, boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new LocalizedError({ key: 'val.flagsJson' });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LocalizedError({ key: 'val.flagsObject' });
  }
  const flags: Record<string, boolean> = {};
  for (const [name, enabled] of Object.entries(parsed)) {
    if (name.trim() === '') throw new LocalizedError({ key: 'val.flagNameEmpty' });
    if (typeof enabled !== 'boolean') {
      throw new LocalizedError({ key: 'val.flagBool', params: { name } });
    }
    flags[name] = enabled;
  }
  return flags;
}

export interface AdvancedServerConfigPatch {
  permission?: unknown;
  hooks?: unknown[];
  services?: unknown;
  loop_control?: unknown;
  background?: unknown;
}

export function parseAdvancedServerConfig(value: string): AdvancedServerConfigPatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new LocalizedError({ key: 'val.advancedJson' });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LocalizedError({ key: 'val.advancedObject' });
  }
  const source = parsed as Record<string, unknown>;
  const allowed = new Set(['permission', 'hooks', 'services', 'loop_control', 'background']);
  const unknownKeys = Object.keys(source).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new LocalizedError({ key: 'val.advancedUnknown', params: { fields: unknownKeys.join(', ') } });
  }
  if (source['hooks'] !== undefined && !Array.isArray(source['hooks'])) {
    throw new LocalizedError({ key: 'val.advancedHooks' });
  }
  if (Object.keys(source).length === 0) {
    throw new LocalizedError({ key: 'val.advancedEmpty' });
  }
  return {
    permission: source['permission'],
    hooks: source['hooks'] as unknown[] | undefined,
    services: source['services'],
    loop_control: source['loop_control'],
    background: source['background'],
  };
}

export function validateDesktopConfigDraft(input: {
  subagentDefaultModel: string;
  subagentDefaultEffort: string;
  subagentTimeoutMs: number;
  defaultSubagentModel: string;
  defaultSubagentReasoningEffort: string;
  modelCatalogRefreshIntervalMs: number;
}): ValidationIssue | null {
  for (const [key, value] of [
    ['val.spacesSubagentModel', input.subagentDefaultModel],
    ['val.spacesSubagentEffort', input.subagentDefaultEffort],
    ['val.spacesCollabModel', input.defaultSubagentModel],
    ['val.spacesCollabEffort', input.defaultSubagentReasoningEffort],
  ] as const) {
    if (value !== value.trim()) return { key };
  }
  if (!Number.isInteger(input.subagentTimeoutMs) || input.subagentTimeoutMs < 0) {
    return { key: 'val.timeoutWhole' };
  }
  if (input.subagentTimeoutMs > 86_400_000) {
    return { key: 'val.timeoutMax' };
  }
  if (
    !Number.isInteger(input.modelCatalogRefreshIntervalMs) ||
    input.modelCatalogRefreshIntervalMs < 0
  ) {
    return { key: 'val.catalogIntervalWhole' };
  }
  return null;
}

export function providerDraftFromCatalog(
  provider: ProviderCatalogItem,
  models: readonly ModelCatalogItem[],
): ProviderDraft | null {
  if (!isProviderWireType(provider.type)) return null;
  const providerModels = models
    .filter((model) => model.provider === provider.id)
    .map((model) => ({
      model: model.model.startsWith(`${provider.id}/`)
        ? model.model.slice(provider.id.length + 1)
        : model.model,
      maxContextSize: model.max_context_size,
      displayName: model.display_name ?? '',
      capabilities: model.capabilities ?? [],
      supportEfforts: model.support_efforts ?? [],
    }));
  if (providerModels.length === 0) return null;
  const defaultModel = provider.default_model?.startsWith(`${provider.id}/`)
    ? provider.default_model.slice(provider.id.length + 1)
    : (provider.default_model ?? providerModels[0]!.model);
  return {
    id: provider.id,
    type: provider.type,
    baseUrl: provider.base_url ?? '',
    defaultModel,
    apiKey: '',
    clearApiKey: false,
    models: providerModels,
  };
}

export function validateProviderDraft(draft: ProviderDraft): ValidationIssue | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(draft.id)) {
    return { key: 'val.providerId' };
  }
  if (!isProviderWireType(draft.type)) return { key: 'val.providerProtocol' };
  if (draft.baseUrl !== '') {
    let url: URL;
    try {
      url = new URL(draft.baseUrl);
    } catch {
      return { key: 'val.baseUrlAbsolute' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { key: 'val.baseUrlHttp' };
    }
    if (draft.baseUrl.includes('${')) {
      return { key: 'val.baseUrlEnv' };
    }
  }
  if (draft.apiKey.includes('\n') || draft.apiKey.includes('\r')) {
    return { key: 'val.apiKeyLineBreaks' };
  }
  if (draft.models.length === 0) return { key: 'val.modelsEmpty' };
  const seen = new Set<string>();
  for (const model of draft.models) {
    if (model.model.trim() === '') return { key: 'val.modelIdEmpty' };
    if (!Number.isInteger(model.maxContextSize) || model.maxContextSize < 1) {
      return { key: 'val.modelContextSize', params: { model: model.model || '(unnamed)' } };
    }
    if (seen.has(model.model)) return { key: 'val.modelDuplicate', params: { model: model.model } };
    seen.add(model.model);
  }
  if (!seen.has(draft.defaultModel)) return { key: 'val.defaultModelInModels' };
  return null;
}

// ---- provider templates, chip editing, dirty tracking ----

export interface ProviderTemplate {
  readonly type: ProviderWireType;
  /** Brand label — wire values stay English in both locales. */
  readonly label: string;
  readonly baseUrl: string;
  readonly defaultContextSize: number;
}

/** First-wizard-step cards; `providerTemplateFor` covers the other wire types. */
export const PROVIDER_TEMPLATES: readonly ProviderTemplate[] = [
  { type: 'kimi', label: 'Kimi', baseUrl: 'https://api.moonshot.ai/v1', defaultContextSize: 131072 },
  { type: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', defaultContextSize: 128000 },
  { type: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', defaultContextSize: 200000 },
];

export function providerTemplateFor(type: ProviderWireType): ProviderTemplate {
  return PROVIDER_TEMPLATES.find((template) => template.type === type) ?? {
    type,
    label: type,
    baseUrl: '',
    defaultContextSize: 128000,
  };
}

/** Known enum chips; the chip editor also accepts free-form custom values. */
export const KNOWN_CAPABILITIES = ['chat', 'reasoning', 'vision', 'tools'] as const;
export const KNOWN_EFFORTS = ['low', 'medium', 'high', 'max'] as const;

/** Trim, drop empties, dedupe — the chip editor's canonical output. */
export function normalizeTags(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Deep field equality for "unsaved changes" badges and leave-section guards. */
export function providerDraftsEqual(a: ProviderDraft, b: ProviderDraft): boolean {
  if (a.id !== b.id || a.type !== b.type || a.baseUrl !== b.baseUrl) return false;
  if (a.defaultModel !== b.defaultModel || a.apiKey !== b.apiKey) return false;
  if (a.clearApiKey !== b.clearApiKey) return false;
  if (a.models.length !== b.models.length) return false;
  return a.models.every((model, index) => {
    const other = b.models[index];
    return other !== undefined
      && model.model === other.model
      && model.maxContextSize === other.maxContextSize
      && model.displayName === other.displayName
      && stringArraysEqual(model.capabilities, other.capabilities)
      && stringArraysEqual(model.supportEfforts, other.supportEfforts);
  });
}

export function isProviderDraftDirty(draft: ProviderDraft, initial: ProviderDraft): boolean {
  return !providerDraftsEqual(draft, initial);
}

// ---- remote /models probe ("test connection and pull models") ----

export interface RemoteModelsProbe {
  readonly type: ProviderWireType;
  readonly baseUrl: string;
  readonly apiKey: string;
}

/** Every supported wire family lists models at `{baseUrl}/models`. */
export function remoteModelsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/models`;
}

export function remoteModelsHeaders(type: ProviderWireType, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const key = apiKey.trim();
  if (type === 'anthropic') {
    if (key !== '') headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (key !== '') {
    headers['Authorization'] = `Bearer ${key}`;
  }
  return headers;
}

function idFromEntry(entry: unknown, keys: readonly string[]): string {
  if (typeof entry === 'string') return entry;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return '';
  const record = entry as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

/**
 * Parse a `/models` reply across the wire families into a clean id list:
 * openai-style `{data: [{id}]}`, anthropic `{data: [{id, display_name}]}`,
 * google-genai `{models: [{name: 'models/<id>'}]}` (prefix stripped).
 */
export function parseRemoteModels(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new LocalizedError({ key: 'val.remoteModelsShape' });
  }
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record['data'])) {
    return normalizeTags(record['data'].map((entry) => idFromEntry(entry, ['id', 'name'])));
  }
  if (Array.isArray(record['models'])) {
    return normalizeTags(
      record['models'].map((entry) => {
        const raw = idFromEntry(entry, ['name', 'id']);
        return raw.startsWith('models/') ? raw.slice('models/'.length) : raw;
      }),
    );
  }
  throw new LocalizedError({ key: 'val.remoteModelsShape' });
}

/**
 * Probe the provider's `/models` with the draft's baseUrl + key. Filled
 * context sizes fall back to the protocol default; display names and
 * capabilities stay blank for the user to refine. Throws LocalizedError for
 * client-side problems, a plain Error with the HTTP status upstream ones.
 */
export async function fetchRemoteModels(probe: RemoteModelsProbe): Promise<ProviderModelDraft[]> {
  const baseUrl = probe.baseUrl.trim();
  if (baseUrl === '') throw new LocalizedError({ key: 'val.baseUrlRequired' });
  let url: URL;
  try {
    url = new URL(remoteModelsUrl(baseUrl));
  } catch {
    throw new LocalizedError({ key: 'val.baseUrlAbsolute' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LocalizedError({ key: 'val.baseUrlHttp' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(); }, 15_000);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: remoteModelsHeaders(probe.type, probe.apiKey),
      signal: controller.signal,
    });
  } catch (error) {
    throw error instanceof Error && error.name === 'AbortError'
      ? new Error('Model probe timed out after 15000ms')
      : error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const detail = (await response.text()).replaceAll(/\s+/g, ' ').trim().slice(0, 200);
    throw new Error(`HTTP ${response.status}${detail === '' ? '' : ` — ${detail}`}`);
  }
  const payload = (await response.json()) as unknown;
  const ids = parseRemoteModels(payload);
  if (ids.length === 0) throw new LocalizedError({ key: 'val.remoteModelsEmpty' });
  const contextSize = providerTemplateFor(probe.type).defaultContextSize;
  return ids.map((id) => ({
    model: id,
    maxContextSize: contextSize,
    displayName: '',
    capabilities: [],
    supportEfforts: [],
  }));
}

// ---- settings search index ----

export interface SettingsSearchSpecEntry {
  readonly section: string;
  /** DOM id the SectionCard renders so a result can scroll + flash it. */
  readonly cardId: string;
  readonly titleKey: I18nKey;
  readonly keywordKeys: readonly I18nKey[];
}

export const SETTINGS_SEARCH_SPEC: readonly SettingsSearchSpecEntry[] = [
  { section: 'general', cardId: 'st-card-language', titleKey: 'st.language.title', keywordKeys: ['st.language.hint'] },
  { section: 'general', cardId: 'st-card-defaults', titleKey: 'st.defaults.title', keywordKeys: ['st.defaults.permissionMode', 'st.defaults.planMode', 'st.defaults.hint'] },
  { section: 'general', cardId: 'st-card-composer', titleKey: 'st.composer.title', keywordKeys: ['st.composer.sendShortcut', 'st.composer.persistDrafts'] },
  { section: 'general', cardId: 'st-card-desktop', titleKey: 'st.desktop.title', keywordKeys: ['st.desktop.notifications', 'st.desktop.tray', 'st.desktop.quit'] },
  { section: 'models', cardId: 'st-card-models', titleKey: 'st.models.defaultTitle', keywordKeys: ['st.models.providerLabel', 'st.models.searchPlaceholder'] },
  { section: 'models', cardId: 'st-card-thinking', titleKey: 'st.thinking.title', keywordKeys: ['st.thinking.enable', 'st.thinking.hint'] },
  { section: 'connection', cardId: 'st-card-conn-server', titleKey: 'st.conn.connectedTitle', keywordKeys: ['st.conn.version', 'st.conn.reconnect'] },
  { section: 'connection', cardId: 'st-card-conn-owned', titleKey: 'st.conn.ownedTitle', keywordKeys: ['st.conn.ownedBody', 'st.conn.restart'] },
  { section: 'providers', cardId: 'st-card-auth', titleKey: 'st.auth.title', keywordKeys: ['st.auth.signIn', 'st.auth.signOut'] },
  { section: 'providers', cardId: 'st-card-providers', titleKey: 'st.providers.title', keywordKeys: ['st.providers.empty'] },
  { section: 'providers', cardId: 'st-card-providers-add', titleKey: 'st.providers.addTitle', keywordKeys: ['st.wizard.chooseTemplate', 'st.fetchModels.button'] },
  { section: 'capabilities', cardId: 'st-card-caps', titleKey: 'st.caps.title', keywordKeys: ['st.caps.mergeSkills', 'st.caps.telemetry', 'st.caps.extraDirs', 'st.caps.experimental'] },
  { section: 'capabilities', cardId: 'st-card-advanced', titleKey: 'st.advanced.title', keywordKeys: ['st.advanced.hint'] },
  { section: 'agents', cardId: 'st-card-sidecar', titleKey: 'st.sidecar.title', keywordKeys: ['st.sidecar.hint', 'st.sidecar.subagentModel', 'st.sidecar.enableCollab', 'st.agents.webHint'] },
  { section: 'capabilities', cardId: 'st-card-tools', titleKey: 'st.tools.title', keywordKeys: [] },
  { section: 'capabilities', cardId: 'st-card-mcp', titleKey: 'st.mcp.title', keywordKeys: ['st.mcp.restart'] },
  { section: 'capabilities', cardId: 'st-card-skills', titleKey: 'st.skills.title', keywordKeys: ['st.skills.workspace'] },
  { section: 'workspaces', cardId: 'st-card-workspaces', titleKey: 'st.workspaces.title', keywordKeys: ['st.workspaces.hint'] },
  { section: 'about', cardId: 'st-card-about', titleKey: 'st.about.title', keywordKeys: ['st.about.serverVersion', 'st.about.serverId'] },
];

export interface SettingsSearchEntry {
  readonly section: string;
  readonly cardId: string;
  readonly sectionLabel: string;
  readonly title: string;
  readonly haystack: string;
}

export function buildSettingsSearchIndex(
  sectionLabels: Readonly<Record<string, string>>,
  t: (key: I18nKey) => string,
): SettingsSearchEntry[] {
  return SETTINGS_SEARCH_SPEC.map((entry) => {
    const title = t(entry.titleKey);
    return {
      section: entry.section,
      cardId: entry.cardId,
      sectionLabel: sectionLabels[entry.section] ?? entry.section,
      title,
      haystack: [title, ...entry.keywordKeys.map((key) => t(key))].join('\n').toLowerCase(),
    };
  });
}

export function searchSettings(
  entries: readonly SettingsSearchEntry[],
  query: string,
): SettingsSearchEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  return entries.filter((entry) =>
    entry.title.toLowerCase().includes(needle)
    || entry.sectionLabel.toLowerCase().includes(needle)
    || entry.haystack.includes(needle));
}

// ---- millisecond humanizing (unit-ed inputs) ----

export type MsUnit = 'ms' | 'seconds' | 'minutes' | 'hours';

export interface HumanizedMs {
  readonly value: number;
  readonly unit: MsUnit;
}

function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 7_200_000 → {value: 2, unit: 'hours'}; 90_000 → {value: 1.5, unit: 'minutes'}. */
export function humanizeMs(ms: number): HumanizedMs {
  if (!Number.isFinite(ms) || ms < 1000) return { value: Math.max(0, Math.round(ms)), unit: 'ms' };
  const seconds = ms / 1000;
  if (seconds < 60) return { value: roundTwo(seconds), unit: 'seconds' };
  const minutes = seconds / 60;
  if (minutes < 60) return { value: roundTwo(minutes), unit: 'minutes' };
  return { value: roundTwo(minutes / 60), unit: 'hours' };
}

export const MS_UNIT_FACTORS: Readonly<Record<MsUnit, number>> = {
  ms: 1,
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
};

/** Largest unit whose converted value stays a whole number (unit select default). */
export function msUnitFor(ms: number): MsUnit {
  for (const unit of ['hours', 'minutes', 'seconds'] as const) {
    if (ms >= MS_UNIT_FACTORS[unit] && ms % MS_UNIT_FACTORS[unit] === 0) return unit;
  }
  return 'ms';
}

export async function createProvider(
  connection: ServerConnection,
  draft: ProviderDraft,
): Promise<ProviderCatalogItem> {
  const validation = validateProviderDraft(draft);
  if (validation !== null) throw new LocalizedError(validation);
  return serverRequest<ProviderCatalogItem>(connection, 'POST', '/providers', providerBody(draft, true));
}

export async function replaceProvider(
  connection: ServerConnection,
  currentId: string,
  draft: ProviderDraft,
): Promise<ProviderCatalogItem> {
  const validation = validateProviderDraft(draft);
  if (validation !== null) throw new LocalizedError(validation);
  const result = await serverRequest<{ provider: ProviderCatalogItem }>(
    connection,
    'PUT',
    `/providers/${encodeURIComponent(currentId)}`,
    {
      ...providerBody(draft, false),
      new_id: draft.id === currentId ? undefined : draft.id,
    },
  );
  return result.provider;
}

export async function deleteProvider(
  connection: ServerConnection,
  providerId: string,
): Promise<void> {
  await serverRequest<void>(connection, 'DELETE', `/providers/${encodeURIComponent(providerId)}`);
}

function providerBody(draft: ProviderDraft, includeId: boolean): Record<string, unknown> {
  const apiKey = draft.clearApiKey ? '' : draft.apiKey || undefined;
  return {
    id: includeId ? draft.id : undefined,
    type: draft.type,
    api_key: apiKey,
    base_url: draft.baseUrl || undefined,
    default_model: draft.defaultModel,
    models: draft.models.map((model) => ({
      model: model.model,
      max_context_size: model.maxContextSize,
      display_name: model.displayName || undefined,
      capabilities: model.capabilities.length > 0 ? model.capabilities : undefined,
      support_efforts: model.supportEfforts.length > 0 ? model.supportEfforts : undefined,
    })),
  };
}

async function serverRequest<T>(
  connection: ServerConnection,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const base = connection.url.trim().replace(/\/+$/, '');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (connection.token.trim() !== '') headers['Authorization'] = `Bearer ${connection.token.trim()}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const envelope = (await response.json()) as {
    code: number;
    msg: string;
    data: T;
    request_id?: string;
  };
  if (envelope.code !== 0) throw new Error(`${envelope.msg} (code ${envelope.code})`);
  return envelope.data;
}

function isPermissionMode(value: unknown): value is DesktopSettings['defaultPermissionMode'] {
  return value === 'manual' || value === 'auto' || value === 'yolo';
}

function isProviderWireType(value: string): value is ProviderWireType {
  return PROVIDER_WIRE_TYPES.some((candidate) => candidate === value);
}
