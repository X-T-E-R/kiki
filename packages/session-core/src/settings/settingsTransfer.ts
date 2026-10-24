import {
  SETTINGS_TRANSFER_MAX_BYTES,
  settingsTransferPackageSchema,
  settingsTransferPreferencesSchema,
  type SettingsTransferCategory,
  type SettingsTransferCatalog,
  type SettingsTransferCategorySummary,
  type SettingsTransferMode,
  type SettingsTransferPackage,
  type SettingsTransferPreferences,
  type SettingsTransferPreview,
} from '@kiki/protocol';

import {
  readDesktopPrefs,
  readDeviceSettings,
  writeDesktopPrefs,
  writeSettings,
  type DesktopNativePrefs,
  type DesktopSettings,
} from './settings';
import { readLayoutPreferences, writeLayoutPreferences, type LayoutPreferences } from './layoutPrefs';

const SETTINGS_STORAGE_KEY = 'kiki.settings';
const LAYOUT_STORAGE_KEY = 'kiki.layout';
const DESKTOP_STORAGE_KEY = 'kiki.desktopPrefs';
const LOCALE_STORAGE_KEY = 'kiki.locale';

const LOCAL_SETTING_KEYS = [
  'sendShortcut',
  'draftPersistence',
  'theme',
  'requestTimeoutSeconds',
  'readingTimeoutSeconds',
  'subagentPanelOpenMode',
  'defaultAppendTiming',
  'foldSteps',
  'worktreeSkipConfirm',
  'railOpenByDefault',
  'motion',
  'proseFont',
  'awayNotifications',
] as const;
type LocalSettingKey = typeof LOCAL_SETTING_KEYS[number];
type LocalSettings = NonNullable<SettingsTransferPreferences['settings']>;
type LocalSettingValue = NonNullable<LocalSettings[LocalSettingKey]>;

const LAYOUT_KEYS = [
  'sidebarWidth',
  'railWidth',
  'sidebarCollapsed',
  'pinnedNavItems',
  'sidebarNavSectionCollapsed',
  'groupBy',
  'sortBy',
] as const;
type LayoutTransferKey = typeof LAYOUT_KEYS[number];

const DESKTOP_KEYS = ['notifications', 'closeToTray'] as const;
type DesktopTransferKey = typeof DESKTOP_KEYS[number];

export interface SettingsTransferDesktopBridge {
  readonly read?: () => Promise<Pick<DesktopNativePrefs, DesktopTransferKey> | null>;
  readonly write?: (prefs: Partial<DesktopNativePrefs>) => Promise<void>;
}

export interface LocalSettingsTransferApplyResult {
  readonly status: 'complete' | 'partial';
  readonly appliedKeys: readonly string[];
  readonly failedKeys: readonly string[];
  readonly preferences: SettingsTransferPreferences | undefined;
}

export interface LocalSettingsTransferPreview {
  readonly items: number;
  readonly added: number;
  readonly conflicts: number;
  readonly unchanged: number;
  readonly skipped: number;
}

interface LocalPreferenceEntry {
  readonly key: string;
  readonly value: unknown;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function readStoredRecord(key: string): Record<string, unknown> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readStoredLocale(): 'en' | 'zh' | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const value = localStorage.getItem(LOCALE_STORAGE_KEY);
    return value === 'en' || value === 'zh' ? value : undefined;
  } catch {
    return undefined;
  }
}

function preserveSparseStorageRecord(key: string, original: Record<string, unknown>, patch: object): void {
  if (typeof localStorage === 'undefined') return;
  const next = { ...original };
  for (const [name, value] of Object.entries(patch)) {
    if (value !== undefined) next[name] = value;
  }
  localStorage.setItem(key, JSON.stringify(next));
}

function isAwayNotifications(value: unknown): value is NonNullable<LocalSettings['awayNotifications']> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ['completed', 'failed', 'question', 'approval'].every((key) => typeof record[key] === 'boolean');
}

