import {
  requestIdentityPolicySchema,
  type ModelCatalogItem,
  type PatchConfigRequest,
  type ProviderCatalogItem,
  type RequestIdentityPolicyWire,
} from '@moonshot-ai/protocol';

import { LocalizedError, type I18nKey, type ValidationIssue } from '../i18n/locale';
import type { KikiConfigPatch, KikiConfigResponse } from './client';

/** Client-local preferences stored in localStorage (`kiki.settings`). */
export type SendShortcut = 'enter' | 'cmd-enter';

/** `system` follows the OS; the other two pin the palette regardless. */
export type ThemePreference = 'light' | 'dark' | 'system';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

export interface DesktopSettings {
  defaultPermissionMode: 'manual' | 'auto' | 'yolo';
  defaultPlanMode: boolean;
  sendShortcut: SendShortcut;
  draftPersistence: boolean;
  defaultModel: string | undefined;
  defaultEffort: string | undefined;
  closeToTray: boolean;
  theme: ThemePreference;
}

export type UpdateChannel = 'stable' | 'beta';

export interface DesktopNativePrefs {
  notifications: boolean;
  closeToTray: boolean;
  /** UI locale mirrored to the native side (tray menu labels); frontend-owned. */
  locale?: string;
  updateChannel: UpdateChannel;
  compatibility: CompatibilitySettings;
}

export type CompatibilityHomeKind = 'kimi' | 'custom';

export interface CompatibilitySettings {
  homeKind: CompatibilityHomeKind;
  customHome?: string;
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

export interface ServerFileSettings {
  subagent: {
    timeoutMs: number;
  };
  agents: {
    enabled: boolean;
  };
  builtinProductSkills: boolean;
  modelCatalog: {
    refreshIntervalMs: number;
    refreshOnStart: boolean;
  };
}

export function configObjectOrEmpty(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : {};
}

/** Canonicalize config list projections without ever iterating a bare string. */
export function normalizeConfigStringList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return [];
  return [...new Set(value)];
}

export function serverFileSettingsFromConfig(config: unknown): ServerFileSettings {
  const source = configObjectOrEmpty(config);
  const subagent = configObjectOrEmpty(source['subagent']);
  const agents = configObjectOrEmpty(source['agents']);
  const modelCatalog = configObjectOrEmpty(source['model_catalog']);
  return {
    subagent: {
      timeoutMs: typeof subagent['timeoutMs'] === 'number' ? subagent['timeoutMs'] : 7_200_000,
    },
    agents: {
      enabled: agents['enabled'] !== false,
    },
    builtinProductSkills: source['builtin_product_skills'] !== false,
    modelCatalog: {
      refreshIntervalMs:
        typeof modelCatalog['refreshIntervalMs'] === 'number'
          ? modelCatalog['refreshIntervalMs']
          : 0,
      refreshOnStart: modelCatalog['refreshOnStart'] === true,
    },
  };
}

