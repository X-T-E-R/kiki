import type { ModelCatalogItem, ProviderCatalogItem } from '@moonshot-ai/protocol';

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
    closeToTray:
      typeof stored.closeToTray === 'boolean' ? stored.closeToTray : DEFAULTS.closeToTray,
  };
}

export function writeSettings(patch: Partial<DesktopSettings>): void {
  const next = { ...readObject(STORAGE_KEY), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Browser storage is a convenience; server-backed settings remain authoritative.
  }
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
  return next;
}

export function clearRestartRequirement(): RestartRequirement {
  const next: RestartRequirement = { required: false, changedAt: undefined, fields: [] };
  try {
    localStorage.removeItem(RESTART_REQUIRED_KEY);
  } catch {
    // ignore
  }
  return next;
}

export function validateServerDefaults(permissionMode: string): string | null {
  return isPermissionMode(permissionMode)
    ? null
    : 'Permission mode must be manual, auto, or yolo.';
}

export function validateExtraSkillDirs(value: string): string | null {
  const entries = value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (entries.some((entry) => entry.includes('\0'))) return 'Skill directories cannot contain NUL bytes.';
  return null;
}

export function parseExperimentalFlags(value: string): Record<string, boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Experimental flags must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Experimental flags must be a JSON object.');
  }
  const flags: Record<string, boolean> = {};
  for (const [name, enabled] of Object.entries(parsed)) {
    if (name.trim() === '') throw new Error('Experimental flag names cannot be empty.');
    if (typeof enabled !== 'boolean') {
      throw new TypeError(`Experimental flag "${name}" must be true or false.`);
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
    throw new Error('Advanced server config must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('Advanced server config must be a JSON object.');
  }
  const source = parsed as Record<string, unknown>;
  const allowed = new Set(['permission', 'hooks', 'services', 'loop_control', 'background']);
  const unknownKeys = Object.keys(source).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Unsupported advanced config field: ${unknownKeys.join(', ')}.`);
  }
  if (source['hooks'] !== undefined && !Array.isArray(source['hooks'])) {
    throw new TypeError('Advanced config hooks must be a JSON array.');
  }
  if (Object.keys(source).length === 0) {
    throw new Error('Add at least one advanced config field before saving.');
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
}): string | null {
  for (const [label, value] of [
    ['Subagent model', input.subagentDefaultModel],
    ['Subagent effort', input.subagentDefaultEffort],
    ['Collaboration model', input.defaultSubagentModel],
    ['Collaboration effort', input.defaultSubagentReasoningEffort],
  ] as const) {
    if (value !== value.trim()) return `${label} cannot start or end with spaces.`;
  }
  if (!Number.isInteger(input.subagentTimeoutMs) || input.subagentTimeoutMs < 0) {
    return 'Subagent timeout must be a non-negative whole number of milliseconds.';
  }
  if (input.subagentTimeoutMs > 86_400_000) {
    return 'Subagent timeout cannot exceed 24 hours (86,400,000 ms).';
  }
  if (
    !Number.isInteger(input.modelCatalogRefreshIntervalMs) ||
    input.modelCatalogRefreshIntervalMs < 0
  ) {
    return 'Catalog refresh interval must be a non-negative whole number of milliseconds.';
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

export function validateProviderDraft(draft: ProviderDraft): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(draft.id)) {
    return 'Provider ID must start with a letter or digit and use only letters, digits, spaces, - or _.';
  }
  if (!isProviderWireType(draft.type)) return 'Choose a supported provider protocol.';
  if (draft.baseUrl !== '') {
    let url: URL;
    try {
      url = new URL(draft.baseUrl);
    } catch {
      return 'Base URL must be a valid absolute URL.';
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'Base URL must use http or https.';
    }
    if (draft.baseUrl.includes('${')) {
      return 'Base URL cannot contain an environment-variable placeholder.';
    }
  }
  if (draft.apiKey.includes('\n') || draft.apiKey.includes('\r')) {
    return 'API keys cannot contain line breaks.';
  }
  if (draft.models.length === 0) return 'Add at least one model.';
  const seen = new Set<string>();
  for (const model of draft.models) {
    if (model.model.trim() === '') return 'Model IDs cannot be empty.';
    if (!Number.isInteger(model.maxContextSize) || model.maxContextSize < 1) {
      return `Model ${model.model || '(unnamed)'} needs a positive whole context size.`;
    }
    if (seen.has(model.model)) return `Duplicate model: ${model.model}.`;
    seen.add(model.model);
  }
  if (!seen.has(draft.defaultModel)) return 'Default model must be one of the provider models.';
  return null;
}

export async function createProvider(
  connection: ServerConnection,
  draft: ProviderDraft,
): Promise<ProviderCatalogItem> {
  const validation = validateProviderDraft(draft);
  if (validation !== null) throw new Error(validation);
  return serverRequest<ProviderCatalogItem>(connection, 'POST', '/providers', providerBody(draft, true));
}

export async function replaceProvider(
  connection: ServerConnection,
  currentId: string,
  draft: ProviderDraft,
): Promise<ProviderCatalogItem> {
  const validation = validateProviderDraft(draft);
  if (validation !== null) throw new Error(validation);
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