function isLocalSettingValue(key: LocalSettingKey, value: unknown): value is LocalSettingValue {
  if (key === 'sendShortcut') return value === 'enter' || value === 'cmd-enter';
  if (key === 'draftPersistence' || key === 'foldSteps' || key === 'worktreeSkipConfirm' || key === 'railOpenByDefault') return typeof value === 'boolean';
  if (key === 'theme') return value === 'light' || value === 'dark' || value === 'system';
  if (key === 'requestTimeoutSeconds') return typeof value === 'number' && Number.isInteger(value) && value >= 5 && value <= 600;
  if (key === 'readingTimeoutSeconds') return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2_147_483;
  if (key === 'subagentPanelOpenMode') return value === 'tab' || value === 'fullscreen';
  if (key === 'defaultAppendTiming') return value === 'agent_idle' || value === 'subagents_done' || value === 'tasks_done';
  if (key === 'motion') return value === 'system' || value === 'reduce' || value === 'full';
  if (key === 'proseFont') return value === 'serif' || value === 'sans';
  return isAwayNotifications(value);
}

function readTransferSetting(source: LocalSettings | undefined, key: LocalSettingKey): unknown {
  if (source === undefined) return undefined;
  if (key === 'sendShortcut') return source.sendShortcut;
  if (key === 'draftPersistence') return source.draftPersistence;
  if (key === 'theme') return source.theme;
  if (key === 'requestTimeoutSeconds') return source.requestTimeoutSeconds;
  if (key === 'readingTimeoutSeconds') return source.readingTimeoutSeconds;
  if (key === 'subagentPanelOpenMode') return source.subagentPanelOpenMode;
  if (key === 'defaultAppendTiming') return source.defaultAppendTiming;
  if (key === 'foldSteps') return source.foldSteps;
  if (key === 'worktreeSkipConfirm') return source.worktreeSkipConfirm;
  if (key === 'railOpenByDefault') return source.railOpenByDefault;
  if (key === 'motion') return source.motion;
  if (key === 'proseFont') return source.proseFont;
  return source.awayNotifications;
}

function readDesktopSetting(source: DesktopSettings, key: LocalSettingKey): unknown {
  if (key === 'sendShortcut') return source.sendShortcut;
  if (key === 'draftPersistence') return source.draftPersistence;
  if (key === 'theme') return source.theme;
  if (key === 'requestTimeoutSeconds') return source.requestTimeoutSeconds;
  if (key === 'readingTimeoutSeconds') return source.readingTimeoutSeconds;
  if (key === 'subagentPanelOpenMode') return source.subagentPanelOpenMode;
  if (key === 'defaultAppendTiming') return source.defaultAppendTiming;
  if (key === 'foldSteps') return source.foldSteps;
  if (key === 'worktreeSkipConfirm') return source.worktreeSkipConfirm;
  if (key === 'railOpenByDefault') return source.railOpenByDefault;
  if (key === 'motion') return source.motion;
  if (key === 'proseFont') return source.proseFont;
  return source.awayNotifications;
}

function writeTransferSetting(target: LocalSettings, key: LocalSettingKey, value: unknown): boolean {
  if (key === 'sendShortcut') {
    if (value !== 'enter' && value !== 'cmd-enter') return false;
    target.sendShortcut = value;
  } else if (key === 'draftPersistence') {
    if (typeof value !== 'boolean') return false;
    target.draftPersistence = value;
  } else if (key === 'theme') {
    if (value !== 'light' && value !== 'dark' && value !== 'system') return false;
    target.theme = value;
  } else if (key === 'requestTimeoutSeconds') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 5 || value > 600) return false;
    target.requestTimeoutSeconds = value;
  } else if (key === 'readingTimeoutSeconds') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2_147_483) return false;
    target.readingTimeoutSeconds = value;
  } else if (key === 'subagentPanelOpenMode') {
    if (value !== 'tab' && value !== 'fullscreen') return false;
    target.subagentPanelOpenMode = value;
  } else if (key === 'defaultAppendTiming') {
    if (value !== 'agent_idle' && value !== 'subagents_done' && value !== 'tasks_done') return false;
    target.defaultAppendTiming = value;
  } else if (key === 'foldSteps') {
    if (typeof value !== 'boolean') return false;
    target.foldSteps = value;
  } else if (key === 'worktreeSkipConfirm') {
    if (typeof value !== 'boolean') return false;
    target.worktreeSkipConfirm = value;
  } else if (key === 'railOpenByDefault') {
    if (typeof value !== 'boolean') return false;
    target.railOpenByDefault = value;
  } else if (key === 'motion') {
    if (value !== 'system' && value !== 'reduce' && value !== 'full') return false;
    target.motion = value;
  } else if (key === 'proseFont') {
    if (value !== 'serif' && value !== 'sans') return false;
    target.proseFont = value;
  } else {
    if (!isAwayNotifications(value)) return false;
    target.awayNotifications = value;
  }
  return true;
}