export function serverFileSettingsPatch(
  settings: ServerFileSettings,
  baseline?: ServerFileSettings,
): PatchConfigRequest {
  const subagent = {
    timeout_ms:
      baseline === undefined || settings.subagent.timeoutMs !== baseline.subagent.timeoutMs
        ? settings.subagent.timeoutMs
        : undefined,
  };
  const agents = {
    enabled:
      baseline === undefined || settings.agents.enabled !== baseline.agents.enabled
        ? settings.agents.enabled
        : undefined,
  };
  const modelCatalog = {
    refresh_interval_ms:
      baseline === undefined
      || settings.modelCatalog.refreshIntervalMs !== baseline.modelCatalog.refreshIntervalMs
        ? settings.modelCatalog.refreshIntervalMs
        : undefined,
    refresh_on_start:
      baseline === undefined
      || settings.modelCatalog.refreshOnStart !== baseline.modelCatalog.refreshOnStart
        ? settings.modelCatalog.refreshOnStart
        : undefined,
  };
  return {
    subagent: Object.values(subagent).some((value) => value !== undefined) ? subagent : undefined,
    agents: Object.values(agents).some((value) => value !== undefined) ? agents : undefined,
    builtin_product_skills:
      baseline === undefined || settings.builtinProductSkills !== baseline.builtinProductSkills
        ? settings.builtinProductSkills
        : undefined,
    model_catalog:
      Object.values(modelCatalog).some((value) => value !== undefined) ? modelCatalog : undefined,
  };
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

export type RequestIdentityPreset = NonNullable<RequestIdentityPolicyWire['preset']>;

export type RequestIdentityChoice =
  | 'inherit'
  | 'custom_overrides'
  | RequestIdentityPreset;

export const REQUEST_IDENTITY_CHOICES: readonly RequestIdentityChoice[] = [
  'inherit',
  'custom_overrides',
  'codex_compatible',
  'grok_build_compatible',
  'kimi_code',
  'none',
];

export interface RequestIdentityLayerDraft {
  requestIdentityChoice: RequestIdentityChoice;
  requestIdentityOverridesJson: string;
}

export interface ProviderModelDraft extends RequestIdentityLayerDraft {
  model: string;
  maxContextSize: number;
  displayName: string;
  capabilities: string[];
  supportEfforts: string[];
}

export interface ProviderDraft extends RequestIdentityLayerDraft {
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
  closeToTray: true,
  theme: 'system',
};

const DESKTOP_PREFS_DEFAULTS: DesktopNativePrefs = {
  notifications: true,
  closeToTray: true,
  updateChannel: import.meta.env['VITE_UPDATE_CHANNEL'] === 'beta' ? 'beta' : 'stable',
  compatibility: {
    homeKind: 'kimi',
    customHome: undefined,
  },
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
    theme: isThemePreference(stored.theme) ? stored.theme : DEFAULTS.theme,
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
  serverDefault?: string,
): ComposerModelSource {
  if (presentModel(override) !== undefined) return 'override';
  if (presentModel(sessionModel) !== undefined) return 'session';
  // Server default outranks the local mirror (which is itself an echo of the
  // server field); the local value only shows when the server has none.
  if (presentModel(serverDefault) !== undefined) return 'server-default';
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
  const compatibility = stored.compatibility;
  const homeKind = compatibility?.homeKind;
  return {
    notifications:
      typeof stored.notifications === 'boolean'
        ? stored.notifications
        : DESKTOP_PREFS_DEFAULTS.notifications,
    closeToTray:
      typeof stored.closeToTray === 'boolean'
        ? stored.closeToTray
        : DESKTOP_PREFS_DEFAULTS.closeToTray,
    updateChannel:
      stored.updateChannel === 'stable' || stored.updateChannel === 'beta'
        ? stored.updateChannel
        : DESKTOP_PREFS_DEFAULTS.updateChannel,
    compatibility: {
      homeKind: homeKind === 'kimi' || homeKind === 'custom'
        ? homeKind
        : DESKTOP_PREFS_DEFAULTS.compatibility.homeKind,
      customHome:
        typeof compatibility?.customHome === 'string' && compatibility.customHome.trim() !== ''
          ? compatibility.customHome
          : undefined,
    },
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

// Browser users get a session-scoped acknowledgement instead of the permanent
// clear: hiding the reminder must not erase the pending requirement, which a
// later desktop restart (or reload) still needs to see. Memory-only, so a
// fresh app run shows the banner again until a real restart lands.
let restartAcknowledgedAt: string | undefined;

export function acknowledgeRestartRequirement(): void {
  restartAcknowledgedAt = restartRequirementSnapshot().changedAt;
  for (const listener of restartListeners) listener();
}

/** True when this app run already acknowledged the requirement's latest change. */
export function isRestartRequirementAcknowledged(requirement: RestartRequirement): boolean {
  return requirement.changedAt !== undefined && restartAcknowledgedAt === requirement.changedAt;
}

export function validateServerDefaults(permissionMode: string): ValidationIssue | null {
  return isPermissionMode(permissionMode) ? null : { key: 'val.permissionMode' };
}

export function validateExtraSkillDirs(value: string): ValidationIssue | null {
  const entries = value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (entries.some((entry) => entry.includes('\0'))) return { key: 'val.skillDirsNul' };
  return null;
}

/** Append native directory selections to the newline-delimited draft, deduped. */
export function appendExtraSkillDirs(value: string, selected: readonly string[]): string {
  const entries = value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  for (const path of selected.map((entry) => entry.trim()).filter(Boolean)) {
    if (!entries.includes(path)) entries.push(path);
  }
  return entries.join('\n');
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

export type TokenCountingStrategy = 'measured+estimated' | 'measured' | 'estimated';
export type PrintBackgroundMode = 'exit' | 'drain' | 'steer';

export interface RuntimeConfigDraft {
  cron: {
    debug: boolean;
    noJitter: boolean;
    noStale: boolean;
    disabled: boolean;
    manualTick: boolean;
    clock: string;
    pollIntervalMs: string;
  };
  threadCommunicationEnabled: boolean;
  tokenCountingStrategy: TokenCountingStrategy;
  workspaceIdleTtlMs: string;
  imageMaxEdgePx: string;
  imageReadByteBudget: string;
  task: {
    maxRunningTasks: string;
    keepAliveOnExit: boolean;
    bashAutoBackgroundOnTimeout: boolean;
    bashTaskTimeoutS: string;
    killGracePeriodMs: string;
    printWaitCeilingS: string;
    printBackgroundMode: PrintBackgroundMode;
    printMaxTurns: string;
  };
  identityName: string;
  identitySlug: string;
  extraAgentDirs: string[];
  disabledBuiltinProfiles: string[];
  mcpStartupTimeoutMs: string;
  mcpToolTimeoutMs: string;
  toolsEnabled: string[];
  toolsDisabled: string[];
}

function optionalNumberDraft(value: number | null | undefined): string {
  return value === null ? 'null' : value === undefined ? '' : String(value);
}

export function runtimeConfigDraftFromConfig(value: unknown): RuntimeConfigDraft {
  const config = configObjectOrEmpty(value) as unknown as KikiConfigResponse;
  const task = config.task;
  return {
    cron: {
      debug: config.cron?.debug ?? false,
      noJitter: config.cron?.noJitter ?? false,
      noStale: config.cron?.noStale ?? false,
      disabled: config.cron?.disabled ?? false,
      manualTick: config.cron?.manualTick ?? false,
      clock: config.cron?.clock ?? '',
      pollIntervalMs: optionalNumberDraft(config.cron?.pollIntervalMs),
    },
    threadCommunicationEnabled: config.thread_communication?.enabled ?? false,
    tokenCountingStrategy: config.token_counting?.strategy ?? 'measured+estimated',
    workspaceIdleTtlMs: optionalNumberDraft(config.workspace_instance?.idleTtlMs ?? 300_000),
    imageMaxEdgePx: optionalNumberDraft(config.image?.maxEdgePx),
    imageReadByteBudget: optionalNumberDraft(config.image?.readByteBudget),
    task: {
      maxRunningTasks: optionalNumberDraft(task?.maxRunningTasks),
      keepAliveOnExit: task?.keepAliveOnExit ?? false,
      bashAutoBackgroundOnTimeout: task?.bashAutoBackgroundOnTimeout ?? false,
      bashTaskTimeoutS: optionalNumberDraft(task?.bashTaskTimeoutS),
      killGracePeriodMs: optionalNumberDraft(task?.killGracePeriodMs),
      printWaitCeilingS: optionalNumberDraft(task?.printWaitCeilingS),
      printBackgroundMode: task?.printBackgroundMode ?? 'steer',
      printMaxTurns: optionalNumberDraft(task?.printMaxTurns),
    },
    identityName: config.identity?.name ?? '',
    identitySlug: config.identity?.slug ?? '',
    extraAgentDirs: normalizeConfigStringList(config.extra_agent_dirs),
    disabledBuiltinProfiles: normalizeConfigStringList(config.disabled_builtin_profiles),
    mcpStartupTimeoutMs: optionalNumberDraft(config.mcp?.startupTimeoutMs),
    mcpToolTimeoutMs: optionalNumberDraft(config.mcp?.toolTimeoutMs),
    toolsEnabled: normalizeConfigStringList(config.tools?.enabled),
    toolsDisabled: normalizeConfigStringList(config.tools?.disabled),
  };
}

function parseOptionalInteger(
  value: string,
  field: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (!/^\d+$/.test(trimmed)) {
    throw new LocalizedError({ key: minimum === 0 ? 'val.runtimeNonNegative' : 'val.runtimePositive', params: { field } });
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new LocalizedError({ key: minimum === 0 ? 'val.runtimeNonNegative' : 'val.runtimePositive', params: { field } });
  }
  return parsed;
}

function normalizeStringList(values: readonly string[]): string[] {
  return normalizeTags(values);
}

export function runtimeConfigPatch(draft: RuntimeConfigDraft): KikiConfigPatch {
  // cron is env-driven (KIMI_CRON_*) and intentionally never persisted — the
  // editor shows it read-only, so the patch neither sends nor replaces it.
  const mcpMax = 2_147_483_647;
  return {
    thread_communication: { enabled: draft.threadCommunicationEnabled },
    token_counting: { strategy: draft.tokenCountingStrategy },
    workspace_instance: {
      idle_ttl_ms: parseOptionalInteger(draft.workspaceIdleTtlMs, 'workspace_instance.idle_ttl_ms', 0),
    },
    image: {
      max_edge_px: parseOptionalInteger(draft.imageMaxEdgePx, 'image.max_edge_px', 1),
      read_byte_budget: parseOptionalInteger(draft.imageReadByteBudget, 'image.read_byte_budget', 1),
    },
    task: {
      max_running_tasks: parseOptionalInteger(draft.task.maxRunningTasks, 'task.max_running_tasks', 1),
      keep_alive_on_exit: draft.task.keepAliveOnExit,
      bash_auto_background_on_timeout: draft.task.bashAutoBackgroundOnTimeout,
      bash_task_timeout_s: parseOptionalInteger(draft.task.bashTaskTimeoutS, 'task.bash_task_timeout_s', 0),
      kill_grace_period_ms: parseOptionalInteger(draft.task.killGracePeriodMs, 'task.kill_grace_period_ms', 0),
      print_wait_ceiling_s: parseOptionalInteger(draft.task.printWaitCeilingS, 'task.print_wait_ceiling_s', 1),
      print_background_mode: draft.task.printBackgroundMode,
      print_max_turns: parseOptionalInteger(draft.task.printMaxTurns, 'task.print_max_turns', 1),
    },
    identity: {
      name: draft.identityName.trim() || undefined,
      slug: draft.identitySlug.trim() || undefined,
    },
    extra_agent_dirs: normalizeStringList(draft.extraAgentDirs),
    disabled_builtin_profiles: normalizeStringList(draft.disabledBuiltinProfiles),
    mcp: {
      startup_timeout_ms: parseOptionalInteger(draft.mcpStartupTimeoutMs, 'mcp.startup_timeout_ms', 1, mcpMax),
      tool_timeout_ms: parseOptionalInteger(draft.mcpToolTimeoutMs, 'mcp.tool_timeout_ms', 1, mcpMax),
    },
    tools: {
      enabled: normalizeStringList(draft.toolsEnabled),
      disabled: normalizeStringList(draft.toolsDisabled),
    },
    replace_domains: [
      'thread_communication',
      'token_counting',
      'workspace_instance',
      'image',
      'task',
      'identity',
      'extra_agent_dirs',
      'disabled_builtin_profiles',
      'mcp',
      'tools',
    ],
  };
}

export function toolPolicyValue(draft: RuntimeConfigDraft, toolName: string): 'enabled' | 'disabled' | 'inherited' {
  if (draft.toolsDisabled.includes(toolName)) return 'disabled';
  if (draft.toolsEnabled.includes(toolName)) return 'enabled';
  return 'inherited';
}

export function setToolPolicy(
  draft: RuntimeConfigDraft,
  toolName: string,
  policy: 'enabled' | 'disabled' | 'inherited',
): RuntimeConfigDraft {
  const enabled = draft.toolsEnabled.filter((name) => name !== toolName);
  const disabled = draft.toolsDisabled.filter((name) => name !== toolName);
  if (policy === 'enabled') enabled.push(toolName);
  if (policy === 'disabled') disabled.push(toolName);
  return { ...draft, toolsEnabled: enabled, toolsDisabled: disabled };
}

export function validateDesktopConfigDraft(input: {
  subagentTimeoutMs: number;
  modelCatalogRefreshIntervalMs: number;
}): ValidationIssue | null {
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

export function requestIdentityLayerDraftFromPolicy(
  policy: RequestIdentityPolicyWire | undefined,
): RequestIdentityLayerDraft {
  return {
    requestIdentityChoice:
      policy?.preset ?? (policy?.overrides === undefined ? 'inherit' : 'custom_overrides'),
    requestIdentityOverridesJson:
      policy?.overrides === undefined ? '' : JSON.stringify(policy.overrides, null, 2),
  };
}

export function requestIdentityPolicyFromDraft(
  draft: RequestIdentityLayerDraft,
): RequestIdentityPolicyWire | undefined {
  if (draft.requestIdentityChoice === 'inherit') return undefined;

  const trimmed = draft.requestIdentityOverridesJson.trim();
  if (draft.requestIdentityChoice === 'custom_overrides' && trimmed === '') {
    throw new LocalizedError({ key: 'val.requestIdentityOverridesRequired' });
  }

  let overrides: RequestIdentityPolicyWire['overrides'];
  if (trimmed !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new LocalizedError({ key: 'val.requestIdentityJson' });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new LocalizedError({ key: 'val.requestIdentityOverridesInvalid' });
    }
    overrides = parsed as RequestIdentityPolicyWire['overrides'];
  }

  const candidate = {
    preset: isRequestIdentityPreset(draft.requestIdentityChoice)
      ? draft.requestIdentityChoice
      : undefined,
    overrides,
  };
  const result = requestIdentityPolicySchema.safeParse(candidate);
  if (!result.success) {
    throw new LocalizedError({ key: 'val.requestIdentityOverridesInvalid' });
  }
  return result.data;
}

export function validateRequestIdentityLayerDraft(
  draft: RequestIdentityLayerDraft,
): ValidationIssue | null {
  try {
    requestIdentityPolicyFromDraft(draft);
    return null;
  } catch (error) {
    return error instanceof LocalizedError
      ? error.issue
      : { key: 'val.requestIdentityOverridesInvalid' };
  }
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
      ...requestIdentityLayerDraftFromPolicy(model.request_identity),
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
    ...requestIdentityLayerDraftFromPolicy(provider.request_identity),
    models: providerModels,
  };
}

export function validateProviderDraft(draft: ProviderDraft): ValidationIssue | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(draft.id)) {
    return { key: 'val.providerId' };
  }
  if (!isProviderWireType(draft.type)) return { key: 'val.providerProtocol' };
  const providerIdentityIssue = validateRequestIdentityLayerDraft(draft);
  if (providerIdentityIssue !== null) return providerIdentityIssue;
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
    const modelIdentityIssue = validateRequestIdentityLayerDraft(model);
    if (modelIdentityIssue !== null) {
      return { key: 'val.modelRequestIdentity', params: { model: model.model || '(unnamed)' } };
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
  if (a.requestIdentityChoice !== b.requestIdentityChoice) return false;
  if (a.requestIdentityOverridesJson !== b.requestIdentityOverridesJson) return false;
  if (a.models.length !== b.models.length) return false;
  return a.models.every((model, index) => {
    const other = b.models[index];
    return other !== undefined
      && model.model === other.model
      && model.maxContextSize === other.maxContextSize
      && model.displayName === other.displayName
      && model.requestIdentityChoice === other.requestIdentityChoice
      && model.requestIdentityOverridesJson === other.requestIdentityOverridesJson
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
    requestIdentityChoice: 'inherit',
    requestIdentityOverridesJson: '',
  }));
}

// ---- capabilities section grouping ----

/**
 * Information hierarchy for the settings capabilities section: cards are
 * bucketed into collapsible groups so the section reads as five labeled
 * layers instead of a flat wall. Everyday surfaces (skills, MCP) stay open;
 * low-frequency / dangerous surfaces (runtime policy, experimental flags,
 * raw JSON domains) start collapsed. `cardIds` lets a settings-search hit
 * force its group open before the scroll + flash lands.
 */
export interface CapabilityGroupSpec {
  readonly id: string;
  readonly titleKey: I18nKey;
  readonly cardIds: readonly string[];
  readonly defaultOpen: boolean;
}

export const CAPABILITY_GROUPS: readonly CapabilityGroupSpec[] = [
  { id: 'skills', titleKey: 'st.caps.group.skills', cardIds: ['st-card-caps'], defaultOpen: true },
  { id: 'mcp', titleKey: 'st.caps.group.mcp', cardIds: ['st-card-mcp'], defaultOpen: true },
  { id: 'runtime', titleKey: 'st.caps.group.runtime', cardIds: ['st-card-runtime', 'st-card-tools'], defaultOpen: false },
  { id: 'experimental', titleKey: 'st.caps.group.experimental', cardIds: ['st-card-experimental'], defaultOpen: false },
  { id: 'advanced', titleKey: 'st.caps.group.advanced', cardIds: ['st-card-advanced'], defaultOpen: false },
];

export function capabilityGroupForCard(cardId: string): CapabilityGroupSpec | undefined {
  return CAPABILITY_GROUPS.find((group) => group.cardIds.includes(cardId));
}

// ---- settings search index ----

export interface SettingsSearchSpecEntry {
  readonly section: string;
  /** DOM id the SectionCard renders so a result can scroll + flash it. */
  readonly cardId: string;
  readonly titleKey: I18nKey;
  readonly keywordKeys: readonly I18nKey[];
  /**
   * Locale-independent haystack tokens: legacy names and synonyms a user
   * types from habit ("能力", "供应商", "模型目录", "Profiles" — redesign
   * §2.1). They match in both locales because they are indexed verbatim.
   */
  readonly synonyms?: readonly string[];
}

/** Settings section order. Lives here, not in the page, so the quick switcher
 * can label settings hits without importing the whole settings tree. */
export const SETTINGS_SECTIONS: readonly { id: string; labelKey: I18nKey }[] = [
  { id: 'general', labelKey: 'st.section.general' },
  { id: 'models', labelKey: 'st.section.models' },
  { id: 'providers', labelKey: 'st.section.providers' },
  { id: 'agents', labelKey: 'st.section.agents' },
  { id: 'capabilities', labelKey: 'st.section.capabilities' },
  { id: 'workspaces', labelKey: 'st.section.workspaces' },
  { id: 'connection', labelKey: 'st.section.connection' },
  { id: 'about', labelKey: 'st.section.about' },
];

// ---- grouped navigation (settings redesign batch 1) ----

/**
 * Candidate-A visual grouping for the settings left rail. Group headers are
 * labels only — they never own a page. Content has not moved yet (batches
 * 2/3), so today's eight leaves are parked in the group their content will
 * end up in: models + providers under "AI configuration", capabilities under
 * "Capabilities & extensions", and so on.
 */
export interface SettingsNavGroupSpec {
  readonly id: string;
  readonly labelKey: I18nKey;
  readonly sections: readonly string[];
}

export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroupSpec[] = [
  { id: 'app', labelKey: 'st.group.app', sections: ['general'] },
  { id: 'ai', labelKey: 'st.group.ai', sections: ['models', 'providers'] },
  { id: 'agents', labelKey: 'st.group.agents', sections: ['agents'] },
  { id: 'extensions', labelKey: 'st.group.capabilities', sections: ['capabilities'] },
  { id: 'system', labelKey: 'st.group.system', sections: ['workspaces', 'connection'] },
  { id: 'about', labelKey: 'st.group.about', sections: ['about'] },
];

export function settingsGroupForSection(sectionId: string): SettingsNavGroupSpec | undefined {
  return SETTINGS_NAV_GROUPS.find((group) => group.sections.includes(sectionId));
}

/** Who a section's edits apply to; rendered as the page-header scope badge. */
export type SettingsScope = 'app' | 'server' | 'workspace';

export interface SettingsSectionMeta {
  readonly scope: SettingsScope;
  readonly purposeKey: I18nKey;
}

export const SETTINGS_SECTION_META: Readonly<Record<string, SettingsSectionMeta>> = {
  general: { scope: 'app', purposeKey: 'st.purpose.general' },
  models: { scope: 'server', purposeKey: 'st.purpose.models' },
  providers: { scope: 'server', purposeKey: 'st.purpose.providers' },
  agents: { scope: 'server', purposeKey: 'st.purpose.agents' },
  capabilities: { scope: 'server', purposeKey: 'st.purpose.capabilities' },
  workspaces: { scope: 'server', purposeKey: 'st.purpose.workspaces' },
  connection: { scope: 'app', purposeKey: 'st.purpose.connection' },
  about: { scope: 'app', purposeKey: 'st.purpose.about' },
};

export const SETTINGS_SEARCH_SPEC: readonly SettingsSearchSpecEntry[] = [
  { section: 'general', cardId: 'st-card-language', titleKey: 'st.language.title', keywordKeys: ['st.language.hint'] },
  { section: 'general', cardId: 'st-card-appearance', titleKey: 'st.appearance.title', keywordKeys: ['st.appearance.theme', 'st.appearance.theme.dark', 'st.appearance.theme.light', 'st.appearance.theme.system'] },
  { section: 'general', cardId: 'st-card-defaults', titleKey: 'st.defaults.title', keywordKeys: ['st.defaults.permissionMode', 'st.defaults.planMode', 'st.defaults.hint'] },
  { section: 'general', cardId: 'st-card-composer', titleKey: 'st.composer.title', keywordKeys: ['st.composer.sendShortcut', 'st.composer.persistDrafts'] },
  { section: 'general', cardId: 'st-card-desktop', titleKey: 'st.desktop.title', keywordKeys: ['st.desktop.notifications', 'st.desktop.tray', 'st.desktop.quit'] },
  { section: 'general', cardId: 'st-card-compatibility-home', titleKey: 'st.compat.title', keywordKeys: ['st.compat.home', 'st.compat.credentialPath', 'st.compat.configImportTitle', 'st.compat.migrateUserSkills'] },
  { section: 'models', cardId: 'st-card-models', titleKey: 'st.models.defaultTitle', keywordKeys: ['st.models.providerLabel', 'st.models.searchPlaceholder'], synonyms: ['模型目录', 'model catalog', '模型列表'] },
  { section: 'models', cardId: 'st-card-request-identity', titleKey: 'st.requestIdentity.defaultTitle', keywordKeys: ['st.requestIdentity.defaultLabel', 'st.requestIdentity.defaultHint'] },
  { section: 'models', cardId: 'st-card-thinking', titleKey: 'st.thinking.title', keywordKeys: ['st.thinking.enable', 'st.thinking.hint'] },
  { section: 'connection', cardId: 'st-card-conn-server', titleKey: 'st.conn.connectedTitle', keywordKeys: ['connect.serverUrl', 'connect.token', 'st.conn.version', 'st.conn.reconnect'] },
  { section: 'connection', cardId: 'st-card-conn-owned', titleKey: 'st.conn.ownedTitle', keywordKeys: ['st.conn.ownedBody', 'st.conn.restart'] },
  { section: 'connection', cardId: 'st-card-conn-disconnect', titleKey: 'st.conn.disconnectTitle', keywordKeys: ['st.conn.disconnectBody', 'sidebar.disconnect'] },
  { section: 'providers', cardId: 'st-card-auth', titleKey: 'st.auth.title', keywordKeys: ['st.auth.signIn', 'st.auth.signOut'], synonyms: ['提供商', '供应商', 'provider', '认证'] },
  { section: 'providers', cardId: 'st-card-providers', titleKey: 'st.providers.title', keywordKeys: ['st.providers.empty'], synonyms: ['提供商', '供应商', 'provider'] },
  { section: 'providers', cardId: 'st-card-providers-add', titleKey: 'st.providers.addTitle', keywordKeys: ['st.wizard.chooseTemplate', 'st.fetchModels.button'], synonyms: ['提供商', '供应商', 'provider'] },
  { section: 'capabilities', cardId: 'st-card-caps', titleKey: 'st.caps.title', keywordKeys: ['st.caps.mergeSkills', 'st.caps.telemetry', 'st.caps.extraDirs'], synonyms: ['能力', 'skills', '技能'] },
  { section: 'capabilities', cardId: 'st-card-runtime', titleKey: 'st.runtime.title', keywordKeys: ['st.runtime.cron', 'st.runtime.communication', 'st.runtime.resources', 'st.runtime.task', 'st.runtime.agents'] },
  { section: 'capabilities', cardId: 'st-card-experimental', titleKey: 'st.experimental.title', keywordKeys: ['st.experimental.hint', 'st.experimental.overrideLabel'] },
  { section: 'capabilities', cardId: 'st-card-advanced', titleKey: 'st.advanced.title', keywordKeys: ['st.advanced.hint'] },
  { section: 'agents', cardId: 'st-card-subagents', titleKey: 'st.subagents.title', keywordKeys: ['st.subagents.denyModels', 'st.subagents.hint'], synonyms: ['子 agent', '子代理'] },
  { section: 'agents', cardId: 'st-card-main-agents', titleKey: 'st.mainAgents.title', keywordKeys: ['st.namedAgents.readOnlyHint', 'st.namedAgents.modelPin'], synonyms: ['主 agent'] },
  { section: 'agents', cardId: 'st-card-subagent-profiles', titleKey: 'st.subagentProfiles.title', keywordKeys: ['st.namedAgents.readOnlyHint', 'st.namedAgents.modelPin', 'st.namedAgents.route'], synonyms: ['子 agent', '子代理', 'profiles', 'profile'] },
  { section: 'agents', cardId: 'st-card-sidecar', titleKey: 'st.sidecar.title', keywordKeys: ['st.sidecar.hint', 'st.sidecar.subagentTimeout', 'st.agents.webHint'] },
  { section: 'capabilities', cardId: 'st-card-tools', titleKey: 'st.tools.title', keywordKeys: [] },
  { section: 'capabilities', cardId: 'st-card-mcp', titleKey: 'st.mcp.title', keywordKeys: ['st.mcp.configTitle', 'st.mcp.workspace'], synonyms: ['能力', 'mcp 服务器', 'mcp server'] },
  { section: 'workspaces', cardId: 'st-card-workspaces', titleKey: 'st.workspaces.title', keywordKeys: ['st.workspaces.hint'] },
  { section: 'about', cardId: 'st-card-about', titleKey: 'st.about.title', keywordKeys: ['st.about.serverVersion', 'st.about.serverId'] },
];

export interface SettingsSearchEntry {
  readonly section: string;
  readonly cardId: string;
  /** Breadcrumb: visual group › leaf section › card title. */
  readonly groupLabel: string;
  readonly sectionLabel: string;
  readonly title: string;
  readonly haystack: string;
}

/** Localized section labels keyed by section id, for the search index. */
export function settingsSectionLabels(
  t: (key: I18nKey) => string,
): Record<string, string> {
  return Object.fromEntries(SETTINGS_SECTIONS.map((section) => [section.id, t(section.labelKey)]));
}

export function buildSettingsSearchIndex(
  sectionLabels: Readonly<Record<string, string>>,
  t: (key: I18nKey) => string,
): SettingsSearchEntry[] {
  return SETTINGS_SEARCH_SPEC.map((entry) => {
    const title = t(entry.titleKey);
    const group = settingsGroupForSection(entry.section);
    const groupLabel = group === undefined ? '' : t(group.labelKey);
    const sectionLabel = sectionLabels[entry.section] ?? entry.section;
    return {
      section: entry.section,
      cardId: entry.cardId,
      groupLabel,
      sectionLabel,
      title,
      haystack: [title, groupLabel, sectionLabel, ...entry.keywordKeys.map((key) => t(key)), ...(entry.synonyms ?? [])].join('\n').toLowerCase(),
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

// ---- legacy / unknown settings route resolution ----

export type SettingsRouteResolution =
  | { readonly status: 'ok'; readonly section: string; readonly cardId?: string }
  | { readonly status: 'unknown'; readonly section: string; readonly cardId?: string };

/**
 * Hidden aliases for renamed sections, so an old bookmark still lands on its
 * content instead of the "unknown setting" page. Batch 1 renamed no section,
 * so the map starts empty; batches 2/3 add entries like `general → appearance`
 * as content moves. Card-level moves need no entry here — the card-aware
 * fallback in `resolveSettingsRoute` already follows the card.
 */
export const LEGACY_SETTINGS_SECTION_ALIASES: Readonly<Record<string, string>> = {};

/** Canonical section owning a card id; the search spec is the one list that knows every card. */
export function settingsSectionForCard(cardId: string): string | undefined {
  return SETTINGS_SEARCH_SPEC.find((entry) => entry.cardId === cardId)?.section;
}

/**
 * Resolve `/settings/:section` + `#st-card-*` to the canonical target.
 *
 * - No section → the default page (general), preserving any card hash.
 * - Known section (directly or via a legacy alias) → that section; when the
 *   hash names a card that now lives elsewhere, the card wins, because the
 *   link predates a content move and the card is the precise half of it.
 * - Unknown section with a recognizable card → the card's current section.
 * - Unknown section, no usable card → `unknown`; the page shows "this setting
 *   does not exist" with a search instead of silently falling back to general.
 */
export function resolveSettingsRoute(
  sectionParam: string | undefined,
  hash: string,
): SettingsRouteResolution {
  const rawCard = hash.replace(/^#/, '');
  const cardId = rawCard.startsWith('st-card-') ? rawCard : undefined;
  const cardSection = cardId === undefined ? undefined : settingsSectionForCard(cardId);
  if (sectionParam === undefined || sectionParam === '') {
    return { status: 'ok', section: 'general', cardId };
  }
  const aliased = LEGACY_SETTINGS_SECTION_ALIASES[sectionParam] ?? sectionParam;
  if (SETTINGS_SECTIONS.some((candidate) => candidate.id === aliased)) {
    if (cardSection !== undefined && cardSection !== aliased) {
      return { status: 'ok', section: cardSection, cardId };
    }
    return { status: 'ok', section: aliased, cardId };
  }
  if (cardSection !== undefined) {
    return { status: 'ok', section: cardSection, cardId };
  }
  return { status: 'unknown', section: sectionParam, cardId };
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
  const requestIdentity = requestIdentityPolicyFromDraft(draft);
  return {
    id: includeId ? draft.id : undefined,
    type: draft.type,
    api_key: apiKey,
    base_url: draft.baseUrl || undefined,
    default_model: draft.defaultModel,
    request_identity: requestIdentity ?? (includeId ? undefined : null),
    models: draft.models.map((model) => {
      const modelRequestIdentity = requestIdentityPolicyFromDraft(model);
      return {
        model: model.model,
        max_context_size: model.maxContextSize,
        display_name: model.displayName || undefined,
        capabilities: model.capabilities.length > 0 ? model.capabilities : undefined,
        support_efforts: model.supportEfforts.length > 0 ? model.supportEfforts : undefined,
        request_identity: modelRequestIdentity ?? (includeId ? undefined : null),
      };
    }),
  };
}

function isRequestIdentityPreset(value: RequestIdentityChoice): value is RequestIdentityPreset {
  return ['codex_compatible', 'grok_build_compatible', 'kimi_code', 'none'].includes(value);
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
