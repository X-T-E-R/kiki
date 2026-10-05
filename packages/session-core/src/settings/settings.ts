import {
  imageMimeSchema,
  providerIdSchema,
  requestIdentityPolicySchema,
  permissionConfigPatchSchema,
  hooksConfigSchema,
  LEGACY_HOOK_EVENTS,
  type HooksConfig,
  type LegacyHookConfig,
  type CreateModelRequest,
  type CreateProviderRequest,
  type GetModelResponse,
  type ImagePolicyPatch,
  type ImagePolicyWire,
  type ModelCatalogItem,
  type ModelBehaviorWire,
  type PatchConfigRequest,
  type PatchModelRequest,
  type PatchProviderRequest,
  type ProviderCatalogItem,
  type RequestIdentityPolicyWire,
  type SessionTitleTrigger,
} from '@kiki/protocol';

import { LocalizedError, type I18nKey, type ValidationIssue } from '../i18n/locale';
import { spaceStorage } from '../storage/spaceStorage';
import type { KikiConfigPatch, KikiConfigResponse } from '../transport';
import { questionGuardDraftFromBehavior, questionGuardModelPatch } from './questionGuardSettings';

/** Client-local preferences stored in localStorage (`kiki.settings`). */
export type SendShortcut = 'enter' | 'cmd-enter';

/** Deferred-append timing a client sends by default with each new message. */
export type DefaultAppendTiming = 'agent_idle' | 'subagents_done' | 'tasks_done';

export function isDefaultAppendTiming(value: unknown): value is DefaultAppendTiming {
  return value === 'agent_idle' || value === 'subagents_done' || value === 'tasks_done';
}

/** `system` follows the OS; the other two pin the palette regardless. */
export type ThemePreference = 'light' | 'dark' | 'system';

/** Motion level; `system` follows `prefers-reduced-motion`. Mirrored onto
 *  `<html data-kiki-motion>` so the motion stylesheet can honour it. */
export type MotionPreference = 'system' | 'reduce' | 'full';

export function isMotionPreference(value: unknown): value is MotionPreference {
  return value === 'system' || value === 'reduce' || value === 'full';
}

/** Face for assistant prose; mirrored onto `<html data-kiki-prose>`. */
export type ProseFontPreference = 'serif' | 'sans';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 30;
export const MIN_REQUEST_TIMEOUT_SECONDS = 5;
export const MAX_REQUEST_TIMEOUT_SECONDS = 600;

export type SubagentPanelOpenMode = 'tab' | 'fullscreen';

export interface DesktopSettings {
  defaultPermissionMode: 'manual' | 'auto' | 'review' | 'yolo';
  defaultPlanMode: boolean;
  sendShortcut: SendShortcut;
  draftPersistence: boolean;
  defaultModel: string | undefined;
  defaultEffort: string | undefined;
  closeToTray: boolean;
  theme: ThemePreference;
  requestTimeoutSeconds: number;
  subagentPanelOpenMode: SubagentPanelOpenMode;
  defaultAppendTiming: DefaultAppendTiming;
  /** Fold runs of ≥3 consecutive pure reads into one summary line (off by default). */
  foldSteps: boolean;
  /**
   * Skip the /new worktree opt-in's confirmation dialog (its "don't ask
   * again"). Settings carries the way back to asking.
   */
  worktreeSkipConfirm: boolean;
  /** The session inspector (right rail) starts open on wide windows. */
  railOpenByDefault: boolean;
  motion: MotionPreference;
  proseFont: ProseFontPreference;
  /**
   * Which kinds of away notifications this device shows. The master switch
   * is the desktop `notifications` preference (the native side reads it too);
   * these narrow it per kind.
   */
  awayNotifications: AwayNotificationKinds;
}

/** Per-kind switches for notifications while the window is in the background. */
export interface AwayNotificationKinds {
  completed: boolean;
  failed: boolean;
  question: boolean;
  approval: boolean;
}

export const DEFAULT_AWAY_NOTIFICATION_KINDS: AwayNotificationKinds = {
  completed: true,
  failed: true,
  question: true,
  approval: true,
};

function readAwayNotificationKinds(value: unknown): AwayNotificationKinds {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const pick = (key: keyof AwayNotificationKinds) =>
    typeof record[key] === 'boolean' ? record[key] as boolean : DEFAULT_AWAY_NOTIFICATION_KINDS[key];
  return { completed: pick('completed'), failed: pick('failed'), question: pick('question'), approval: pick('approval') };
}

export type UpdateChannel = 'stable' | 'beta';
export type AutoUpdateMode = 'off' | 'notify' | 'install';

/**
 * What the updater still owes the next run. `skipped` holds the versions the
 * user chose not to hear about again on the channel they were offered on;
 * `snoozedUntil` is when "remind me later" runs out; `lastCheckedAt` is the
 * scheduler's cadence anchor, not a promise that anything was found.
 *
 * The native side stores this record whole: a field that is absent or `null`
 * is a field to clear, and a field that is absent from a *patch* is a field
 * the patch says nothing about. The two are different, which is why a write
 * builds the record field by field rather than merging into a snapshot.
 *
 * A skip belongs to the channel it was offered on, so a beta the user skipped
 * does not silence the stable build of the same version.
 */
export interface DesktopUpdateState {
  /** Versions the user skipped, per channel, oldest first. `null` clears. */
  skipped?: { readonly stable?: readonly string[] | null; readonly beta?: readonly string[] | null } | null;
  /** Epoch ms before which a known update stays quiet. `null` clears. */
  snoozedUntil?: number | null;
  /** Epoch ms of the last finished check, whether it found anything or not. `null` clears. */
  lastCheckedAt?: number | null;
}

export const DESKTOP_LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type DesktopLogLevel = typeof DESKTOP_LOG_LEVELS[number];

export interface DesktopNativePrefs {
  notifications: boolean;
  closeToTray: boolean;
  /** UI locale mirrored to the native side (tray menu labels); frontend-owned. */
  locale?: string;
  updateChannel: UpdateChannel;
  autoUpdate: AutoUpdateMode;
  /**
   * Cross-run record of what the updater already offered and what the user
   * did about it. App scope, like the channel and the mode, because the version
   * being skipped is a property of this install rather than of a space.
   */
  updateState?: DesktopUpdateState;
  /** Backend verbosity; persisted per space and applied on the next owned backend launch. */
  logLevel?: DesktopLogLevel;
  compatibility: CompatibilitySettings;
  /**
   * How spaces open: one window that switches between them, or one window per
   * space. App-level (the main space's `desktop.json`), read at launch, so a
   * change applies the next time Kiki starts. The native side reads it as
   * `window_mode` and accepts either spelling on write.
   */
  windowMode: SpaceWindowMode;
}