function writeDesktopSetting(target: Partial<DesktopSettings>, key: LocalSettingKey, value: unknown): boolean {
  if (key === 'sendShortcut') {
    if (value !== 'enter' && value !== 'cmd-enter') return false;
    target.sendShortcut = value;
  } else if (key === 'draftPersistence') {
    if (typeof value !== 'boolean') return false;
    target.draftPersistence = value;
  } else if (key === 'theme') {
    if (value !== 'light' && value !== 'dark' && value !== 'system') return false;
    target.theme = value;
  } else if (key === 'requestTimeoutSeconds') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 5 || value > 600) return false;
    target.requestTimeoutSeconds = value;
  } else if (key === 'readingTimeoutSeconds') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2_147_483) return false;
    target.readingTimeoutSeconds = value;
  } else if (key === 'subagentPanelOpenMode') {
    if (value !== 'tab' && value !== 'fullscreen') return false;
    target.subagentPanelOpenMode = value;
  } else if (key === 'defaultAppendTiming') {
    if (value !== 'agent_idle' && value !== 'subagents_done' && value !== 'tasks_done') return false;
    target.defaultAppendTiming = value;
  } else if (key === 'foldSteps') {
    if (typeof value !== 'boolean') return false;
    target.foldSteps = value;
  } else if (key === 'worktreeSkipConfirm') {
    if (typeof value !== 'boolean') return false;
    target.worktreeSkipConfirm = value;
  } else if (key === 'railOpenByDefault') {
    if (typeof value !== 'boolean') return false;
    target.railOpenByDefault = value;
  } else if (key === 'motion') {
    if (value !== 'system' && value !== 'reduce' && value !== 'full') return false;
    target.motion = value;
  } else if (key === 'proseFont') {
    if (value !== 'serif' && value !== 'sans') return false;
    target.proseFont = value;
  } else {
    if (!isAwayNotifications(value)) return false;
    target.awayNotifications = value;
  }
  return true;
}

function validLayoutValue(key: LayoutTransferKey, value: unknown): boolean {
  if (key === 'sidebarWidth') return typeof value === 'number' && Number.isFinite(value);
  if (key === 'railWidth') return typeof value === 'number' && Number.isFinite(value);
  if (key === 'sidebarCollapsed' || key === 'sidebarNavSectionCollapsed') return typeof value === 'boolean';
  if (key === 'pinnedNavItems') return Array.isArray(value) && value.every((item) => typeof item === 'string');
  if (key === 'groupBy') return value === 'time' || value === 'workspace' || value === 'none';
  return value === 'updated-desc' || value === 'updated-asc' || value === 'created-desc' || value === 'title';
}

function validDesktopValue(key: DesktopTransferKey, value: unknown): boolean {
  return (key === 'notifications' || key === 'closeToTray') && typeof value === 'boolean';
}