export type CompatibilityHomeKind = 'kimi' | 'custom';
export type SpaceWindowMode = 'switch' | 'windows';

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
  return {
    subagent: {
      timeoutMs: typeof subagent['timeoutMs'] === 'number' ? subagent['timeoutMs'] : 7_200_000,
    },
    agents: {
      enabled: agents['enabled'] !== false,
    },
    builtinProductSkills: source['builtin_product_skills'] !== false,
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
  return {
    subagent: Object.values(subagent).some((value) => value !== undefined) ? subagent : undefined,
    agents: Object.values(agents).some((value) => value !== undefined) ? agents : undefined,
    builtin_product_skills:
      baseline === undefined || settings.builtinProductSkills !== baseline.builtinProductSkills
        ? settings.builtinProductSkills
        : undefined,
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

/** `profile:<id>` selects a custom identity from the request-identity catalog. */
export type RequestIdentityChoice =
  | 'inherit'
  | 'custom_overrides'
  | RequestIdentityPreset
  | `profile:${string}`;

export const REQUEST_IDENTITY_CHOICES: readonly RequestIdentityChoice[] = [
  'inherit',
  'custom_overrides',
  'codex_compatible',
  'claude_code_compatible',
  'grok_build_compatible',
  'opencode_compatible',
  'kimi_code',
  'none',
];

export function requestIdentityProfileChoice(id: string): RequestIdentityChoice {
  return `profile:${id}`;
}

/** The custom profile id a choice selects, or undefined for inherit/presets/overrides-only. */
export function requestIdentityChoiceProfile(choice: RequestIdentityChoice): string | undefined {
  return choice.startsWith('profile:') ? choice.slice('profile:'.length) : undefined;
}

export interface RequestIdentityLayerDraft {
  requestIdentityChoice: RequestIdentityChoice;
  requestIdentityOverridesJson: string;
}

export type ImageConversionMode = NonNullable<ImagePolicyWire['convert_unsupported']>;

export interface ImagePolicyDraft {
  /** `null` leaves this leaf inherited; an explicit empty list is invalid. */
  imageAcceptedTypes: string[] | null;
  /** `null` inherits the enclosing provider/built-in conversion policy. */
  imageConvertUnsupported: ImageConversionMode | null;
}

export const KNOWN_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/bmp',
] as const;

/**
 * One editable local model row. `id` is the local alias (the config key a
 * session references) and `remoteId` the exact model name sent upstream; they
 * are independent, so a row keeps its identity whatever the alias looks like.
 * A row that does not exist on the server yet carries `id: ''` and is created
 * from `providerId/remoteId` on save.
 */
export interface ProviderModelDraft extends RequestIdentityLayerDraft, ImagePolicyDraft {
  id: string;
  remoteId: string;
  /** `0` means the stored model declares no context size yet. */
  maxContextSize: number;
  /** Absolute positive integer tokens; omitted means inherit the existing compaction policy. */
  autoCompact?: number;
  displayName: string;
  capabilities: string[];
  supportEfforts: string[];
  behavior?: ModelBehaviorWire;
}

export interface ProviderDraft extends RequestIdentityLayerDraft, ImagePolicyDraft {
  id: string;
  type: ProviderWireType;
  baseUrl: string;
  /**
   * The starred default row, as that row identified itself when it was
   * starred: its local alias for a stored model, its remote id for a row that
   * only exists in a not-yet-saved connection. Both save paths resolve it back
   * to the row (the create body wants the upstream half, the provider patch
   * the local alias).
   */
  defaultModel: string;
  apiKey: string;
  clearApiKey: boolean;
  models: ProviderModelDraft[];
}

export type SpacePortableDesktopSettings = Pick<DesktopSettings, 'theme' | 'proseFont' | 'defaultAppendTiming' | 'foldSteps' | 'worktreeSkipConfirm'>;
export interface SpacePortableSettingsBridge {
  read(): Partial<SpacePortableDesktopSettings>;
  write(patch: Partial<SpacePortableDesktopSettings>): void;
}
const PORTABLE_DESKTOP_KEYS: readonly (keyof SpacePortableDesktopSettings)[] = ['theme', 'proseFont', 'defaultAppendTiming', 'foldSteps', 'worktreeSkipConfirm'];
let portableSettingsBridge: SpacePortableSettingsBridge | undefined;
export function configureSpacePortableSettings(bridge?: SpacePortableSettingsBridge): void {
  portableSettingsBridge = bridge;
  publishSettings(readSettings());
}
export function refreshSpacePortableSettings(): void { publishSettings(readSettings()); }

const STORAGE_KEY = 'kiki.settings';
/** Space-scoped (§6.4): the session to reopen belongs to one space's list. */
const LAST_SESSION_KEY = 'kiki.lastSessionId';
const DESKTOP_PREFS_KEY = 'kiki.desktopPrefs';
/** Space-scoped (§6.4): a restart reminder is about the connected space's server. */
const RESTART_REQUIRED_KEY = 'kiki.restartRequired';

const DEFAULTS: DesktopSettings = {
  defaultPermissionMode: 'auto',
  defaultPlanMode: false,
  sendShortcut: 'enter',
  draftPersistence: true,
  defaultModel: undefined,
  defaultEffort: undefined,
  closeToTray: true,
  theme: 'system',
  requestTimeoutSeconds: DEFAULT_REQUEST_TIMEOUT_SECONDS,
  subagentPanelOpenMode: 'tab',
  defaultAppendTiming: 'agent_idle',
  foldSteps: false,
  worktreeSkipConfirm: false,
  railOpenByDefault: true,
  motion: 'system',
  proseFont: 'serif',
  awayNotifications: DEFAULT_AWAY_NOTIFICATION_KINDS,
};

export const DEFAULT_DESKTOP_SETTINGS: Readonly<DesktopSettings> = DEFAULTS;

const DESKTOP_PREFS_DEFAULTS: DesktopNativePrefs = {
  notifications: true,
  closeToTray: true,
  updateChannel: (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.['VITE_UPDATE_CHANNEL'] === 'beta' ? 'beta' : 'stable',
  autoUpdate: 'notify',
  logLevel: 'warn',
  compatibility: {
    homeKind: 'kimi',
    customHome: undefined,
  },
  windowMode: 'switch',
};

function readObject(
  key: string,
  storage: Pick<Storage, 'getItem'> = localStorage,
): Record<string, unknown> {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function validateRequestTimeoutSeconds(value: number): ValidationIssue | null {
  return Number.isInteger(value)
    && value >= MIN_REQUEST_TIMEOUT_SECONDS
    && value <= MAX_REQUEST_TIMEOUT_SECONDS
    ? null
    : { key: 'val.requestTimeoutSeconds' };
}

export function readDeviceSettings(): DesktopSettings {
  return normalizeSettings(readObject(STORAGE_KEY));
}

export function readSettings(): DesktopSettings {
  return normalizeSettings({ ...readObject(STORAGE_KEY), ...portableSettingsBridge?.read() });
}

function normalizeSettings(stored: Partial<DesktopSettings>): DesktopSettings {
  const requestTimeoutSeconds = stored.requestTimeoutSeconds;
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
    requestTimeoutSeconds:
      requestTimeoutSeconds !== undefined
      && validateRequestTimeoutSeconds(requestTimeoutSeconds) === null
        ? requestTimeoutSeconds
        : DEFAULTS.requestTimeoutSeconds,
    subagentPanelOpenMode:
      stored.subagentPanelOpenMode === 'fullscreen' ? 'fullscreen' : 'tab',
    defaultAppendTiming: isDefaultAppendTiming(stored.defaultAppendTiming)
      ? stored.defaultAppendTiming
      : DEFAULTS.defaultAppendTiming,
    foldSteps:
      typeof stored.foldSteps === 'boolean' ? stored.foldSteps : DEFAULTS.foldSteps,
    worktreeSkipConfirm:
      typeof stored.worktreeSkipConfirm === 'boolean' ? stored.worktreeSkipConfirm : DEFAULTS.worktreeSkipConfirm,
    railOpenByDefault:
      typeof stored.railOpenByDefault === 'boolean' ? stored.railOpenByDefault : DEFAULTS.railOpenByDefault,
    motion: isMotionPreference(stored.motion) ? stored.motion : DEFAULTS.motion,
    proseFont: stored.proseFont === 'sans' ? 'sans' : DEFAULTS.proseFont,
    awayNotifications: readAwayNotificationKinds(stored.awayNotifications),
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
  const devicePatch = { ...patch };
  if (portableSettingsBridge !== undefined) {
    const portablePatch: Partial<SpacePortableDesktopSettings> = {};
    for (const key of PORTABLE_DESKTOP_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) Object.assign(portablePatch, { [key]: patch[key] });
      delete devicePatch[key];
    }
    if (Object.keys(portablePatch).length > 0) portableSettingsBridge.write(portablePatch);
  }
  const next = { ...readObject(STORAGE_KEY), ...devicePatch };
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
  return composerEnterAction(event, shortcut) === 'send';
}

/**
 * What an Enter key press does in the composer:
 *   - `send`: send now when idle, queue behind the running turn when busy;
 *   - `send-now`: send into the running turn (steer); a plain send when idle;
 *   - `newline`: leave the key to the textarea;
 *   - `none`: not an Enter press, or an IME composition owns it.
 *
 * `enter` (default): Enter sends, ⌘/Ctrl+Enter sends now, Shift+Enter is a
 * new line. `cmd-enter`: Enter is a new line, ⌘/Ctrl+Enter sends,
 * ⌘/Ctrl+Shift+Enter sends now. An Enter that commits an IME candidate
 * (`isComposing`, or keyCode 229 on engines that drop the flag) never sends.
 */
export function composerEnterAction(
  event: ComposerKeyLike & { readonly isComposing?: boolean; readonly keyCode?: number; readonly altKey?: boolean },
  shortcut: SendShortcut,
): 'send' | 'send-now' | 'newline' | 'none' {
  if (event.key !== 'Enter') return 'none';
  if (event.isComposing === true || event.keyCode === 229) return 'none';
  if (event.altKey === true) return 'newline';
  const modified = event.metaKey || event.ctrlKey;
  if (shortcut === 'enter') {
    if (event.shiftKey) return 'newline';
    return modified ? 'send-now' : 'send';
  }
  if (!modified) return 'newline';
  return event.shiftKey ? 'send-now' : 'send';
}

export function readLastSessionId(): string | undefined {
  try {
    return spaceStorage.getItem(LAST_SESSION_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeLastSessionId(sessionId: string | undefined): void {
  try {
    if (sessionId === undefined) spaceStorage.removeItem(LAST_SESSION_KEY);
    else spaceStorage.setItem(LAST_SESSION_KEY, sessionId);
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
    autoUpdate:
      stored.autoUpdate === 'off' || stored.autoUpdate === 'notify' || stored.autoUpdate === 'install'
        ? stored.autoUpdate
        : DESKTOP_PREFS_DEFAULTS.autoUpdate,
    updateState: parseDesktopUpdateState(stored.updateState),
    logLevel: DESKTOP_LOG_LEVELS.includes(stored.logLevel as DesktopLogLevel) ? stored.logLevel : 'warn',
    compatibility: {
      homeKind: homeKind === 'kimi' || homeKind === 'custom'
        ? homeKind
        : DESKTOP_PREFS_DEFAULTS.compatibility.homeKind,
      customHome:
        typeof compatibility?.customHome === 'string' && compatibility.customHome.trim() !== ''
          ? compatibility.customHome
          : undefined,
    },
    windowMode: parseSpaceWindowMode(stored.windowMode ?? (stored as { window_mode?: unknown }).window_mode),
  };
}

/** `read_desktop_prefs` returns the native `window_mode` spelling; the GUI stores `windowMode`. */
function parseSpaceWindowMode(value: unknown): SpaceWindowMode {
  return value === 'windows' || value === 'switch' ? value : DESKTOP_PREFS_DEFAULTS.windowMode;
}

/**
 * Only keep the update record when it is a real record; drop it rather than
 * trust a half-written one. `null` is the native side's "clear this field" and
 * reads back as absent, so a null never survives into the value the rest of the
 * app sees.
 */
function parseDesktopUpdateState(value: unknown): DesktopUpdateState | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as { skipped?: unknown; snoozedUntil?: unknown; lastCheckedAt?: unknown };
  const list = (input: unknown) =>
    Array.isArray(input) ? input.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : undefined;
  const rawSkipped = typeof record.skipped === 'object' && record.skipped !== null ? record.skipped as { stable?: unknown; beta?: unknown } : undefined;
  const stable = rawSkipped === undefined ? undefined : list(rawSkipped.stable);
  const beta = rawSkipped === undefined ? undefined : list(rawSkipped.beta);
  const epoch = (input: unknown) =>
    typeof input === 'number' && Number.isFinite(input) && input >= 0 ? input : undefined;
  const skipped = stable === undefined && beta === undefined ? undefined : { stable, beta };
  const snoozedUntil = epoch(record.snoozedUntil);
  const lastCheckedAt = epoch(record.lastCheckedAt);
  if (skipped === undefined && snoozedUntil === undefined && lastCheckedAt === undefined) return undefined;
  return {
    skipped,
    snoozedUntil,
    lastCheckedAt,
  };
}

export function writeDesktopPrefs(prefs: Partial<DesktopNativePrefs>): void {
  const incoming = prefs as Partial<DesktopNativePrefs> & { window_mode?: unknown };
  const { window_mode: nativeWindowMode, ...rest } = incoming;
  // A key the caller left out means "unchanged", not "clear it". The boot sync
  // hands the native snapshot in whole, and the native side does not know every
  // frontend-owned key; spreading it verbatim would erase the ones it omits.
  const defined = Object.fromEntries(
    Object.entries(rest).filter(([, entry]) => entry !== undefined),
  ) as Partial<DesktopNativePrefs>;
  const next: DesktopNativePrefs = {
    ...readDesktopPrefs(),
    ...defined,
    ...(defined.windowMode === undefined && nativeWindowMode !== undefined ? { windowMode: parseSpaceWindowMode(nativeWindowMode) } : {}),
  };
  try {
    localStorage.setItem(DESKTOP_PREFS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

export function readRestartRequirement(): RestartRequirement {
  const stored = readObject(RESTART_REQUIRED_KEY, spaceStorage);
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
    spaceStorage.setItem(RESTART_REQUIRED_KEY, JSON.stringify(next));
  } catch {
    // The UI still keeps the returned in-memory state for this visit.
  }
  return publishRestartRequirement(next);
}

export function clearRestartRequirement(): RestartRequirement {
  const next: RestartRequirement = { required: false, changedAt: undefined, fields: [] };
  try {
    spaceStorage.removeItem(RESTART_REQUIRED_KEY);
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
  permission?: PatchConfigRequest['permission'];
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
  // Hooks left this editor in the batch-3 split: they only enter through the
  // Automation leaf's parseHooksJson, so a pasted `hooks` key is rejected as
  // an unsupported field like any other unknown domain.
  const allowed = new Set(['permission', 'loop_control', 'background']);
  const unknownKeys = Object.keys(source).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new LocalizedError({ key: 'val.advancedUnknown', params: { fields: unknownKeys.join(', ') } });
  }
  if (Object.keys(source).length === 0) {
    throw new LocalizedError({ key: 'val.advancedEmpty' });
  }
  const permission = source['permission'] === undefined ? undefined
    : permissionConfigPatchSchema.safeParse(source['permission']);
  if (permission !== undefined && !permission.success) {
    throw new LocalizedError({ key: 'val.advancedObject' });
  }
  return {
    permission: permission?.data,
    loop_control: source['loop_control'],
    background: source['background'],
  };
}

export const HOOK_EVENTS = LEGACY_HOOK_EVENTS;
export type SettingsHook = LegacyHookConfig;

/** Validates the complete legacy or v2 config value without loading files or running hooks. */
export function hooksConfigPatch(hooks: unknown): { hooks: HooksConfig } {
  const result = hooksConfigSchema.safeParse(hooks);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new LocalizedError({ key: 'st.hooks.configInvalid', params: {
      field: issue?.path.join('.') || 'hooks', message: issue?.message ?? 'Invalid input',
    } });
  }
  return { hooks: result.data };
}

/** Parses both config shapes; use Array.isArray to choose the editor. */
export function parseHooksConfigJson(value: string): HooksConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new LocalizedError({ key: 'val.advancedJson' });
  }
  return hooksConfigPatch(parsed).hooks;
}

/** Legacy-only form adapter. Use parseHooksConfigJson for a full config editor. */
export function parseHooksJson(value: string): SettingsHook[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new LocalizedError({ key: 'val.advancedJson' });
  }
  if (!Array.isArray(parsed)) {
    throw new LocalizedError({ key: 'val.advancedHooks' });
  }
  for (const [index, value] of parsed.entries()) {
    const fail = (field: string): never => { throw new LocalizedError({ key: 'st.hooks.invalid', params: { rule: index + 1, field } }); };
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('rule');
    const hook = value as Record<string, unknown>;
    const unknown = Object.keys(hook).find((key) => !['event', 'command', 'matcher', 'timeout'].includes(key));
    if (unknown !== undefined) fail(unknown);
    if (!HOOK_EVENTS.includes(hook['event'] as SettingsHook['event'])) fail('event');
    if (typeof hook['command'] !== 'string' || hook['command'].length === 0) fail('command');
    if (hook['matcher'] !== undefined) {
      if (typeof hook['matcher'] !== 'string') fail('matcher');
      try { void new RegExp(hook['matcher'] as string); } catch { fail('matcher'); }
    }
    if (hook['timeout'] !== undefined && (typeof hook['timeout'] !== 'number' || !Number.isInteger(hook['timeout']) || hook['timeout'] < 1 || hook['timeout'] > 600)) fail('timeout');
  }
  return parsed as SettingsHook[];
}

/**
 * Narrow MCP timeout patch for the MCP settings card (redesign §8.3): the
 * `replace_domains` scope stays `['mcp']` so saving timeouts never rewrites
 * the other engine domains. This is the only writer of the `mcp` domain.
 */
export function mcpTimeoutsPatch(startupTimeoutMs: string, toolTimeoutMs: string): KikiConfigPatch {
  const mcpMax = 2_147_483_647;
  return {
    mcp: {
      startup_timeout_ms: parseOptionalInteger(startupTimeoutMs, 'mcp.startup_timeout_ms', 1, mcpMax),
      tool_timeout_ms: parseOptionalInteger(toolTimeoutMs, 'mcp.tool_timeout_ms', 1, mcpMax),
    },
    replace_domains: ['mcp'],
  };
}

/**
 * Narrow plugins-domain patch for the marketplace source field. An empty
 * draft clears the saved URL so the server stops fetching a remote catalog.
 */
export function marketplaceUrlPatch(url: string): KikiConfigPatch {
  const trimmed = url.trim();
  return {
    plugins: { marketplace_url: trimmed.length === 0 ? undefined : trimmed },
    replace_domains: ['plugins'],
  };
}

/** An empty model disables all AI title requests. */
export function sessionTitleModelPatch(model: string): KikiConfigPatch {
  const trimmed = model.trim();
  return {
    session_title: { model: trimmed.length === 0 ? undefined : trimmed },
    replace_domains: ['session_title'],
  };
}

export const SESSION_TITLE_TRIGGERS: readonly SessionTitleTrigger[] = [
  'first_user_message', 'first_turn_completed', 'context_compacted',
];

/** Replaces only the title settings; an empty trigger set disables automatic generation. */
export function sessionTitleSettingsPatch(model: string, triggers: readonly SessionTitleTrigger[]): KikiConfigPatch {
  const patch = sessionTitleModelPatch(model);
  return { ...patch, session_title: { ...patch.session_title, triggers: [...new Set(triggers)] } };
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
  agentsNotifyParent: boolean;
  workspaceIdleTtlMs: string;
  imageMaxEdgePx: string;
  imageReadByteBudget: string;
  task: {
    maxRunningTasks: string;
    keepAliveOnExit: boolean;
    bashAutoBackgroundOnTimeout: boolean;
    bashFileToolHints: boolean;
    bashTaskTimeoutS: string;
    killGracePeriodMs: string;
    printWaitCeilingS: string;
    printBackgroundMode: PrintBackgroundMode;
    printMaxTurns: string;
  };
  identityName: string;
  identitySlug: string;
  advertiseAsKimiCode: boolean;
  extraAgentDirs: string[];
  disabledNamedProfiles: string[];
  skipBuiltinProfileInstallation: string[];
  sessionTitleModel: string;
  sessionTitleTriggers: SessionTitleTrigger[];
}

function optionalNumberDraft(value: number | null | undefined): string {
  return value === null ? 'null' : value === undefined ? '' : String(value);
}

/**
 * Shared projection of the engine runtime config fields into editable drafts.
 * After the runtime-leaf split each owning card (task policy under Tasks,
 * resource limits under Advanced, thread/notify/token policy under Agent
 * communication, identity under Agents) reads the fields it edits and saves
 * through its own narrow patch helper; cron stays read-only display data.
 */
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
    agentsNotifyParent: config.agents?.notify_parent !== false,
    workspaceIdleTtlMs: optionalNumberDraft(config.workspace_instance?.idleTtlMs ?? 300_000),
    imageMaxEdgePx: optionalNumberDraft(config.image?.maxEdgePx),
    imageReadByteBudget: optionalNumberDraft(config.image?.readByteBudget),
    task: {
      maxRunningTasks: optionalNumberDraft(task?.maxRunningTasks),
      keepAliveOnExit: task?.keepAliveOnExit ?? false,
      bashAutoBackgroundOnTimeout: task?.bashAutoBackgroundOnTimeout ?? true,
      bashFileToolHints: task?.bashFileToolHints ?? true,
      bashTaskTimeoutS: optionalNumberDraft(task?.bashTaskTimeoutS),
      killGracePeriodMs: optionalNumberDraft(task?.killGracePeriodMs),
      printWaitCeilingS: optionalNumberDraft(task?.printWaitCeilingS),
      printBackgroundMode: task?.printBackgroundMode ?? (task?.keepAliveOnExit === true ? 'drain' : 'steer'),
      printMaxTurns: optionalNumberDraft(task?.printMaxTurns),
    },
    identityName: config.identity?.name ?? '',
    identitySlug: config.identity?.slug ?? '',
    advertiseAsKimiCode: config.identity?.advertiseAsKimiCode ?? false,
    extraAgentDirs: normalizeConfigStringList(config.extra_agent_dirs),
    disabledNamedProfiles: normalizeConfigStringList(config.disabled_named_profiles),
    skipBuiltinProfileInstallation: normalizeConfigStringList(config.skip_builtin_profile_installation),
    sessionTitleModel: config.session_title?.model ?? '',
    sessionTitleTriggers: [...(config.session_title?.triggers ?? ['first_turn_completed'])],
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

/**
 * The tasks leaf's background-task policy card (runtime split): only the
 * `task` domain, so a save can never roll back the resource-limit or
 * communication domains edited on other leaves from a stale draft. cron is
 * env-driven (KIKI_CRON_*) and intentionally never persisted — its card is
 * read-only, so no patch emits it.
 */
export function taskRuntimePatch(draft: RuntimeConfigDraft['task']): KikiConfigPatch {
  return {
    task: {
      max_running_tasks: parseOptionalInteger(draft.maxRunningTasks, 'task.max_running_tasks', 1),
      keep_alive_on_exit: draft.keepAliveOnExit,
      bash_auto_background_on_timeout: draft.bashAutoBackgroundOnTimeout,
      bash_file_tool_hints: draft.bashFileToolHints,
      bash_task_timeout_s: parseOptionalInteger(draft.bashTaskTimeoutS, 'task.bash_task_timeout_s', 0),
      kill_grace_period_ms: parseOptionalInteger(draft.killGracePeriodMs, 'task.kill_grace_period_ms', 0),
      print_wait_ceiling_s: parseOptionalInteger(draft.printWaitCeilingS, 'task.print_wait_ceiling_s', 1),
      print_background_mode: draft.printBackgroundMode,
      print_max_turns: parseOptionalInteger(draft.printMaxTurns, 'task.print_max_turns', 1),
    },
    replace_domains: ['task'],
  };
}

/** The advanced leaf's workspace/image resource ceilings (runtime split). */
export function resourceLimitPatch(
  draft: Pick<RuntimeConfigDraft, 'workspaceIdleTtlMs' | 'imageMaxEdgePx' | 'imageReadByteBudget'>,
): KikiConfigPatch {
  return {
    workspace_instance: {
      idle_ttl_ms: parseOptionalInteger(draft.workspaceIdleTtlMs, 'workspace_instance.idle_ttl_ms', 0),
    },
    image: {
      max_edge_px: parseOptionalInteger(draft.imageMaxEdgePx, 'image.max_edge_px', 1),
      read_byte_budget: parseOptionalInteger(draft.imageReadByteBudget, 'image.read_byte_budget', 1),
    },
    replace_domains: ['workspace_instance', 'image'],
  };
}

/** The communication leaf's thread communication patch. */
export function threadCommunicationPatch(enabled: boolean): KikiConfigPatch {
  return {
    thread_communication: { enabled },
    replace_domains: ['thread_communication'],
  };
}

/** The communication leaf's token counting strategy patch. */
export function tokenCountingPatch(strategy: TokenCountingStrategy): KikiConfigPatch {
  return {
    token_counting: { strategy },
    replace_domains: ['token_counting'],
  };
}

/** The communication leaf's agent parent notification patch. */
export function agentNotifyParentPatch(notifyParent: boolean): KikiConfigPatch {
  return {
    agents: { notify_parent: notifyParent },
  };
}

/**
 * The agents leaf's identity and profile-loading card (runtime split): the
 * server-facing identity plus which agent-profile sources load at startup.
 * The mcp and tools domains are likewise absent here and above: the MCP
 * timeouts card (mcpTimeoutsPatch) and the automation leaf's tool policy card
 * (toolPolicyPatch) own them, so a save from any of these cards can never roll
 * back values edited on another leaf from a stale draft.
 */
export function agentIdentityPatch(
  draft: Pick<
    RuntimeConfigDraft,
    'identityName' | 'identitySlug' | 'advertiseAsKimiCode' | 'extraAgentDirs' | 'disabledNamedProfiles'
  >,
): KikiConfigPatch {
  return {
    identity: {
      name: draft.identityName.trim() || undefined,
      slug: draft.identitySlug.trim() || undefined,
      advertise_as_kimi_code: draft.advertiseAsKimiCode,
    },
    extra_agent_dirs: normalizeStringList(draft.extraAgentDirs),
    disabled_named_profiles: normalizeStringList(draft.disabledNamedProfiles),
    replace_domains: ['identity', 'extra_agent_dirs', 'disabled_named_profiles'],
  };
}

/** The automation leaf's tool-policy draft: just the two lists it edits. */
export interface ToolPolicyDraft {
  toolsEnabled: string[];
  toolsDisabled: string[];
}

export function toolPolicyDraftFromConfig(value: unknown): ToolPolicyDraft {
  const config = configObjectOrEmpty(value) as unknown as KikiConfigResponse;
  return {
    toolsEnabled: normalizeConfigStringList(config.tools?.enabled),
    toolsDisabled: normalizeConfigStringList(config.tools?.disabled),
  };
}

/**
 * Narrow tool-policy patch (redesign §8.3): `replace_domains` stays
 * `['tools']` so saving the policy never rewrites the engine domains the
 * tasks/advanced/agents cards own.
 */
export function toolPolicyPatch(draft: ToolPolicyDraft): KikiConfigPatch {
  return {
    tools: {
      enabled: normalizeStringList(draft.toolsEnabled),
      disabled: normalizeStringList(draft.toolsDisabled),
    },
    replace_domains: ['tools'],
  };
}

export function toolPolicyValue(draft: ToolPolicyDraft, toolName: string): 'enabled' | 'disabled' | 'inherited' {
  if (draft.toolsDisabled.includes(toolName)) return 'disabled';
  if (draft.toolsEnabled.includes(toolName)) return 'enabled';
  return 'inherited';
}

export function setToolPolicy(
  draft: ToolPolicyDraft,
  toolName: string,
  policy: 'enabled' | 'disabled' | 'inherited',
): ToolPolicyDraft {
  const enabled = draft.toolsEnabled.filter((name) => name !== toolName);
  const disabled = draft.toolsDisabled.filter((name) => name !== toolName);
  if (policy === 'enabled') enabled.push(toolName);
  if (policy === 'disabled') disabled.push(toolName);
  return { ...draft, toolsEnabled: enabled, toolsDisabled: disabled };
}

export function validateDesktopConfigDraft(input: {
  subagentTimeoutMs: number;
}): ValidationIssue | null {
  if (!Number.isInteger(input.subagentTimeoutMs) || input.subagentTimeoutMs < 0) {
    return { key: 'val.timeoutWhole' };
  }
  if (input.subagentTimeoutMs > 86_400_000) {
    return { key: 'val.timeoutMax' };
  }
  return null;
}

export function requestIdentityLayerDraftFromPolicy(
  policy: RequestIdentityPolicyWire | undefined,
): RequestIdentityLayerDraft {
  return {
    requestIdentityChoice:
      policy?.preset
      ?? (policy?.profile === undefined ? undefined : requestIdentityProfileChoice(policy.profile))
      ?? (policy?.overrides === undefined ? 'inherit' : 'custom_overrides'),
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
    profile: requestIdentityChoiceProfile(draft.requestIdentityChoice),
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

export function imagePolicyDraftFromWire(
  policy: ImagePolicyWire | undefined,
): ImagePolicyDraft {
  return {
    imageAcceptedTypes: policy?.accepted_types === undefined ? null : [...policy.accepted_types],
    imageConvertUnsupported: policy?.convert_unsupported ?? null,
  };
}

function parsedImageTypes(values: readonly string[]): NonNullable<ImagePolicyWire['accepted_types']> {
  const parsed: NonNullable<ImagePolicyWire['accepted_types']> = [];
  for (const value of normalizeTags(values)) {
    const result = imageMimeSchema.safeParse(value);
    if (!result.success) throw new LocalizedError({ key: 'val.imageMime', params: { mime: value } });
    if (!parsed.includes(result.data)) parsed.push(result.data);
  }
  return parsed;
}

export function imagePolicyFromDraft(draft: ImagePolicyDraft): ImagePolicyWire | undefined {
  if (draft.imageAcceptedTypes === null && draft.imageConvertUnsupported === null) return undefined;
  const acceptedTypes = draft.imageAcceptedTypes === null
    ? undefined
    : parsedImageTypes(draft.imageAcceptedTypes);
  if (acceptedTypes !== undefined && acceptedTypes.length === 0) {
    throw new LocalizedError({ key: 'val.imageAcceptedTypesEmpty' });
  }
  return {
    accepted_types: acceptedTypes,
    convert_unsupported: draft.imageConvertUnsupported ?? undefined,
  };
}

export function imagePolicyPatchFromDraft(
  draft: ImagePolicyDraft,
  baseline: ImagePolicyDraft,
): ImagePolicyPatch | null | undefined {
  const acceptedChanged = !nullableStringArraysEqual(
    draft.imageAcceptedTypes,
    baseline.imageAcceptedTypes,
  );
  const conversionChanged = draft.imageConvertUnsupported !== baseline.imageConvertUnsupported;
  if (!acceptedChanged && !conversionChanged) return undefined;
  if (draft.imageAcceptedTypes === null && draft.imageConvertUnsupported === null) return null;
  return {
    accepted_types: acceptedChanged
      ? (draft.imageAcceptedTypes === null ? null : parsedImageTypes(draft.imageAcceptedTypes))
      : undefined,
    convert_unsupported: conversionChanged ? draft.imageConvertUnsupported : undefined,
  };
}

export function validateImagePolicyDraft(
  draft: ImagePolicyDraft,
  inheritedAcceptedTypes?: readonly string[] | null,
): ValidationIssue | null {
  let authoredAccepted: readonly string[] | null = null;
  try {
    authoredAccepted = draft.imageAcceptedTypes === null
      ? null
      : parsedImageTypes(draft.imageAcceptedTypes);
  } catch (error) {
    return error instanceof LocalizedError ? error.issue : { key: 'val.imageMime', params: { mime: '' } };
  }
  if (authoredAccepted !== null && authoredAccepted.length === 0) {
    return { key: 'val.imageAcceptedTypesEmpty' };
  }
  const accepted = authoredAccepted ?? inheritedAcceptedTypes;
  if (accepted === undefined || accepted === null || draft.imageConvertUnsupported === null) return null;
  if (draft.imageConvertUnsupported === 'png' && !accepted.includes('image/png')) {
    return { key: 'val.imageConversionTarget', params: { mime: 'image/png' } };
  }
  if (draft.imageConvertUnsupported === 'jpeg' && !accepted.includes('image/jpeg')) {
    return { key: 'val.imageConversionTarget', params: { mime: 'image/jpeg' } };
  }
  if (
    draft.imageConvertUnsupported === 'auto'
    && !accepted.includes('image/png')
    && !accepted.includes('image/jpeg')
  ) {
    return { key: 'val.imageAutoTarget' };
  }
  return null;
}

export function providerModelDraftFromCatalog(
  model: ModelCatalogItem | GetModelResponse,
): ProviderModelDraft {
  return {
    id: model.id,
    remoteId: model.remote_id ?? '',
    maxContextSize: model.max_context_size ?? 0,
    autoCompact: model.auto_compact,
    displayName: model.display_name ?? '',
    capabilities: [...(model.capabilities ?? [])],
    supportEfforts: [...(model.support_efforts ?? [])],
    behavior: model.behavior,
    ...requestIdentityLayerDraftFromPolicy(model.request_identity),
    ...imagePolicyDraftFromWire(model.images),
  };
}

export function providerDraftFromCatalog(
  provider: ProviderCatalogItem,
  models: readonly ModelCatalogItem[],
): ProviderDraft | null {
  if (!isProviderWireType(provider.type)) return null;
  const providerModels = models
    .filter((model) => model.provider_id === provider.id)
    .map(providerModelDraftFromCatalog);
  return {
    id: provider.id,
    type: provider.type,
    baseUrl: provider.base_url ?? '',
    defaultModel: provider.default_model ?? '',
    apiKey: provider.api_key ?? '',
    clearApiKey: false,
    ...requestIdentityLayerDraftFromPolicy(provider.request_identity),
    ...imagePolicyDraftFromWire(provider.images),
    models: providerModels,
  };
}

/**
 * The row the starred default points at: its local alias when the row is
 * stored, its remote id for a row of a not-yet-saved connection.
 */
export function providerDefaultRow(draft: ProviderDraft): ProviderModelDraft | undefined {
  return (
    draft.models.find((model) => model.id !== '' && model.id === draft.defaultModel)
    ?? draft.models.find((model) => model.remoteId === draft.defaultModel)
  );
}

function requestIdentityDraftChanged(
  draft: RequestIdentityLayerDraft,
  baseline: RequestIdentityLayerDraft | undefined,
): boolean {
  return baseline === undefined
    || draft.requestIdentityChoice !== baseline.requestIdentityChoice
    || draft.requestIdentityOverridesJson !== baseline.requestIdentityOverridesJson;
}

/** Validate creation in full, or only authored fields when saving a sparse patch. */
export function validateProviderDraft(
  draft: ProviderDraft,
  baseline?: ProviderDraft,
): ValidationIssue | null {
  if ((baseline === undefined || draft.type !== baseline.type) && !isProviderWireType(draft.type)) {
    return { key: 'val.providerProtocol' };
  }
  if (requestIdentityDraftChanged(draft, baseline)) {
    const issue = validateRequestIdentityLayerDraft(draft);
    if (issue !== null) return issue;
  }
  if (baseline === undefined || !imagePolicyDraftsEqual(draft, baseline)) {
    const issue = validateImagePolicyDraft(draft);
    if (issue !== null) return issue;
  }
  if (draft.baseUrl !== '' && (baseline === undefined || draft.baseUrl !== baseline.baseUrl)) {
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
  if (!draft.clearApiKey && (draft.apiKey.includes('\n') || draft.apiKey.includes('\r'))) {
    return { key: 'val.apiKeyLineBreaks' };
  }
  const seen = new Set<string>();
  for (const model of draft.models) {
    const label = model.id || model.remoteId || '(unnamed)';
    const stored = model.id !== '';
    const previous = stored ? baseline?.models.find((row) => row.id === model.id) : undefined;
    if ((previous === undefined || model.remoteId !== previous.remoteId) && model.remoteId.trim() === '') {
      return { key: 'val.modelIdEmpty' };
    }
    const unconfiguredSize = model.maxContextSize === 0;
    if (
      (previous === undefined || model.maxContextSize !== previous.maxContextSize)
      && (!stored || !unconfiguredSize)
      && (!Number.isInteger(model.maxContextSize) || model.maxContextSize < 1)
    ) {
      return { key: 'val.modelContextSize', params: { model: label } };
    }
    if (requestIdentityDraftChanged(model, previous)) {
      const issue = validateRequestIdentityLayerDraft(model);
      if (issue !== null) return { key: 'val.modelRequestIdentity', params: { model: label } };
    }
    if (previous === undefined || !imagePolicyDraftsEqual(model, previous)) {
      const issue = validateImagePolicyDraft(model, draft.imageAcceptedTypes);
      if (issue !== null) return issue;
    }
    const key = stored ? model.id : `${draft.id}/${model.remoteId}`;
    if (seen.has(key)) return { key: 'val.modelDuplicate', params: { model: label } };
    seen.add(key);
  }
  if (
    (baseline === undefined || draft.defaultModel !== baseline.defaultModel)
    && draft.defaultModel !== '' && providerDefaultRow(draft) === undefined
  ) {
    return { key: 'val.defaultModelInModels' };
  }
  return null;
}

export function validateNewProviderDraft(draft: ProviderDraft): ValidationIssue | null {
  if (!providerIdSchema.safeParse(draft.id).success) return { key: 'val.providerId' };
  return validateProviderDraft(draft);
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

/** Known enum chips; the chip editor also accepts free-form custom values.
 *  Capability names mirror the engine vocabulary (kosong model inspection):
 *  offering names the runtime never reads only produces dead metadata. */
export const KNOWN_CAPABILITIES = [
  'thinking',
  'always_thinking',
  'tool_use',
  'image_in',
  'video_in',
  'audio_in',
  'dynamically_loaded_tools',
] as const;
export const KNOWN_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

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

function nullableStringArraysEqual(
  a: readonly string[] | null,
  b: readonly string[] | null,
): boolean {
  return a === null || b === null ? a === b : stringArraysEqual(a, b);
}

function imagePolicyDraftsEqual(a: ImagePolicyDraft, b: ImagePolicyDraft): boolean {
  return nullableStringArraysEqual(a.imageAcceptedTypes, b.imageAcceptedTypes)
    && a.imageConvertUnsupported === b.imageConvertUnsupported;
}

export function providerModelDraftsEqual(
  model: ProviderModelDraft,
  other: ProviderModelDraft,
): boolean {
  return model.id === other.id
    && model.remoteId === other.remoteId
    && model.maxContextSize === other.maxContextSize
    && model.autoCompact === other.autoCompact
    && model.displayName === other.displayName
    && JSON.stringify(model.behavior) === JSON.stringify(other.behavior)
    && model.requestIdentityChoice === other.requestIdentityChoice
    && model.requestIdentityOverridesJson === other.requestIdentityOverridesJson
    && imagePolicyDraftsEqual(model, other)
    && stringArraysEqual(model.capabilities, other.capabilities)
    && stringArraysEqual(model.supportEfforts, other.supportEfforts);
}

/** Deep field equality for "unsaved changes" badges and leave-section guards. */
export function providerDraftsEqual(a: ProviderDraft, b: ProviderDraft): boolean {
  if (a.id !== b.id || a.type !== b.type || a.baseUrl !== b.baseUrl) return false;
  if (a.defaultModel !== b.defaultModel || a.apiKey !== b.apiKey) return false;
  if (a.clearApiKey !== b.clearApiKey) return false;
  if (a.requestIdentityChoice !== b.requestIdentityChoice) return false;
  if (a.requestIdentityOverridesJson !== b.requestIdentityOverridesJson) return false;
  if (!imagePolicyDraftsEqual(a, b)) return false;
  if (a.models.length !== b.models.length) return false;
  return a.models.every((model, index) => {
    const other = b.models[index];
    return other !== undefined && providerModelDraftsEqual(model, other);
  });
}

export function isProviderDraftDirty(draft: ProviderDraft, initial: ProviderDraft): boolean {
  return !providerDraftsEqual(draft, initial);
}

// ---- draft ⇄ wire mapping (the one place a form becomes a request body) ----

/**
 * Wire body for creating a connection (`POST /providers`). The request
 * identity is omitted when the draft inherits it, so the server keeps the
 * authored layer absent rather than recording an explicit null. The server
 * writes each listed model as the `${id}/${remote_id}` alias; `default_model`
 * names the upstream half of the starred row, which is what the create
 * contract expects.
 */
export function providerCreateBody(draft: ProviderDraft): CreateProviderRequest {
  const requestIdentity = requestIdentityPolicyFromDraft(draft);
  const images = imagePolicyFromDraft(draft);
  const defaultRow = providerDefaultRow(draft);
  return {
    id: draft.id,
    type: draft.type,
    api_key: draft.clearApiKey ? '' : draft.apiKey || undefined,
    base_url: draft.baseUrl.trim() || undefined,
    default_model: defaultRow?.remoteId,
    request_identity: requestIdentity,
    images,
    models: draft.models.map((model) => {
      const modelIdentity = requestIdentityPolicyFromDraft(model);
      const modelImages = imagePolicyFromDraft(model);
      return {
        remote_id: model.remoteId,
        max_context_size: model.maxContextSize > 0 ? model.maxContextSize : undefined,
        auto_compact: model.autoCompact,
        display_name: model.displayName || undefined,
        capabilities: model.capabilities.length > 0 ? [...model.capabilities] : undefined,
        support_efforts: model.supportEfforts.length > 0 ? [...model.supportEfforts] : undefined,
        request_identity: modelIdentity,
        behavior: model.behavior,
        images: modelImages,
      };
    }),
  };
}

/**
 * Sparse connection patch: only the fields the user actually changed leave
 * this function, so saving a connection can no longer rewrite (or drop) the
 * models it does not mention. `null` clears, absent keeps. Returns `null` when
 * nothing changed.
 */
export function providerPatchBody(
  draft: ProviderDraft,
  baseline: ProviderDraft,
): PatchProviderRequest | null {
  const patch: PatchProviderRequest = {};
  if (draft.type !== baseline.type) patch.type = draft.type;
  if (draft.baseUrl !== baseline.baseUrl) patch.base_url = draft.baseUrl.trim() || null;
  if (draft.defaultModel !== baseline.defaultModel) {
    patch.default_model = providerDefaultRow(draft)?.id || null;
  }
  if (
    draft.requestIdentityChoice !== baseline.requestIdentityChoice
    || draft.requestIdentityOverridesJson !== baseline.requestIdentityOverridesJson
  ) {
    patch.request_identity = requestIdentityPolicyFromDraft(draft) ?? null;
  }
  const imagePatch = imagePolicyPatchFromDraft(draft, baseline);
  if (imagePatch !== undefined) patch.images = imagePatch;
  if (draft.clearApiKey) {
    patch.api_key = '';
  } else if (draft.apiKey !== baseline.apiKey) {
    patch.api_key = draft.apiKey;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

/** Sparse local-model patch for one stored row; `null` when nothing changed. */
export function modelPatchBody(
  draft: ProviderModelDraft,
  baseline: ProviderModelDraft,
): PatchModelRequest | null {
  const patch: PatchModelRequest = {};
  if (draft.remoteId !== baseline.remoteId && draft.remoteId.trim() !== '') {
    patch.remote_id = draft.remoteId.trim();
  }
  if (draft.displayName !== baseline.displayName) {
    patch.display_name = draft.displayName.trim() || null;
  }
  if (draft.maxContextSize !== baseline.maxContextSize) {
    patch.max_context_size = draft.maxContextSize > 0 ? draft.maxContextSize : null;
  }
  if (draft.autoCompact !== baseline.autoCompact) {
    patch.auto_compact = draft.autoCompact ?? null;
  }
  if (!stringArraysEqual(draft.capabilities, baseline.capabilities)) {
    patch.capabilities = [...draft.capabilities];
  }
  if (!stringArraysEqual(draft.supportEfforts, baseline.supportEfforts)) {
    patch.support_efforts = [...draft.supportEfforts];
  }
  if (
    draft.requestIdentityChoice !== baseline.requestIdentityChoice
    || draft.requestIdentityOverridesJson !== baseline.requestIdentityOverridesJson
  ) {
    patch.request_identity = requestIdentityPolicyFromDraft(draft) ?? null;
  }
  const imagePatch = imagePolicyPatchFromDraft(draft, baseline);
  if (imagePatch !== undefined) patch.images = imagePatch;
  const behaviorPatch = questionGuardModelPatch(questionGuardDraftFromBehavior(draft.behavior), questionGuardDraftFromBehavior(baseline.behavior));
  if (behaviorPatch !== undefined) patch.behavior = behaviorPatch;
  return Object.keys(patch).length === 0 ? null : patch;
}

/** Wire body for creating one local model row (`POST /models`). */
export function modelCreateBody(
  providerId: string,
  row: ProviderModelDraft,
): CreateModelRequest {
  const requestIdentity = requestIdentityPolicyFromDraft(row);
  const images = imagePolicyFromDraft(row);
  return {
    id: row.id !== '' && row.id !== `${providerId}/${row.remoteId}` ? row.id : undefined,
    provider_id: providerId,
    remote_id: row.remoteId.trim(),
    display_name: row.displayName.trim() || undefined,
    max_context_size: row.maxContextSize > 0 ? row.maxContextSize : undefined,
    auto_compact: row.autoCompact,
    capabilities: row.capabilities.length > 0 ? [...row.capabilities] : undefined,
    support_efforts: row.supportEfforts.length > 0 ? [...row.supportEfforts] : undefined,
    behavior: row.behavior,
    request_identity: requestIdentity,
    images,
  };
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
  if (/[\u0000-\u001F\u007F]/.test(key)) throw new LocalizedError({ key: 'val.apiKeyLineBreaks' });
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

  const headers = remoteModelsHeaders(probe.type, probe.apiKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(); }, 15_000);
  let payload: unknown;
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    try { payload = await response.json(); }
    catch { throw new LocalizedError({ key: 'val.remoteModelsShape' }); }
  } catch (error) {
    if (error instanceof LocalizedError) throw error;
    const status = error instanceof Error ? /^HTTP (\d+)$/.exec(error.message)?.[1] : undefined;
    if (status !== undefined) {
      throw new Error(
        status === '401' || status === '403'
          ? `Model probe credentials were rejected (HTTP ${status}).`
          : status === '404'
            ? 'Model probe endpoint was not found (HTTP 404).'
            : `Model probe request failed (HTTP ${status}).`,
        { cause: error },
      );
    }
    const timedOut = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
    const safeCause = new Error(timedOut ? 'Request timed out.' : 'Fetch failed (network or browser CORS).');
    safeCause.name = timedOut ? 'AbortError' : error instanceof TypeError ? 'TypeError' : 'NetworkError';
    throw new Error(timedOut
      ? 'Model probe timed out after 15000ms.'
      : 'Could not reach the model endpoint. Check the network or browser CORS settings.',
    { cause: safeCause });
  } finally {
    clearTimeout(timeout);
  }
  const ids = parseRemoteModels(payload);
  if (ids.length === 0) throw new LocalizedError({ key: 'val.remoteModelsEmpty' });
  const contextSize = providerTemplateFor(probe.type).defaultContextSize;
  return ids.map((id) => ({
    id: '',
    remoteId: id,
    maxContextSize: contextSize,
    displayName: '',
    capabilities: [],
    supportEfforts: [],
    requestIdentityChoice: 'inherit',
    requestIdentityOverridesJson: '',
    imageAcceptedTypes: null,
    imageConvertUnsupported: null,
  }));
}

// ---- models & providers merged entry (settings redesign batch 2) ----

/**
 * The "Models & providers" entry is one navigation leaf with three stable
 * tabs (redesign §3.3 / §7.1): the domain objects stay distinct — Provider
 * owns credentials and lifecycle, Model owns catalog and metadata, Defaults
 * owns new-session choices — but first-run and daily model switching are one
 * continuous path, so they share an entry instead of two parallel pages.
 * Tab ids double as the `?tab=` deep-link parameter.
 */
export const AI_SETTINGS_TABS = ['providers', 'models', 'defaults'] as const;
export type AiSettingsTab = (typeof AI_SETTINGS_TABS)[number];

/** Bare `/settings/ai` opens the daily-driver tab: browsing and switching models. */
export const AI_SETTINGS_DEFAULT_TAB: AiSettingsTab = 'models';

const AI_TAB_BY_CARD: Readonly<Record<string, AiSettingsTab>> = {
  'st-card-auth': 'providers',
  'st-card-providers': 'providers',
  'st-card-providers-add': 'providers',
  'st-card-engines': 'providers',
  'st-card-catalog-import': 'providers',
  'st-card-models': 'models',
  'st-card-catalog-refresh': 'models',
  'st-card-model-migration': 'models',
  'st-card-global-defaults': 'defaults',
  'st-card-model-switch': 'defaults',
  'st-card-thinking': 'defaults',
  'st-card-auto-compact': 'defaults',
  'st-card-loop-limits': 'defaults',
  'st-card-exp-ai': 'defaults',
};

export function aiTabForCard(cardId: string): AiSettingsTab | undefined {
  return AI_TAB_BY_CARD[cardId];
}

/** Parse the `?tab=` query; unknown values fall through to the default tab. */
export function normalizeAiTab(value: string | null | undefined): AiSettingsTab | undefined {
  return AI_SETTINGS_TABS.find((tab) => tab === value);
}

export function aiTabLabelKey(tab: AiSettingsTab): I18nKey {
  return `st.ai.tab.${tab}` as I18nKey;
}

/**
 * Sub-pages of the "Search & retrieval" leaf. The ids double as its `?tab=`
 * deep-link parameter and are the tabs the page itself mounts; the page maps a
 * `#st-card-search-*` anchor to its tab, so a search hit and a card hash stay
 * two spellings of the same target.
 */
export const SEARCH_SETTINGS_TABS = ['overview', 'search', 'fetch', 'providers', 'advanced'] as const;
export type SearchSettingsTab = (typeof SEARCH_SETTINGS_TABS)[number];

/** Tab id inside a tabbed settings section; `ai` and `search` own tabs today. */
export type SettingsTab = AiSettingsTab | SearchSettingsTab;

/** Card → sub-page for the search leaf, mirroring the page's tab mount table. */
const SEARCH_TAB_BY_CARD: Readonly<Record<string, SearchSettingsTab>> = {
  'st-card-search-status': 'overview',
  'st-card-search-source': 'overview',
  'st-card-search-defaults': 'search',
  'st-card-search-fetch': 'fetch',
  'st-card-search-providers': 'providers',
  'st-card-search-execution': 'advanced',
  'st-card-search-index': 'advanced',
  'st-card-search-diagnostics': 'advanced',
  'st-card-exp-search': 'advanced',
};

export function searchTabForCard(cardId: string): SearchSettingsTab | undefined {
  return SEARCH_TAB_BY_CARD[cardId];
}

/** Label key of a tab inside a tabbed section; the section picks the family
 *  (`providers` exists as both an ai and a search tab). */
export function settingsTabLabelKey(section: string, tab: SettingsTab): I18nKey {
  return section === 'ai'
    ? aiTabLabelKey(tab as AiSettingsTab)
    : (`st.nbSearch.tab.${tab}` as I18nKey);
}

// ---- settings search index ----

export interface SettingsSearchSpecEntry {
  readonly section: string;
  /** DOM id the SectionCard renders so a result can scroll + flash it. */
  readonly cardId: string;
  /** Tab inside a tabbed section (`ai`, `search`); hits switch to it first so
   *  the card is mounted when the scroll + flash runs. */
  readonly tab?: SettingsTab;
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
  { id: 'appearance', labelKey: 'st.section.appearance' },
  { id: 'shortcuts', labelKey: 'st.section.shortcuts' },
  { id: 'connection', labelKey: 'st.section.connection' },
  { id: 'ssh', labelKey: 'st.section.ssh' },
  { id: 'ai', labelKey: 'st.section.ai' },
  { id: 'identity', labelKey: 'st.section.identity' },
  { id: 'agents', labelKey: 'st.section.agents' },
  { id: 'subagents', labelKey: 'st.section.subagents' },
  { id: 'sessions', labelKey: 'st.section.sessions' },
  { id: 'notifications', labelKey: 'st.section.notifications' },
  { id: 'memory', labelKey: 'st.section.memory' },
  { id: 'permissions', labelKey: 'st.section.permissions' },
  { id: 'tasks', labelKey: 'st.section.tasks' },
  { id: 'skills', labelKey: 'st.section.skills' },
  { id: 'mcp', labelKey: 'st.section.mcp' },
  { id: 'plugins', labelKey: 'st.section.plugins' },
  { id: 'search', labelKey: 'st.section.search' },
  { id: 'browser-control', labelKey: 'st.section.browserControl' },
  { id: 'computer-control', labelKey: 'st.section.computerControl' },
  { id: 'hooks', labelKey: 'st.section.hooks' },
  { id: 'workspaces', labelKey: 'st.section.workspaces' },
  { id: 'spaces', labelKey: 'st.section.spaces' },
  { id: 'developer', labelKey: 'st.section.developer' },
  { id: 'labs', labelKey: 'st.section.labs' },
  { id: 'about', labelKey: 'st.section.about' },
];

// ---- grouped navigation (settings IA v2) ----

/**
 * Six intent groups in one list, ordered by what a person came to do: set up
 * the app itself, reach a server (this one, a remote host over SSH, or a
 * space), pick the brain (models, agents), decide how work runs and where it
 * lives (sessions, workspaces, permissions, tasks), extend what it can reach
 * (capabilities), and, last, the advanced pages (developer tools, the Labs
 * index, about). Experimental flags are switched on their feature's own page;
 * Labs only lists them.
 *
 * A group earns its place by answering one question. "Where work happens"
 * (workspaces) belongs beside the sessions that run in it, and "where Kiki
 * runs" (spaces, remote connections, inbound access) belongs beside the ways
 * of reaching a server, so neither needed a group of its own.
 */
export interface SettingsNavGroupSpec {
  readonly kind: 'group';
  readonly id: string;
  readonly labelKey: I18nKey;
  readonly sections: readonly string[];
}

export interface SettingsNavLeafSpec {
  readonly kind: 'leaf';
  readonly section: string;
}

export type SettingsNavNode = SettingsNavGroupSpec | SettingsNavLeafSpec;

export const SETTINGS_NAV_TREE: readonly SettingsNavNode[] = [
  { kind: 'group', id: 'device', labelKey: 'st.group.device', sections: ['general', 'appearance', 'shortcuts'] },
  { kind: 'group', id: 'connection', labelKey: 'st.group.connection', sections: ['connection', 'ssh', 'spaces'] },
  { kind: 'group', id: 'models-agents', labelKey: 'st.group.modelsAgents', sections: ['ai', 'identity', 'agents', 'subagents'] },
  { kind: 'group', id: 'work', labelKey: 'st.group.work', sections: ['sessions', 'workspaces', 'notifications', 'memory', 'permissions', 'tasks'] },
  { kind: 'group', id: 'capabilities', labelKey: 'st.group.capabilities', sections: ['skills', 'mcp', 'plugins', 'search', 'browser-control', 'computer-control', 'hooks'] },
  { kind: 'group', id: 'advanced', labelKey: 'st.group.advanced', sections: ['developer', 'labs', 'about'] },
];

/** Whether a section writes only to this device (its primary scope is the app). */
export function settingsSectionIsDeviceOnly(sectionId: string): boolean {
  return SETTINGS_SECTION_META[sectionId]?.scopes[0] === 'app';
}

export function settingsGroupForSection(sectionId: string): SettingsNavGroupSpec | undefined {
  return SETTINGS_NAV_TREE.find(
    (node): node is SettingsNavGroupSpec => node.kind === 'group' && node.sections.includes(sectionId),
  );
}

/**
 * Who a section's edits apply to. The primary scope sets what a card on the
 * page need not repeat; a card writing elsewhere carries its own quiet tag.
 * `workspace` marks pages whose editors can target one workspace through
 * their own picker.
 */
export type SettingsScope = 'app' | 'server' | 'workspace';

export interface SettingsSectionMeta {
  readonly scopes: readonly SettingsScope[];
  /** Orientation line under the title; omitted when a card title already says it. */
  readonly purposeKey?: I18nKey;
}

export const SETTINGS_SECTION_META: Readonly<Record<string, SettingsSectionMeta>> = {
  general: { scopes: ['app'], purposeKey: 'st.purpose.general' },
  appearance: { scopes: ['app'], purposeKey: 'st.purpose.appearance' },
  shortcuts: { scopes: ['app', 'server'], purposeKey: 'st.purpose.shortcuts' },
  connection: { scopes: ['app'], purposeKey: 'st.purpose.connection' },
  ai: { scopes: ['server'], purposeKey: 'st.purpose.ai' },
  identity: { scopes: ['server'], purposeKey: 'st.purpose.identity' },
  agents: { scopes: ['server', 'workspace'], purposeKey: 'st.purpose.agents' },
  subagents: { scopes: ['server', 'workspace'], purposeKey: 'st.purpose.subagents' },
  sessions: { scopes: ['server'], purposeKey: 'st.purpose.sessions' },
  notifications: { scopes: ['server'], purposeKey: 'st.purpose.notifications' },
  memory: { scopes: ['server', 'workspace'], purposeKey: 'st.purpose.memory' },
  permissions: { scopes: ['server'], purposeKey: 'st.purpose.permissions' },
  tasks: { scopes: ['server'] },
  skills: { scopes: ['server', 'workspace'], purposeKey: 'st.purpose.skills' },
  mcp: { scopes: ['server', 'workspace'] },
  plugins: { scopes: ['server'], purposeKey: 'st.purpose.plugins' },
  search: { scopes: ['server'], purposeKey: 'st.purpose.search' },
  'browser-control': { scopes: ['server'], purposeKey: 'st.purpose.browserControl' },
  'computer-control': { scopes: ['server'], purposeKey: 'st.purpose.computerControl' },
  hooks: { scopes: ['server'], purposeKey: 'st.purpose.hooks' },
  workspaces: { scopes: ['server'], purposeKey: 'st.purpose.workspaces' },
  ssh: { scopes: ['server'], purposeKey: 'st.purpose.ssh' },
  developer: { scopes: ['server'], purposeKey: 'st.purpose.developer' },
  labs: { scopes: ['server'], purposeKey: 'st.purpose.labs' },
  about: { scopes: ['server', 'app'], purposeKey: 'st.purpose.about' },
  spaces: { scopes: ['server', 'app'], purposeKey: 'st.purpose.spaces' },
};

// ---- experimental flags, homed with the feature they change ----

/** When a changed experimental flag is felt by a running server. */
export type ExperimentalFlagEffect = 'now' | 'newSessions' | 'restart';

export interface ExperimentalFlagHome {
  readonly id: string;
  /** Settings leaf whose Experimental rows list this flag. */
  readonly section: string;
  readonly labelKey: I18nKey;
  readonly descriptionKey: I18nKey;
  readonly effect: ExperimentalFlagEffect;
  /** Set when a feature card already owns the switch; no separate row renders. */
  readonly cardId?: string;
}

/**
 * Every experimental flag the GUI has copy for, and the page it belongs to.
 * The owning page renders it in its Experimental rows; Labs only indexes
 * this list. A flag the server reports but this table lacks lands on
 * Developer. Effects follow the server consumer: `restart` means turning
 * the flag on needs a server restart, `newSessions` that running sessions
 * keep their current behavior.
 */
export const EXPERIMENTAL_FLAG_HOMES: readonly ExperimentalFlagHome[] = [
  { id: 'agent-profile-routes', section: 'agents', labelKey: 'st.exp.agentRoutes.name', descriptionKey: 'st.exp.agentRoutes.desc', effect: 'restart' },
  { id: 'subagent_release_idle', section: 'subagents', labelKey: 'st.exp.subagentIdle.name', descriptionKey: 'st.exp.subagentIdle.desc', effect: 'now' },
  { id: 'auto_session_title', section: 'sessions', labelKey: 'st.exp.sessionTitle.name', descriptionKey: 'st.exp.sessionTitle.desc', effect: 'now', cardId: 'st-card-session-title' },
  { id: 'session_idle_eviction', section: 'sessions', labelKey: 'st.exp.sessionEviction.name', descriptionKey: 'st.exp.sessionEviction.desc', effect: 'restart' },
  { id: 'transcript_resident_window', section: 'sessions', labelKey: 'st.exp.residentWindow.name', descriptionKey: 'st.exp.residentWindow.desc', effect: 'newSessions' },
  { id: 'task_wait', section: 'tasks', labelKey: 'st.exp.taskWait.name', descriptionKey: 'st.exp.taskWait.desc', effect: 'now' },
  { id: 'task_board', section: 'tasks', labelKey: 'st.exp.taskBoard.name', descriptionKey: 'st.exp.taskBoard.desc', effect: 'now' },
  { id: 'tool-select', section: 'mcp', labelKey: 'st.exp.toolSelect.name', descriptionKey: 'st.exp.toolSelect.desc', effect: 'now' },
  { id: 'external_delegation_mcp', section: 'mcp', labelKey: 'st.exp.delegation.name', descriptionKey: 'st.exp.delegation.desc', effect: 'restart' },
  { id: 'search_worker', section: 'search', labelKey: 'st.exp.searchWorker.name', descriptionKey: 'st.exp.searchWorker.desc', effect: 'restart' },
  { id: 'desktop_search', section: 'search', labelKey: 'st.exp.desktopSearch.name', descriptionKey: 'st.exp.desktopSearch.desc', effect: 'restart' },
  { id: 'image_format_conversion', section: 'ai', labelKey: 'st.exp.imageConversion.name', descriptionKey: 'st.exp.imageConversion.desc', effect: 'now' },
  { id: 'native_ssh', section: 'ssh', labelKey: 'st.exp.nativeSsh.name', descriptionKey: 'st.exp.nativeSsh.desc', effect: 'restart' },
  // Stays on Developer: the browser page states this flag's outcome and points
  // here, but does not host a browser-local switch for it. The gate is read per
  // call, so the page's own connect works as soon as it is on; the agent's
  // browser tools are registered per scope, so a running session keeps its set.
  { id: 'native_browser', section: 'developer', labelKey: 'st.exp.nativeBrowser.name', descriptionKey: 'st.exp.nativeBrowser.desc', effect: 'newSessions' },
  { id: 'persistence_minidb_readmodel', section: 'developer', labelKey: 'st.exp.readModel.name', descriptionKey: 'st.exp.readModel.desc', effect: 'now' },
  // Stays on Developer: kap-server reads this flag once while booting and only
  // then registers the /api/usage-export routes, so the switch has no home
  // that could restart anything for it. The panel that would sit on the section
  // is on the Usage page and states its own outcome.
  { id: 'usage_export', section: 'developer', labelKey: 'st.exp.usageExport.name', descriptionKey: 'st.exp.usageExport.desc', effect: 'restart' },
];

/** Leaf that hosts flags nobody else claims (server-specific extensions). */
export const EXPERIMENTAL_FALLBACK_SECTION = 'developer';

export function experimentalFlagHome(id: string): ExperimentalFlagHome | undefined {
  return EXPERIMENTAL_FLAG_HOMES.find((home) => home.id === id);
}

/** Page a flag's row lives on; unknown flags fall back to Developer. */
export function experimentalSectionForFlag(id: string): string {
  return experimentalFlagHome(id)?.section ?? EXPERIMENTAL_FALLBACK_SECTION;
}

/** Anchor of a page's Experimental rows; one per hosting leaf. */
export function experimentalCardId(section: string): string {
  return `st-card-exp-${section}`;
}

/** Tab a tabbed page mounts its Experimental rows on (Models → Defaults, Search → Advanced). */
const EXPERIMENTAL_TAB: Readonly<Record<string, SettingsTab>> = { ai: 'defaults', search: 'advanced' };

export function experimentalTabForSection(section: string): SettingsTab | undefined {
  return EXPERIMENTAL_TAB[section];
}

/**
 * One search entry per page that hosts Experimental rows. Flags a feature
 * card already switches ride on that card's own entry. Developer is always
 * listed because it takes whatever flags nobody else claims.
 */
const EXPERIMENTAL_SEARCH_ENTRIES: readonly SettingsSearchSpecEntry[] = [
  ...new Set([...EXPERIMENTAL_FLAG_HOMES.filter((home) => home.cardId === undefined).map((home) => home.section), EXPERIMENTAL_FALLBACK_SECTION]),
].map((section) => {
  const homes = EXPERIMENTAL_FLAG_HOMES.filter((home) => home.section === section && home.cardId === undefined);
  const tab = experimentalTabForSection(section);
  return {
    section,
    cardId: experimentalCardId(section),
    ...(tab === undefined ? {} : { tab }),
    titleKey: 'st.exp.rowsTitle' as const,
    keywordKeys: homes.flatMap((home) => [home.labelKey, home.descriptionKey]),
    synonyms: ['experimental', '实验', 'beta', 'flag', ...homes.map((home) => home.id)],
  };
});

export const SETTINGS_SEARCH_SPEC: readonly SettingsSearchSpecEntry[] = [
  { section: 'sessions', cardId: 'st-card-defaults', titleKey: 'st.plan.title', keywordKeys: ['st.defaults.planMode', 'st.defaults.planGate', 'st.defaults.planGateTimeout'], synonyms: ['plan', 'plan mode', '计划', '计划模式'] },
  { section: 'tasks', cardId: 'st-card-agent-board', titleKey: 'st.agentBoard.title', keywordKeys: ['st.boardStorage.policy', 'st.boardStorage.noMove'], synonyms: ['board', '看板', 'storage'] },
  { section: 'subagents', cardId: 'st-card-subagent-default-target', titleKey: 'st.subagentDefault.title', keywordKeys: ['st.subagentDefault.label', 'st.subagentDefault.hint'], synonyms: ['default profile', '默认 profile', '默认子代理', 'general'] },
  { section: 'subagents', cardId: 'st-card-subagent-open-mode', titleKey: 'st.subagentOpenMode.title', keywordKeys: ['st.subagentOpenMode.hint', 'st.subagentOpenMode.tab', 'st.subagentOpenMode.fullscreen'], synonyms: ['subagent panel', '子代理面板', '打开方式'] },
  { section: 'subagents', cardId: 'st-card-subagent-limits', titleKey: 'st.subagentLimits.title', keywordKeys: ['st.subagentLimits.timeout', 'st.subagentLimits.direct', 'st.subagentLimits.total'], synonyms: ['timeout', '超时', '限额'] },
  { section: 'subagents', cardId: 'st-card-subagent-tool-defaults', titleKey: 'st.subagentTools.title', keywordKeys: ['st.subagentTools.hint'], synonyms: ['subagent tools', '子代理工具', 'tool defaults', '工具权限', 'board', '看板'] },
  { section: 'general', cardId: 'st-card-language', titleKey: 'st.language.title', keywordKeys: ['st.language.hint'] },
  { section: 'appearance', cardId: 'st-card-appearance', titleKey: 'st.appearance.colorTitle', keywordKeys: ['st.appearance.theme', 'st.appearance.theme.dark', 'st.appearance.theme.light', 'st.appearance.theme.system', 'st.skin.title', 'st.skin.hint', 'st.skin.accent'], synonyms: ['skin', '皮肤', '换肤', 'dark mode', '暗色模式', 'accent color', '强调色', 'color', '颜色'] },
  { section: 'appearance', cardId: 'st-card-appearance-background', titleKey: 'st.bg.title', keywordKeys: ['st.bg.hint', 'st.bg.chooseFile', 'st.bg.opacity', 'st.bg.blur', 'st.bg.scrim', 'st.bg.surface', 'st.bg.perTheme'], synonyms: ['wallpaper', '壁纸', '背景', 'background image', '背景图', 'video background', '视频背景', 'anime', '二次元', 'opacity', '不透明度', 'blur', '模糊'] },
  { section: 'appearance', cardId: 'st-card-appearance-type', titleKey: 'st.appearance.typeTitle', keywordKeys: ['st.skin.font', 'st.skin.fontMono', 'st.appearance.prose'], synonyms: ['font', '字体', 'serif', '衬线', 'typeface'] },
  { section: 'appearance', cardId: 'st-card-appearance-layout', titleKey: 'st.appearance.layoutTitle', keywordKeys: ['st.skin.radius', 'st.skin.density', 'st.appearance.motion'], synonyms: ['radius', '圆角', 'density', '密度', 'animation', '动画', 'reduce motion', '减少动态效果'] },
  { section: 'appearance', cardId: 'st-card-appearance-packs', titleKey: 'st.pack.title', keywordKeys: ['st.pack.hint', 'st.pack.import', 'st.pack.export', 'st.pack.use'], synonyms: ['appearance pack', '外观包', 'theme pack', '主题包', 'skin pack', '皮肤包', 'import theme', '导入主题'] },
  { section: 'appearance', cardId: 'st-card-skin-files', titleKey: 'st.skin.filesTitle', keywordKeys: ['st.skin.folder', 'st.skin.export'], synonyms: ['theme file', '主题文件', 'themes folder', '主题文件夹', 'export skin', '导出皮肤'] },
  { section: 'permissions', cardId: 'st-card-permission-defaults', titleKey: 'st.perm.defaultTitle', keywordKeys: ['st.defaults.permissionMode', 'st.defaults.permission.manual', 'st.defaults.permission.yolo', 'st.perm.dangerousBash'], synonyms: ['permission defaults', '权限默认值', 'permission mode', '权限模式', 'yolo', 'full access', '完全访问', 'dangerous_bash', '危险命令'] },
  { section: 'permissions', cardId: 'st-card-permission-rules', titleKey: 'st.perm.rulesTitle', keywordKeys: ['st.perm.pattern', 'st.perm.decision'], synonyms: ['permission rules', '权限规则', 'always allow', '总是允许'] },
  { section: 'permissions', cardId: 'st-card-reviewer', titleKey: 'st.reviewer.title', keywordKeys: ['st.reviewer.model', 'st.reviewer.categories'], synonyms: ['approve for me', '替我审批', 'TypeSafe', 'Jev'] },
  { section: 'sessions', cardId: 'st-card-questions', titleKey: 'st.sessions.questionsTitle', keywordKeys: ['st.composer.questions', 'st.composer.questionsBlock'], synonyms: ['ask user question', 'AskUserQuestion', '提问', '问题'] },
  { section: 'general', cardId: 'st-card-composer', titleKey: 'st.composer.title', keywordKeys: ['st.composer.sendShortcut', 'st.composer.persistDrafts', 'st.transcript.foldSteps', 'st.layout.railOpenByDefault'], synonyms: ['timeline', '时间线', 'transcript', '会话记录', 'fold steps', 'fold reads', '折叠', '工具步骤', '连续读取', 'right panel', 'inspector', '右侧栏', '侧栏'] },
  { section: 'shortcuts', cardId: 'st-card-shortcuts', titleKey: 'st.shortcuts.title', keywordKeys: ['st.shortcuts.intro', 'st.shortcuts.platform', 'st.shortcuts.reset'], synonyms: ['shortcut', 'shortcuts', 'keybinding', 'keyboard', 'hotkey', '快捷键', '键位', '按键', '热键'] },
  { section: 'shortcuts', cardId: 'st-card-shortcuts-fixed', titleKey: 'st.shortcuts.fixedTitle', keywordKeys: ['st.shortcuts.fixedHint'], synonyms: ['esc', 'enter', '固定按键'] },
  { section: 'general', cardId: 'st-card-desktop', titleKey: 'st.desktop.title', keywordKeys: ['st.desktop.tray', 'st.desktop.quit'] },
  { section: 'notifications', cardId: 'st-card-notify-away', titleKey: 'st.away.title', keywordKeys: ['st.away.enabled', 'st.away.completed', 'st.away.failed', 'st.away.question', 'st.away.approval'], synonyms: ['system notification', '系统通知', 'desktop notification', '桌面通知', 'unread', '未读', 'badge', '角标', 'activity', '活动'] },
  { section: 'sessions', cardId: 'st-card-session-title', titleKey: 'st.sessions.titlesTitle', keywordKeys: ['st.sessions.titlesToggle', 'st.sessions.titleMoments', 'st.sessionTitleModel.model'], synonyms: ['session title', '会话标题', 'title model', '标题模型', 'title moment', '标题时机', 'automatic title', '自动标题', 'generate when', '生成时机'] },
  { section: 'ai', tab: 'models', cardId: 'st-card-models', titleKey: 'st.models.defaultTitle', keywordKeys: ['st.models.providerLabel', 'st.models.searchPlaceholder', 'st.models.remoteIdAria', 'st.images.acceptedTypes', 'st.images.convertUnsupported'], synonyms: ['模型目录', 'model catalog', '模型列表', 'model editing', '模型编辑', 'remote id', '远端模型 ID', 'image policy', '图片策略', '图片类型', '图片转换'] },
  { section: 'ai', tab: 'models', cardId: 'st-card-catalog-refresh', titleKey: 'st.catalogRefresh.title', keywordKeys: ['st.catalogRefresh.hint', 'st.catalogRefresh.getModels'], synonyms: ['模型目录刷新', 'catalog refresh', '获取模型', 'get models'] },
  { section: 'ai', tab: 'models', cardId: 'st-card-model-migration', titleKey: 'st.modelMigration.title', keywordKeys: ['st.modelMigration.hint', 'st.modelMigration.preview', 'st.modelMigration.restore'], synonyms: ['model migration', '模型迁移', '旧版模型参数', 'model parameters backup'] },
  { section: 'ai', tab: 'defaults', cardId: 'st-card-global-defaults', titleKey: 'st.defaults.globalTitle', keywordKeys: ['st.models.providerLabel', 'st.defaults.globalHint'] },
  { section: 'ai', tab: 'defaults', cardId: 'st-card-model-switch', titleKey: 'st.modelSwitch.title', keywordKeys: ['st.modelSwitch.defaultMode', 'st.modelSwitch.confirm', 'st.modelSwitch.rulesTitle', 'st.modelSwitch.ruleFrom'], synonyms: ['模型切换', 'model switch', 'switch model', '换模型', '切换方式', '全新上下文', 'fresh context', '压缩后切换', 'exception rule', '例外规则'] },
  { section: 'identity', cardId: 'st-card-request-identity', titleKey: 'st.requestIdentity.defaultTitle', keywordKeys: ['st.requestIdentity.defaultLabel', 'st.requestIdentity.defaultHint'], synonyms: ['请求身份', 'request identity', 'User-Agent', 'UA', 'header', '请求头', 'fingerprint', '指纹'] },
  { section: 'identity', cardId: 'st-card-identity-profiles', titleKey: 'st.identity.listTitle', keywordKeys: ['st.identity.userAgentLabel', 'st.identity.headersLabel', 'st.identity.paramsLabel', 'st.identity.duplicate'], synonyms: ['Codex', 'Claude Code', 'Grok', 'originator', 'X-Stainless'] },
  { section: 'identity', cardId: 'st-card-identity-tracks', titleKey: 'st.identity.tracksTitle', keywordKeys: ['st.identity.checkNpm', 'st.identity.checkLocal', 'st.identity.pin', 'st.identity.manifestLabel'], synonyms: ['client version', '客户端版本', 'npm', 'rollback', '回滚'] },
  { section: 'identity', cardId: 'st-card-identity-usage', titleKey: 'st.identity.usageTitle', keywordKeys: ['st.identity.usageEffective'] },
  { section: 'identity', cardId: 'st-card-identity-recent', titleKey: 'st.identity.recentTitle', keywordKeys: ['st.identity.recentEmpty'] },
  { section: 'ai', tab: 'defaults', cardId: 'st-card-thinking', titleKey: 'st.thinking.title', keywordKeys: ['st.thinking.enable', 'st.thinking.hint', 'st.thinking.keep'], synonyms: ['thinking keep', '保留思考'] },
  { section: 'ai', tab: 'defaults', cardId: 'st-card-auto-compact', titleKey: 'st.compact.globalTitle', keywordKeys: ['st.compact.globalLabel', 'st.compact.reserveLabel'], synonyms: ['auto compact', 'autocompact', 'compaction', '自动压缩', '压缩点', 'context window', '上下文窗口'] },
  { section: 'ai', tab: 'defaults', cardId: 'st-card-loop-limits', titleKey: 'st.loopLimits.title', keywordKeys: ['st.loopLimits.maxSteps', 'st.loopLimits.maxAttempts', 'st.loopLimits.subagentStrategy'], synonyms: ['max steps', 'max_steps_per_turn', 'max_attempts_per_step', 'subagent_context_strategy', 'loop control', '步数上限', '尝试次数'] },
  { section: 'connection', cardId: 'st-card-conn-server', titleKey: 'st.conn.connectedTitle', keywordKeys: ['connect.serverUrl', 'connect.token', 'st.conn.version', 'st.conn.reconnect'] },
  { section: 'connection', cardId: 'st-card-conn-timeout', titleKey: 'st.conn.timeoutTitle', keywordKeys: ['st.conn.timeoutLabel', 'st.conn.timeoutHint'], synonyms: ['request timeout', '请求超时'] },
  { section: 'connection', cardId: 'st-card-conn-owned', titleKey: 'st.conn.ownedTitle', keywordKeys: ['st.conn.ownedBody', 'st.conn.restart'] },
  { section: 'connection', cardId: 'st-card-conn-disconnect', titleKey: 'st.conn.disconnectTitle', keywordKeys: ['st.conn.disconnectBody', 'sidebar.disconnect'] },
  { section: 'connection', cardId: 'st-card-conn-log', titleKey: 'st.conn.logTitle', keywordKeys: ['st.conn.logBody', 'st.conn.logCopy'], synonyms: ['connection log', '连接日志', 'disconnect', '断线', 'heartbeat', '心跳', 'close code'] },
  { section: 'ai', tab: 'providers', cardId: 'st-card-auth', titleKey: 'st.connections.addTitle', keywordKeys: ['st.auth.signIn', 'st.account.signIn', 'st.connect.accountTitle'], synonyms: ['提供商', '供应商', 'provider', '认证', '登录', 'sign in', '账号', 'account', '订阅', 'subscription'] },
  { section: 'ai', tab: 'providers', cardId: 'st-card-providers', titleKey: 'st.providers.title', keywordKeys: ['st.providers.empty', 'st.images.acceptedTypes', 'st.images.convertUnsupported', 'st.quota.intro', 'st.quota.refresh'], synonyms: ['提供商', '供应商', 'provider', 'image policy', '图片策略', '图片类型', '图片转换', 'accepted image types', 'convert unsupported', '额度', '配额', 'quota', 'limit', '限额', 'Kimi Code', '订阅', 'subscription'] },
  { section: 'ai', tab: 'providers', cardId: 'st-card-providers-add', titleKey: 'st.providers.addTitle', keywordKeys: ['st.wizard.chooseTemplate', 'st.fetchModels.button'], synonyms: ['提供商', '供应商', 'provider'] },
  { section: 'ai', tab: 'providers', cardId: 'st-card-catalog-import', titleKey: 'st.catalog.title', keywordKeys: ['st.catalog.intro', 'st.catalog.searchPlaceholder'], synonyms: ['models.dev', '目录', 'catalog', 'directory', '导入', 'import', '提供商', 'provider'] },
  { section: 'ai', tab: 'providers', cardId: 'st-card-engines', titleKey: 'st.engines.title', keywordKeys: ['st.engines.intro', 'st.engines.check'], synonyms: ['外部引擎', 'executor', 'harness', 'Codex', 'Claude Code', 'Grok Build', 'ACP'] },
  { section: 'skills', cardId: 'st-card-caps', titleKey: 'st.caps.title', keywordKeys: ['st.caps.mergeSkills', 'st.caps.extraDirs', 'st.sidecar.builtinSkills'], synonyms: ['能力', 'skills', '技能'] },
  { section: 'skills', cardId: 'st-card-host-skill', titleKey: 'st.hostSkill.title', keywordKeys: ['st.hostSkill.host.claude', 'st.hostSkill.host.codex', 'st.hostSkill.host.grok'], synonyms: ['kiki-as-subagent', 'subagent', '子智能体', 'Claude Code', 'Codex', 'Grok'] },
  { section: 'skills', cardId: 'st-card-skill-catalog', titleKey: 'st.skills.catalogTitle', keywordKeys: ['cap.filterPlaceholder'], synonyms: ['能力', 'capabilities', '技能目录', 'skill catalog'] },
  { section: 'tasks', cardId: 'st-card-task-policy', titleKey: 'st.taskPolicy.title', keywordKeys: ['st.taskPolicy.hint', 'st.taskPolicy.maxRunningTasks', 'st.taskPolicy.bashTimeout', 'st.taskPolicy.keepAlive', 'st.taskPolicy.fileToolHints'], synonyms: ['runtime', '运行时', 'background tasks', '后台任务'] },
  { section: 'developer', cardId: 'st-card-cron', titleKey: 'st.cron.title', keywordKeys: ['st.cron.hint', 'st.cron.poll'], synonyms: ['cron', '定时任务', 'environment diagnostics', '环境诊断'] },
  { section: 'sessions', cardId: 'st-card-agent-messaging', titleKey: 'st.sessions.messagingTitle', keywordKeys: ['st.communication.threadCommunication', 'st.communication.notifyParent', 'st.sessions.delegationSub', 'st.sessions.delegationIndependent'], synonyms: ['thread communication', '线程通信', 'notify parent', '通知父代理', 'AgentNotify', 'agent communication', '智能体通信'] },
  { section: 'developer', cardId: 'st-card-token-counting', titleKey: 'st.communication.tokenCountingTitle', keywordKeys: ['st.communication.tokenCounting', 'st.communication.tokenCountingHint'], synonyms: ['token counting', 'token 计数'] },
  { section: 'general', cardId: 'st-card-append-timing', titleKey: 'st.communication.appendTimingTitle', keywordKeys: ['st.communication.appendTimingHint', 'st.communication.appendTiming'], synonyms: ['append timing', 'queue timing', '排队时机', '追加时机'] },
  { section: 'developer', cardId: 'st-card-retry', titleKey: 'st.retry.title', keywordKeys: ['st.retry.maxAttempts', 'st.retry.policies', 'st.retry.backoff'], synonyms: ['retry', 'backoff', 'rate limit', '限流', '重试策略'] },
  { section: 'developer', cardId: 'st-card-session-residency', titleKey: 'st.residency.title', keywordKeys: ['st.residency.maxLive', 'st.residency.idleTtl', 'st.residency.concurrentRestores'], synonyms: ['session_residency', 'eviction', 'unload', '卸载', '常驻'] },
  { section: 'developer', cardId: 'st-card-resource-limits', titleKey: 'st.resourceLimits.title', keywordKeys: ['st.resourceLimits.workspaceIdle', 'st.resourceLimits.imageMaxEdge', 'st.resourceLimits.imageBudget'], synonyms: ['image budget', '图片限制', 'idle ttl', '资源限制'] },
  { section: 'agents', cardId: 'st-card-agent-runtime', titleKey: 'st.agentIdentity.title', keywordKeys: ['st.agentIdentity.identityName', 'st.agentIdentity.extraAgentDirs', 'st.agentIdentity.disabledProfiles', 'st.agentIdentity.skipBuiltin'], synonyms: ['identity', '身份', 'agent dirs', 'disabled profiles', '禁用 profile'] },
  { section: 'labs', cardId: 'st-card-labs', titleKey: 'st.labs.indexTitle', keywordKeys: ['st.exp.tag'], synonyms: ['experimental features', '实验特性', '实验功能', 'flags', 'beta', 'labs'] },
  ...EXPERIMENTAL_SEARCH_ENTRIES,
  { section: 'developer', cardId: 'st-card-advanced', titleKey: 'st.advanced.title', keywordKeys: ['st.advanced.hint'], synonyms: ['json', 'config', '配置文件', 'loop_control', 'background'] },
  { section: 'subagents', cardId: 'st-card-subagents', titleKey: 'st.subagents.title', keywordKeys: ['st.subagents.denyModels', 'st.subagents.hint'], synonyms: ['子 agent', '子代理'] },
  { section: 'permissions', cardId: 'st-card-tools', titleKey: 'st.tools.title', keywordKeys: ['st.tools.allowlist', 'st.tools.followAgent'], synonyms: ['allowlist', '白名单', 'tool policy', '工具策略', 'disable tool', '禁用工具'] },
  { section: 'agents', cardId: 'st-card-main-agents', titleKey: 'st.agentManager.title', keywordKeys: ['st.agentManager.subagent', 'st.agentManager.new', 'st.agentManager.instructions', 'st.namedAgents.modelPin'], synonyms: ['主 agent', '子 agent', '子智能体', 'profiles', 'profile'] },
  { section: 'agents', cardId: 'st-card-prompt-config', titleKey: 'st.prompt.title', keywordKeys: ['st.prompt.hint', 'st.prompt.variables', 'st.prompt.fields'], synonyms: ['prompt fields', '提示词字段', 'prompt variables', '提示变量'] },
  { section: 'memory', cardId: 'st-card-memory', titleKey: 'st.memory.title', keywordKeys: ['st.memory.hint', 'memory.toggle', 'st.memory.approval', 'st.memory.budget', 'st.memory.open'], synonyms: ['memory', '记忆', 'remember', '长期记忆', 'memory approval', '记忆审批'] },
  { section: 'memory', cardId: 'st-card-memory-workspaces', titleKey: 'st.memory.workspaces', keywordKeys: ['memory.ws.label', 'memory.ws.follow', 'memory.ws.off'], synonyms: ['memory workspace', '工作区记忆', '记忆覆盖'] },
  { section: 'notifications', cardId: 'st-card-notify-rules', titleKey: 'st.notify.rulesTitle', keywordKeys: ['st.notify.enabled', 'st.notify.quiet', 'st.notify.viewing', 'st.notify.minWork'], synonyms: ['notification', '通知', 'do not disturb', '免打扰', 'quiet hours', 'nb-im', 'nb_im'] },
  { section: 'notifications', cardId: 'st-card-notify-channels', titleKey: 'st.notify.channelsTitle', keywordKeys: ['st.notify.add', 'st.notify.test', 'st.notify.check', 'st.notify.deliveries'], synonyms: ['telegram', 'wecom', '企业微信', '企微', 'dingtalk', '钉钉', 'feishu', '飞书', 'discord', 'slack', 'webhook', 'IM', '推送'] },
  { section: 'notifications', cardId: 'st-card-notify-add', titleKey: 'st.notify.addTitle', keywordKeys: ['st.notify.choose', 'st.notify.provider', 'st.notify.newConnection'], synonyms: ['add channel', '添加通道', 'new channel', '新建通道', 'bot', '机器人'] },
  { section: 'hooks', cardId: 'st-card-hooks', titleKey: 'st.hooks.title', keywordKeys: ['st.hooks.hint'], synonyms: ['hooks', '钩子'] },
  { section: 'search', tab: 'overview', cardId: 'st-card-search-status', titleKey: 'st.nbSearch.statusTitle', keywordKeys: ['st.nbSearch.statusHint'], synonyms: ['web search', 'fetch', '联网搜索', '网页抓取', 'nb-search', 'nb_search'] },
  { section: 'search', tab: 'overview', cardId: 'st-card-search-source', titleKey: 'st.nbSearch.source.title', keywordKeys: ['st.nbSearch.source.hint', 'st.nbSearch.source.reuseLocalLabel'], synonyms: ['配置来源', 'config source', 'nb-search config', '本地配置', 'local config'] },
  { section: 'search', tab: 'search', cardId: 'st-card-search-defaults', titleKey: 'st.nbSearch.defaultsTitle', keywordKeys: ['st.nbSearch.defaultLaneLabel'], synonyms: ['搜索 lane', 'search lane', 'default lane'] },
  { section: 'search', tab: 'fetch', cardId: 'st-card-search-fetch', titleKey: 'st.nbSearch.fetch.title', keywordKeys: ['st.nbSearch.fetchChainHint'], synonyms: ['fetch chain', '抓取链', 'pipeline chain', 'fallback'] },
  { section: 'search', tab: 'providers', cardId: 'st-card-search-providers', titleKey: 'st.nbSearch.providersTitle', keywordKeys: ['st.nbSearch.credentialEnvLabel', 'st.nbSearch.baseUrlLabel'], synonyms: ['exa', 'tavily', 'brave', 'searxng', 'jina', '搜索提供商'] },
  { section: 'search', tab: 'advanced', cardId: 'st-card-search-execution', titleKey: 'st.nbSearch.executionTitle', keywordKeys: ['st.nbSearch.groupBudgets', 'st.nbSearch.groupTimeouts', 'st.nbSearch.groupFetchLimits'], synonyms: ['搜索超时', 'search timeout', 'concurrency', '并发'] },
  { section: 'search', tab: 'advanced', cardId: 'st-card-search-index', titleKey: 'st.searchIndex.title', keywordKeys: ['st.searchIndex.retry'], synonyms: ['full-text index', '全文索引', 'history search', '历史搜索', 'indexer', '索引'] },
  { section: 'search', tab: 'advanced', cardId: 'st-card-search-diagnostics', titleKey: 'st.nbSearch.diagnosticsTitle', keywordKeys: ['st.nbSearch.diagnosticsHint'], synonyms: ['搜索诊断', 'search diagnostics', 'test'] },
  { section: 'mcp', cardId: 'st-card-mcp', titleKey: 'st.mcp.title', keywordKeys: ['st.mcp.configTitle', 'st.mcp.workspace', 'st.mcp.restart', 'st.mcp.toolsCount'], synonyms: ['能力', 'mcp 服务器', 'mcp server', 'mcp 状态', 'mcp status'] },
  { section: 'mcp', cardId: 'st-card-mcp-timeouts', titleKey: 'st.mcp.timeoutsTitle', keywordKeys: ['st.runtime.mcpStartupTimeout', 'st.runtime.mcpToolTimeout'], synonyms: ['mcp 超时', 'mcp timeout'] },
  { section: 'plugins', cardId: 'st-card-plugins', titleKey: 'st.plugins.title', keywordKeys: ['st.plugins.hint'], synonyms: ['插件', 'plugin', '插件管理', 'marketplace', '插件市场', '安装插件'] },
  { section: 'plugins', cardId: 'st-card-webbridge', titleKey: 'st.plugins.runtimeTitle', keywordKeys: ['st.plugins.browserExtension'], synonyms: ['webbridge', '浏览器扩展', 'browser daemon'] },
  { section: 'browser-control', cardId: 'st-card-browser-default', titleKey: 'st.browser.defaultTitle', keywordKeys: ['st.browser.defaultLabel', 'st.browser.defaultHint'], synonyms: ['默认浏览器', 'default browser', '浏览器', 'browser'] },
  { section: 'browser-control', cardId: 'st-card-browser-setup', titleKey: 'st.browser.setup.title', keywordKeys: ['st.browser.setup.driver', 'st.browser.setup.chrome', 'st.browser.setup.host'], synonyms: ['浏览器组件', 'browser components', '安装浏览器', 'install browser', '驱动', 'driver'] },
  { section: 'browser-control', cardId: 'st-card-browser-connections', titleKey: 'st.browser.connectionsTitle', keywordKeys: ['st.browser.add', 'st.browser.fieldType', 'st.browser.fieldEndpoint', 'st.browser.disconnect'], synonyms: ['browser control', '浏览器控制', 'cdp', 'profile', 'chromium', 'chrome', 'agent-browser', '浏览器连接', '调试端口'] },
  { section: 'computer-control', cardId: 'st-card-computer-machine', titleKey: 'st.computer.title', keywordKeys: ['st.computer.machineLabel', 'st.computer.statusLabel'], synonyms: ['computer control', '电脑控制', 'desktop control', '桌面控制', 'cua', 'cua-driver', 'mouse', 'keyboard', '屏幕'] },
  { section: 'computer-control', cardId: 'st-card-computer-setup', titleKey: 'st.computer.setupTitle', keywordKeys: ['st.computer.statusLabel', 'st.computer.installButton', 'st.computer.recheckButton'], synonyms: ['executor', '执行器', '安装', 'install', '版本'] },
  { section: 'computer-control', cardId: 'st-card-computer-mcp', titleKey: 'st.computer.connectionsTitle', keywordKeys: ['st.computer.connectionsHint', 'st.computer.fieldCommand', 'st.computer.stopButton'], synonyms: ['mcp', 'kiki-computer', 'stdio', '配置', 'connect', '连接', '停止'] },
  { section: 'workspaces', cardId: 'st-card-workspaces', titleKey: 'st.workspaces.title', keywordKeys: ['st.workspaces.hint'] },
  { section: 'workspaces', cardId: 'st-card-worktrees', titleKey: 'st.worktrees.title', keywordKeys: ['st.worktrees.hint', 'st.worktrees.cleanup', 'st.worktreePolicy.prefix', 'st.worktreePolicy.base', 'st.worktreePolicy.autoCleanup'], synonyms: ['branch prefix', '分支前缀', 'worktree policy', 'worktree 策略'] },
  { section: 'ssh', cardId: 'st-card-ssh-hosts', titleKey: 'st.ssh.hostsTitle', keywordKeys: ['st.ssh.addHost', 'st.ssh.writeBack'], synonyms: ['ssh', 'ssh config', '~/.ssh/config', 'remote host', '远程主机', '主机'] },
  { section: 'ssh', cardId: 'st-card-ssh-connection', titleKey: 'st.ssh.connectionTitle', keywordKeys: ['st.ssh.syncToggle', 'st.ssh.approvalToggle', 'st.ssh.approvalHint'], synonyms: ['connection approval', '连接审批', 'host key', '主机密钥', 'known_hosts'] },
  { section: 'about', cardId: 'st-card-desktop-log', titleKey: 'st.desktopLog.title', keywordKeys: ['st.desktopLog.levelLabel', 'st.desktopLog.openFolder'], synonyms: ['log', 'logs', 'logging', 'debug', 'trace', '日志', '诊断', 'desktop-backend.log'] },
  { section: 'about', cardId: 'st-card-about', titleKey: 'st.about.title', keywordKeys: ['st.about.serverVersion', 'st.about.serverId'] },
  { section: 'spaces', cardId: 'st-card-space-window', titleKey: 'st.spaces.windowTitle', keywordKeys: ['st.spaces.windowSwitch', 'st.spaces.windowWindows', 'st.spaces.windowNextLaunch'], synonyms: ['window mode', '窗口模式', 'multi window', '多窗口'] },
  { section: 'spaces', cardId: 'st-card-spaces', titleKey: 'st.spaces.listTitle', keywordKeys: ['st.spaces.new', 'st.spaces.attach', 'st.spaces.removeFromList', 'st.spaces.delete', 'st.spaces.credentials'], synonyms: ['space', 'spaces', '空间', 'home', 'kiki home', 'profile', '多开', '独立空间', 'isolated'] },
  { section: 'spaces', cardId: 'st-card-remote-connections', titleKey: 'st.remote.outboundTitle', keywordKeys: ['st.remote.addTitle', 'st.remote.way.ssh', 'st.remote.removeTitle'], synonyms: ['remote kiki', 'remote space', 'connection', '远端 kiki', '远端空间', '连接', 'broker', 'over ssh'] },
  { section: 'spaces', cardId: 'st-card-inbound-connections', titleKey: 'st.inbound.title', keywordKeys: ['st.inbound.gate', 'st.inbound.invitationLabel', 'st.inbound.bridgeNote'], synonyms: ['inbound', 'allow', 'invitation', '入站', '准入', '允许', '邀请', '被连接'] },
  { section: 'spaces', cardId: 'st-card-space-credentials', titleKey: 'st.spaces.credTitle', keywordKeys: ['st.spaces.credShared', 'st.spaces.credIsolated', 'st.spaces.copySsh'], synonyms: ['credentials', '凭据', '账号与密钥', 'ssh password', 'oauth'] },
  { section: 'spaces', cardId: 'st-card-space-overrides', titleKey: 'st.spaces.ownChoices', keywordKeys: ['st.origin.restore', 'st.origin.local', 'st.origin.inherited'], synonyms: ['inherit', '继承', '恢复继承', 'override', '覆盖'] },
  { section: 'spaces', cardId: 'st-card-web-access', titleKey: 'st.web.title', keywordKeys: ['st.web.newLink', 'st.web.turnOff', 'st.web.address', 'st.web.signedIn', 'st.web.persistent', 'st.web.temporary'], synonyms: ['web access', 'web 访问', '浏览器访问', 'browser access', '网页', '临时开启', 'always on', '始终开启', 'entry link', '入口链接', 'web link', '手机', 'phone'] },
];

export interface SettingsSearchEntry {
  readonly section: string;
  readonly cardId: string;
  /** Tab inside a tabbed section; the page switches to it before flashing. */
  readonly tab?: SettingsTab;
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
      tab: entry.tab,
      groupLabel,
      sectionLabel,
      title,
      haystack: [
        title,
        groupLabel,
        sectionLabel,
        ...(entry.tab === undefined ? [] : [t(settingsTabLabelKey(entry.section, entry.tab))]),
        ...entry.keywordKeys.map((key) => t(key)),
        ...(entry.synonyms ?? []),
      ].join('\n').toLowerCase(),
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
  | { readonly status: 'ok'; readonly section: string; readonly cardId?: string; readonly tab?: SettingsTab }
  | { readonly status: 'unknown'; readonly section: string; readonly cardId?: string };

/**
 * Hidden aliases for renamed sections, so an old bookmark still lands on its
 * content instead of the "unknown setting" page. Batch 2 merged `models` and
 * `providers` into the `ai` entry (redesign §10.3); later splits keep each
 * capability flag with its owning leaf. IA v2 retired four more leaves:
 * `advanced` became `developer`, `experimental` lands on `labs`, `automation`
 * (tool policy) on `permissions` with hooks split to their own leaf, and
 * `communication` on `sessions`. The retired `runtime` leaf lands on `tasks`.
 * Precise card hashes still follow their current owner.
 */
export const LEGACY_SETTINGS_SECTION_ALIASES: Readonly<Record<string, string>> = {
  models: 'ai',
  providers: 'ai',
  capabilities: 'skills',
  experimental: 'labs',
  advanced: 'developer',
  automation: 'permissions',
  communication: 'sessions',
  runtime: 'tasks',
  theme: 'appearance',
  skins: 'appearance',
};

/** Dissolved cards keep a bookmark to their nearest active control. */
export const LEGACY_CARD_ALIASES: Readonly<Record<string, { readonly section: string; readonly cardId: string }>> = {
  'st-card-sidecar': { section: 'subagents', cardId: 'st-card-subagent-limits' },
  'st-card-subagent-timeout': { section: 'subagents', cardId: 'st-card-subagent-limits' },
  'st-card-subagent-profiles': { section: 'agents', cardId: 'st-card-main-agents' },
  'st-card-agent-todo': { section: 'tasks', cardId: 'st-card-agent-board' },
  // Experimental flags live with their feature; a multi-flag card from before
  // lands on the Labs index, a single-flag card on its row's new page.
  'st-card-experimental': { section: 'labs', cardId: 'st-card-labs' },
  'st-card-tool-experiments': { section: 'labs', cardId: 'st-card-labs' },
  'st-card-performance-storage': { section: 'developer', cardId: 'st-card-exp-developer' },
  'st-card-task-board': { section: 'tasks', cardId: 'st-card-exp-tasks' },
  'st-card-agent-profile-routes': { section: 'agents', cardId: 'st-card-exp-agents' },
  'st-card-mcp-delegation': { section: 'mcp', cardId: 'st-card-exp-mcp' },
  'st-card-subagent-release-idle': { section: 'subagents', cardId: 'st-card-exp-subagents' },
  'st-card-runtime': { section: 'tasks', cardId: 'st-card-task-policy' },
  'st-card-communication': { section: 'sessions', cardId: 'st-card-agent-messaging' },
  'st-card-thread-communication': { section: 'sessions', cardId: 'st-card-agent-messaging' },
  'st-card-notify-parent': { section: 'sessions', cardId: 'st-card-agent-messaging' },
};

/** Which tab a legacy section bookmark maps to (redesign §10.3's route table). */
const LEGACY_SECTION_TABS: Readonly<Record<string, AiSettingsTab>> = {
  models: 'models',
  providers: 'providers',
};

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
 * - The merged `ai` entry also carries a tab: an explicit card hash picks its
 *   owning tab (request identity / thinking live under `defaults`), otherwise
 *   the legacy section's own tab mapping applies (`models → tab=models`,
 *   `providers → tab=providers`).
 * - Unknown section with a recognizable card → the card's current section.
 * - Unknown section, no usable card → `unknown`; the page shows "this setting
 *   does not exist" with a search instead of silently falling back to general.
 */
export function resolveSettingsRoute(
  sectionParam: string | undefined,
  hash: string,
): SettingsRouteResolution {
  const rawCard = hash.replace(/^#/, '');
  const requestedCard = rawCard.startsWith('st-card-') ? rawCard : undefined;
  // A dissolved card (st-card-sidecar, st-card-runtime) has a hand-written
  // target; anything else follows the search spec's canonical owner.
  const legacyCard = requestedCard === undefined ? undefined : LEGACY_CARD_ALIASES[requestedCard];
  const cardId = legacyCard?.cardId ?? requestedCard;
  const cardSection = cardId === undefined
    ? undefined
    : (legacyCard?.section ?? settingsSectionForCard(cardId));
  const cardTab = cardId === undefined ? undefined : (aiTabForCard(cardId) ?? searchTabForCard(cardId));
  if (sectionParam === undefined || sectionParam === '') {
    return { status: 'ok', section: cardSection ?? 'general', cardId, ...(cardTab === undefined ? {} : { tab: cardTab }) };
  }
  const aliased = LEGACY_SETTINGS_SECTION_ALIASES[sectionParam] ?? sectionParam;
  if (SETTINGS_SECTIONS.some((candidate) => candidate.id === aliased)) {
    if (cardSection !== undefined && cardSection !== aliased) {
      return { status: 'ok', section: cardSection, cardId, tab: cardTab };
    }
    return {
      status: 'ok',
      section: aliased,
      cardId,
      tab: cardTab ?? (aliased === 'ai' ? LEGACY_SECTION_TABS[sectionParam] : undefined),
    };
  }
  if (cardSection !== undefined) {
    return { status: 'ok', section: cardSection, cardId, tab: cardTab };
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

function isRequestIdentityPreset(value: RequestIdentityChoice): value is RequestIdentityPreset {
  return ['codex_compatible', 'claude_code_compatible', 'grok_build_compatible', 'opencode_compatible', 'kimi_code', 'none'].includes(value);
}

function isPermissionMode(value: unknown): value is DesktopSettings['defaultPermissionMode'] {
  return value === 'manual' || value === 'auto' || value === 'review' || value === 'yolo';
}

function isProviderWireType(value: string): value is ProviderWireType {
  return PROVIDER_WIRE_TYPES.some((candidate) => candidate === value);
}