function toLocalPreferences(value: SettingsTransferPreferences | undefined): SettingsTransferPreferences | undefined {
  if (value === undefined) return undefined;
  const settings = value.settings;
  const layout = value.layout;
  const desktop = value.desktop;
  const nextSettings: NonNullable<SettingsTransferPreferences['settings']> = {};
  const nextLayout: NonNullable<SettingsTransferPreferences['layout']> = {};
  const nextDesktop: NonNullable<SettingsTransferPreferences['desktop']> = {};
  if (settings !== undefined) {
    for (const key of LOCAL_SETTING_KEYS) {
      const value = readTransferSetting(settings, key);
      if (value !== undefined) writeTransferSetting(nextSettings, key, value);
    }
  }
  if (layout !== undefined) {
    if (layout.sidebarWidth !== undefined) nextLayout.sidebarWidth = layout.sidebarWidth;
    if (layout.railWidth !== undefined) nextLayout.railWidth = layout.railWidth;
    if (layout.sidebarCollapsed !== undefined) nextLayout.sidebarCollapsed = layout.sidebarCollapsed;
    if (layout.pinnedNavItems !== undefined) nextLayout.pinnedNavItems = [...layout.pinnedNavItems];
    if (layout.sidebarNavSectionCollapsed !== undefined) nextLayout.sidebarNavSectionCollapsed = layout.sidebarNavSectionCollapsed;
    if (layout.groupBy !== undefined) nextLayout.groupBy = layout.groupBy;
    if (layout.sortBy !== undefined) nextLayout.sortBy = layout.sortBy;
  }
  if (desktop !== undefined) {
    if (desktop.notifications !== undefined) nextDesktop.notifications = desktop.notifications;
    if (desktop.closeToTray !== undefined) nextDesktop.closeToTray = desktop.closeToTray;
  }
  const next: {
    settings?: NonNullable<SettingsTransferPreferences['settings']>;
    layout?: NonNullable<SettingsTransferPreferences['layout']>;
    desktop?: NonNullable<SettingsTransferPreferences['desktop']>;
    locale?: 'en' | 'zh';
  } = {};
  if (Object.keys(nextSettings).length > 0) next.settings = nextSettings;
  if (Object.keys(nextLayout).length > 0) next.layout = nextLayout;
  if (Object.keys(nextDesktop).length > 0) next.desktop = nextDesktop;
  if (value.locale !== undefined) next.locale = value.locale;
  if (Object.keys(next).length === 0) return undefined;
  const parsed = settingsTransferPreferencesSchema.safeParse(next);
  return parsed.success ? parsed.data : undefined;
}

function localPreferenceEntries(value: SettingsTransferPreferences | undefined): LocalPreferenceEntry[] {
  if (value === undefined) return [];
  const entries: LocalPreferenceEntry[] = [];
  if (value.settings !== undefined) {
    for (const key of LOCAL_SETTING_KEYS) {
      const item = readTransferSetting(value.settings, key);
      if (item !== undefined) entries.push({ key: `settings.${key}`, value: item });
    }
  }
  if (value.layout !== undefined) {
    for (const key of LAYOUT_KEYS) {
      const item = value.layout[key];
      if (item !== undefined) entries.push({ key: `layout.${key}`, value: item });
    }
  }
  if (value.desktop !== undefined) {
    for (const key of DESKTOP_KEYS) {
      const item = value.desktop[key];
      if (item !== undefined) entries.push({ key: `desktop.${key}`, value: item });
    }
  }
  if (value.locale !== undefined) entries.push({ key: 'locale', value: value.locale });
  return entries;
}

function equalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equalValue(value, right[index]));
  }
  if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null && !Array.isArray(left) && !Array.isArray(right)) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = Object.keys(leftRecord);
    return keys.length === Object.keys(rightRecord).length && keys.every((key) => equalValue(leftRecord[key], rightRecord[key]));
  }
  return false;
}

function preferenceValue(preferences: SettingsTransferPreferences | undefined, key: string): unknown {
  const [group, field] = key.split('.', 2);
  if (group === 'settings' && preferences?.settings !== undefined && field !== undefined) return preferences.settings[field as keyof NonNullable<SettingsTransferPreferences['settings']>];
  if (group === 'layout' && preferences?.layout !== undefined && field !== undefined) return preferences.layout[field as keyof NonNullable<SettingsTransferPreferences['layout']>];
  if (group === 'desktop' && preferences?.desktop !== undefined && field !== undefined) return preferences.desktop[field as keyof NonNullable<SettingsTransferPreferences['desktop']>];
  if (group === 'locale') return preferences?.locale;
  return undefined;
}

function hasPreference(preferences: SettingsTransferPreferences | undefined, key: string): boolean {
  const [group, field] = key.split('.', 2);
  if (group === 'locale') return preferences?.locale !== undefined;
  if (field === undefined) return false;
  const source = group === 'settings' ? preferences?.settings : group === 'layout' ? preferences?.layout : preferences?.desktop;
  return source !== undefined && hasOwn(source, field);
}

function getCurrentPreference(key: string, current: SettingsTransferPreferences | undefined): unknown {
  return preferenceValue(current, key);
}

function preferencePatchAllowed(key: string, current: SettingsTransferPreferences | undefined, mode: SettingsTransferMode): boolean {
  return mode === 'overwrite' || !hasPreference(current, key);
}

function readLocalPreferencesFromStorage(): SettingsTransferPreferences | undefined {
  const storedSettings = readStoredRecord(SETTINGS_STORAGE_KEY);
  const storedLayout = readStoredRecord(LAYOUT_STORAGE_KEY);
  const storedDesktop = readStoredRecord(DESKTOP_STORAGE_KEY);
  if (typeof localStorage === 'undefined') return undefined;
  const deviceSettings = readDeviceSettings();
  const layoutPreferences = readLayoutPreferences();
  const desktopPreferences = readDesktopPrefs();
  const settings: NonNullable<SettingsTransferPreferences['settings']> = {};
  const layout: NonNullable<SettingsTransferPreferences['layout']> = {};
  const desktop: NonNullable<SettingsTransferPreferences['desktop']> = {};

  for (const key of LOCAL_SETTING_KEYS) {
    const persisted = storedSettings[key];
    if (hasOwn(storedSettings, key) && isLocalSettingValue(key, persisted)) {
      writeTransferSetting(settings, key, readDesktopSetting(deviceSettings, key));
    }
  }

  if (hasOwn(storedLayout, 'sidebarWidth') && validLayoutValue('sidebarWidth', layoutPreferences.sidebarWidth)) layout.sidebarWidth = layoutPreferences.sidebarWidth;
  if (hasOwn(storedLayout, 'railWidth') && validLayoutValue('railWidth', layoutPreferences.railWidth)) layout.railWidth = layoutPreferences.railWidth;
  if (hasOwn(storedLayout, 'sidebarCollapsed') && validLayoutValue('sidebarCollapsed', layoutPreferences.sidebarCollapsed)) layout.sidebarCollapsed = layoutPreferences.sidebarCollapsed;
  if (hasOwn(storedLayout, 'pinnedNavItems') && validLayoutValue('pinnedNavItems', layoutPreferences.pinnedNavItems)) layout.pinnedNavItems = [...layoutPreferences.pinnedNavItems];
  if (hasOwn(storedLayout, 'sidebarNavSectionCollapsed') && validLayoutValue('sidebarNavSectionCollapsed', layoutPreferences.sidebarNavSectionCollapsed)) layout.sidebarNavSectionCollapsed = layoutPreferences.sidebarNavSectionCollapsed;
  if (hasOwn(storedLayout, 'groupBy') && validLayoutValue('groupBy', layoutPreferences.groupBy)) layout.groupBy = layoutPreferences.groupBy;
  if (hasOwn(storedLayout, 'sortBy') && validLayoutValue('sortBy', layoutPreferences.sortBy)) layout.sortBy = layoutPreferences.sortBy;

  if (hasOwn(storedDesktop, 'notifications') && validDesktopValue('notifications', desktopPreferences.notifications)) desktop.notifications = desktopPreferences.notifications;
  if (hasOwn(storedDesktop, 'closeToTray') && validDesktopValue('closeToTray', desktopPreferences.closeToTray)) desktop.closeToTray = desktopPreferences.closeToTray;
  const locale = readStoredLocale();
  const next: {
    settings?: NonNullable<SettingsTransferPreferences['settings']>;
    layout?: NonNullable<SettingsTransferPreferences['layout']>;
    desktop?: NonNullable<SettingsTransferPreferences['desktop']>;
    locale?: 'en' | 'zh';
  } = {};
  if (Object.keys(settings).length > 0) next.settings = settings;
  if (Object.keys(layout).length > 0) next.layout = layout;
  if (Object.keys(desktop).length > 0) next.desktop = desktop;
  if (locale !== undefined) next.locale = locale;
  if (Object.keys(next).length === 0) return undefined;
  const parsed = settingsTransferPreferencesSchema.safeParse(next);
  return parsed.success ? parsed.data : undefined;
}

export function readLocalSettingsTransferPreferences(): SettingsTransferPreferences | undefined {
  return readLocalPreferencesFromStorage();
}

export function parseSettingsTransferPackage(value: unknown): SettingsTransferPackage | undefined {
  const parsed = settingsTransferPackageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function attachLocalSettingsTransferPreferences(bundle: SettingsTransferPackage): SettingsTransferPackage {
  if (!bundle.categories.includes('appearance')) return bundle;
  const preferences = readLocalSettingsTransferPreferences();
  const next = preferences === undefined ? { ...bundle, preferences: undefined } : { ...bundle, preferences };
  const parsed = settingsTransferPackageSchema.safeParse(next);
  return parsed.success ? parsed.data : bundle;
}

export function countLocalSettingsTransferPreferences(preferences = readLocalSettingsTransferPreferences()): number {
  return localPreferenceEntries(preferences).length;
}

function updateSummary(summary: SettingsTransferCategorySummary, local: LocalSettingsTransferPreview): SettingsTransferCategorySummary {
  return {
    ...summary,
    items: summary.items + local.items,
    added: summary.added + local.added,
    conflicts: summary.conflicts + local.conflicts,
    unchanged: summary.unchanged + local.unchanged,
    skipped: summary.skipped + local.skipped,
  };
}

export function withLocalSettingsTransferCatalog(catalog: SettingsTransferCatalog): SettingsTransferCatalog {
  const count = countLocalSettingsTransferPreferences();
  if (count === 0) return catalog;
  return {
    ...catalog,
    categories: catalog.categories.map((summary) => summary.id === 'appearance' ? { ...summary, items: summary.items + count } : summary),
  };
}

export function previewLocalSettingsTransferPreferences(
  preferences: SettingsTransferPreferences | undefined,
  selectedCategories: readonly SettingsTransferCategory[],
  mode: SettingsTransferMode,
): LocalSettingsTransferPreview {
  const incoming = toLocalPreferences(preferences);
  const entries = localPreferenceEntries(incoming);
  if (entries.length === 0) return { items: 0, added: 0, conflicts: 0, unchanged: 0, skipped: 0 };
  if (!selectedCategories.includes('appearance')) return { items: entries.length, added: 0, conflicts: 0, unchanged: 0, skipped: entries.length };
  const current = readLocalSettingsTransferPreferences();
  const result = { items: entries.length, added: 0, conflicts: 0, unchanged: 0, skipped: 0 };
  for (const entry of entries) {
    const previous = getCurrentPreference(entry.key, current);
    if (!hasPreference(current, entry.key)) {
      result.added += 1;
    } else if (equalValue(previous, entry.value)) {
      result.unchanged += 1;
      result.skipped += 1;
    } else {
      result.conflicts += 1;
      if (mode === 'append') result.skipped += 1;
    }
  }
  return result;
}

export function withLocalSettingsTransferPreview(
  preview: SettingsTransferPreview,
  bundle: SettingsTransferPackage,
  selectedCategories: readonly SettingsTransferCategory[],
  mode: SettingsTransferMode,
): SettingsTransferPreview {
  const local = previewLocalSettingsTransferPreferences(bundle.preferences, selectedCategories, mode);
  if (local.items === 0) return preview;
  return {
    ...preview,
    categories: preview.categories.map((summary) => summary.id === 'appearance' ? updateSummary(summary, local) : summary),
  };
}

function applySettingPatch(
  patch: Partial<DesktopSettings>,
  expected: NonNullable<SettingsTransferPreferences['settings']>,
  incoming: NonNullable<SettingsTransferPreferences['settings']> | undefined,
  current: SettingsTransferPreferences | undefined,
  mode: SettingsTransferMode,
  attempted: string[],
): void {
  if (incoming === undefined) return;
  for (const key of LOCAL_SETTING_KEYS) {
    const value = readTransferSetting(incoming, key);
    if (value === undefined) continue;
    const fullKey = `settings.${key}`;
    if (preferencePatchAllowed(fullKey, current, mode)) {
      if (writeDesktopSetting(patch, key, value) && writeTransferSetting(expected, key, value)) attempted.push(fullKey);
      continue;
    }
    const previous = readTransferSetting(current?.settings, key);
    if (previous !== undefined) writeTransferSetting(expected, key, previous);
  }
}

function applyLayoutPatch(
  patch: Partial<LayoutPreferences>,
  expected: NonNullable<SettingsTransferPreferences['layout']>,
  incoming: NonNullable<SettingsTransferPreferences['layout']> | undefined,
  current: SettingsTransferPreferences | undefined,
  mode: SettingsTransferMode,
  attempted: string[],
): void {
  if (incoming === undefined) return;
  if (incoming.sidebarWidth !== undefined) {
    if (preferencePatchAllowed('layout.sidebarWidth', current, mode)) {
      patch.sidebarWidth = incoming.sidebarWidth;
      expected.sidebarWidth = incoming.sidebarWidth;
      attempted.push('layout.sidebarWidth');
    } else if (current?.layout?.sidebarWidth !== undefined) expected.sidebarWidth = current.layout.sidebarWidth;
  }
  if (incoming.railWidth !== undefined) {
    if (preferencePatchAllowed('layout.railWidth', current, mode)) {
      patch.railWidth = incoming.railWidth;
      expected.railWidth = incoming.railWidth;
      attempted.push('layout.railWidth');
    } else if (current?.layout?.railWidth !== undefined) expected.railWidth = current.layout.railWidth;
  }
  if (incoming.sidebarCollapsed !== undefined) {
    if (preferencePatchAllowed('layout.sidebarCollapsed', current, mode)) {
      patch.sidebarCollapsed = incoming.sidebarCollapsed;
      expected.sidebarCollapsed = incoming.sidebarCollapsed;
      attempted.push('layout.sidebarCollapsed');
    } else if (current?.layout?.sidebarCollapsed !== undefined) expected.sidebarCollapsed = current.layout.sidebarCollapsed;
  }
  if (incoming.pinnedNavItems !== undefined) {
    if (preferencePatchAllowed('layout.pinnedNavItems', current, mode)) {
      patch.pinnedNavItems = [...incoming.pinnedNavItems];
      expected.pinnedNavItems = [...incoming.pinnedNavItems];
      attempted.push('layout.pinnedNavItems');
    } else if (current?.layout?.pinnedNavItems !== undefined) expected.pinnedNavItems = [...current.layout.pinnedNavItems];
  }
  if (incoming.sidebarNavSectionCollapsed !== undefined) {
    if (preferencePatchAllowed('layout.sidebarNavSectionCollapsed', current, mode)) {
      patch.sidebarNavSectionCollapsed = incoming.sidebarNavSectionCollapsed;
      expected.sidebarNavSectionCollapsed = incoming.sidebarNavSectionCollapsed;
      attempted.push('layout.sidebarNavSectionCollapsed');
    } else if (current?.layout?.sidebarNavSectionCollapsed !== undefined) expected.sidebarNavSectionCollapsed = current.layout.sidebarNavSectionCollapsed;
  }
  if (incoming.groupBy !== undefined) {
    if (preferencePatchAllowed('layout.groupBy', current, mode)) {
      patch.groupBy = incoming.groupBy;
      expected.groupBy = incoming.groupBy;
      attempted.push('layout.groupBy');
    } else if (current?.layout?.groupBy !== undefined) expected.groupBy = current.layout.groupBy;
  }
  if (incoming.sortBy !== undefined) {
    if (preferencePatchAllowed('layout.sortBy', current, mode)) {
      patch.sortBy = incoming.sortBy;
      expected.sortBy = incoming.sortBy;
      attempted.push('layout.sortBy');
    } else if (current?.layout?.sortBy !== undefined) expected.sortBy = current.layout.sortBy;
  }
}

function applyDesktopPatch(
  patch: Partial<DesktopNativePrefs>,
  expected: NonNullable<SettingsTransferPreferences['desktop']>,
  incoming: NonNullable<SettingsTransferPreferences['desktop']> | undefined,
  current: SettingsTransferPreferences | undefined,
  mode: SettingsTransferMode,
  attempted: string[],
): void {
  if (incoming === undefined) return;
  for (const key of DESKTOP_KEYS) {
    const value = incoming[key];
    if (value === undefined) continue;
    const fullKey = `desktop.${key}`;
    if (preferencePatchAllowed(fullKey, current, mode)) {
      patch[key] = value;
      expected[key] = value;
      attempted.push(fullKey);
    } else {
      const previous = current?.desktop?.[key];
      if (previous !== undefined) expected[key] = previous;
    }
  }
}

function applyLocale(
  incoming: 'en' | 'zh' | undefined,
  current: SettingsTransferPreferences | undefined,
  mode: SettingsTransferMode,
  attempted: string[],
): 'en' | 'zh' | undefined {
  if (incoming === undefined || !preferencePatchAllowed('locale', current, mode)) return current?.locale;
  attempted.push('locale');
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, incoming);
  } catch {
    return undefined;
  }
  return incoming;
}

export async function applyLocalSettingsTransferPreferences(
  preferences: SettingsTransferPreferences | undefined,
  mode: SettingsTransferMode,
  desktopBridge?: SettingsTransferDesktopBridge,
): Promise<LocalSettingsTransferApplyResult> {
  const incoming = toLocalPreferences(preferences);
  if (incoming === undefined) return { status: 'complete', appliedKeys: [], failedKeys: [], preferences: readLocalSettingsTransferPreferences() };
  const current = readLocalSettingsTransferPreferences();
  const storedLayout = readStoredRecord(LAYOUT_STORAGE_KEY);
  const storedDesktop = readStoredRecord(DESKTOP_STORAGE_KEY);
  const attempted: string[] = [];
  const failed = new Set<string>();
  const expectedSettings: NonNullable<SettingsTransferPreferences['settings']> = {};
  const expectedLayout: NonNullable<SettingsTransferPreferences['layout']> = {};
  const expectedDesktop: NonNullable<SettingsTransferPreferences['desktop']> = {};
  const settingsPatch: Partial<DesktopSettings> = {};
  const layoutPatch: Partial<LayoutPreferences> = {};
  const desktopPatch: Partial<DesktopNativePrefs> = {};

  applySettingPatch(settingsPatch, expectedSettings, incoming.settings, current, mode, attempted);
  applyLayoutPatch(layoutPatch, expectedLayout, incoming.layout, current, mode, attempted);
  applyDesktopPatch(desktopPatch, expectedDesktop, incoming.desktop, current, mode, attempted);
  const expectedLocale = applyLocale(incoming.locale, current, mode, attempted);

  if (Object.keys(settingsPatch).length > 0) {
    try { writeSettings(settingsPatch); } catch { for (const key of attempted.filter((entry) => entry.startsWith('settings.'))) failed.add(key); }
  }
  if (Object.keys(layoutPatch).length > 0) {
    try {
      writeLayoutPreferences(layoutPatch);
      preserveSparseStorageRecord(LAYOUT_STORAGE_KEY, storedLayout, layoutPatch);
    } catch { for (const key of attempted.filter((entry) => entry.startsWith('layout.'))) failed.add(key); }
  }
  if (Object.keys(desktopPatch).length > 0) {
    try {
      writeDesktopPrefs(desktopPatch);
      preserveSparseStorageRecord(DESKTOP_STORAGE_KEY, storedDesktop, desktopPatch);
    } catch { for (const key of attempted.filter((entry) => entry.startsWith('desktop.'))) failed.add(key); }
    if (desktopBridge?.write !== undefined) {
      try { await desktopBridge.write(desktopPatch); } catch { for (const key of attempted.filter((entry) => entry.startsWith('desktop.'))) failed.add(key); }
    }
  }

  const readback = readLocalSettingsTransferPreferences();
  for (const key of attempted) {
    const expected = key === 'locale'
      ? expectedLocale
      : key.startsWith('settings.')
        ? preferenceValue({ settings: expectedSettings }, key)
        : key.startsWith('layout.')
          ? preferenceValue({ layout: expectedLayout }, key)
          : preferenceValue({ desktop: expectedDesktop }, key);
    if (!hasPreference(readback, key) || !equalValue(preferenceValue(readback, key), expected)) failed.add(key);
  }

  if (Object.keys(desktopPatch).length > 0 && desktopBridge?.read !== undefined) {
    try {
      const native = await desktopBridge.read();
      if (native === null) {
        for (const key of attempted.filter((entry) => entry.startsWith('desktop.'))) failed.add(key);
      } else {
        for (const key of DESKTOP_KEYS) {
          const fullKey = `desktop.${key}`;
          if (attempted.includes(fullKey) && !equalValue(native[key], expectedDesktop[key])) failed.add(fullKey);
        }
      }
    } catch {
      for (const key of attempted.filter((entry) => entry.startsWith('desktop.'))) failed.add(key);
    }
  }

  const failedKeys = [...failed];
  return {
    status: failedKeys.length === 0 ? 'complete' : 'partial',
    appliedKeys: attempted.filter((key) => !failed.has(key)),
    failedKeys,
    preferences: readback,
  };
}

export function settingsTransferPackageBytes(bundle: SettingsTransferPackage): number {
  return new TextEncoder().encode(JSON.stringify(bundle)).byteLength;
}

export function settingsTransferPackageWithinLimit(bundle: SettingsTransferPackage): boolean {
  return settingsTransferPackageBytes(bundle) <= SETTINGS_TRANSFER_MAX_BYTES;
}
