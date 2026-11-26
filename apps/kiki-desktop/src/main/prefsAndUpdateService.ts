import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { atomicWriteJson } from '@kiki/kaos/atomic-fs';
import { readSpaceHome } from '@kiki/kaos/space-home';
import { quoteShellArg } from '@kiki/shell-quoting';
import { dirname, isAbsolute, join } from 'pathe';
import { z } from 'zod';
import {
  cleanupStaleWindowsElectronRunEntries,
  createDefaultWindowsRegistryRunner,
  formatAutostartCommand,
  readLinuxAutostartStatus,
  resolveAutostartExecutablePath,
  resolveLinuxAutostartDesktopPath,
  WINDOWS_RUN_KEY,
  WINDOWS_RUN_VALUE_NAME,
  writeLinuxAutostartStatus,
  type WindowsRegistryRunner,
} from '#/main/autostart';
import { desktopPrefsPatchSchema } from '#/shared/ipcChannels';
import type {
  DesktopAutostartStatus,
  DesktopNativePrefs,
  DesktopSpace,
  DesktopUpdateMutation,
  DesktopUpdateOffer,
  DesktopUpdateState,
  SpaceShortcutErrorCode,
  SpaceShortcutResult,
  SpaceWindowMode,
  UpdateChannel,
} from '#/shared/types';

export type DesktopWindowTheme = 'light' | 'dark' | 'system';
export type DesktopDistribution = 'github' | 'local' | 'custom';

export function normalizeHttpsUpdaterFeedBaseUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (trimmed === '' || /[\u0000-\u001F\u007F\s]/.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname === '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return null;
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

export function resolveCustomUpdaterFeedUrl(
  updaterFeedBaseUrl: string | undefined,
  channel: UpdateChannel,
): string | null {
  const base = normalizeHttpsUpdaterFeedBaseUrl(updaterFeedBaseUrl);
  return base === null ? null : `${base}/${channel}`;
}

export interface DesktopBuildReceiptUpdaterMeta {
  readonly distribution?: DesktopDistribution;
  readonly updaterFeedBaseUrl?: string;
}

export function readDesktopBuildReceiptUpdaterMeta(
  candidatePaths: readonly string[],
): DesktopBuildReceiptUpdaterMeta {
  for (const receiptPath of candidatePaths) {
    if (!existsSync(receiptPath)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(receiptPath, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      const rawDist = record['distribution'];
      const distribution: DesktopDistribution | undefined =
        rawDist === 'github' || rawDist === 'local' || rawDist === 'custom' ? rawDist : undefined;
      const normalizedFeed = normalizeHttpsUpdaterFeedBaseUrl(record['updaterFeedBaseUrl']);
      return {
        ...(distribution !== undefined ? { distribution } : {}),
        ...(normalizedFeed !== null ? { updaterFeedBaseUrl: normalizedFeed } : {}),
      };
    } catch {
      continue;
    }
  }
  return {};
}

export function resolveDesktopUpdaterConfig(input: {
  readonly isPackaged: boolean;
  readonly envDistribution?: string;
  readonly envUpdaterFeedBaseUrl?: string;
  readonly receipt?: DesktopBuildReceiptUpdaterMeta;
  readonly bakedDistribution?: string;
  readonly bakedUpdaterFeedBaseUrl?: string;
}): {
  readonly distribution: DesktopDistribution;
  readonly updaterFeedBaseUrl?: string;
} {
  const pickDistribution = (value: string | undefined): DesktopDistribution | undefined => {
    const trimmed = value?.trim();
    return trimmed === 'github' || trimmed === 'local' || trimmed === 'custom'
      ? trimmed
      : undefined;
  };
  const distribution: DesktopDistribution =
    pickDistribution(input.envDistribution) ??
    input.receipt?.distribution ??
    pickDistribution(input.bakedDistribution) ??
    (input.isPackaged ? 'github' : 'local');

  const rawFeedCandidate =
    (input.envUpdaterFeedBaseUrl !== undefined && input.envUpdaterFeedBaseUrl.trim() !== ''
      ? input.envUpdaterFeedBaseUrl
      : undefined) ??
    input.receipt?.updaterFeedBaseUrl ??
    (input.bakedUpdaterFeedBaseUrl !== undefined && input.bakedUpdaterFeedBaseUrl.trim() !== ''
      ? input.bakedUpdaterFeedBaseUrl
      : undefined);
  const normalizedFeed = normalizeHttpsUpdaterFeedBaseUrl(rawFeedCandidate);

  return {
    distribution,
    ...(normalizedFeed !== null ? { updaterFeedBaseUrl: normalizedFeed } : {}),
  };
}

export interface AutoUpdaterDriver {
  autoDownload: boolean;
  allowPrerelease: boolean;
  channel: string | null;
  setFeedURL(options: { readonly provider: 'generic'; readonly url: string }): void;
  checkForUpdates(): Promise<{
    readonly updateInfo?: {
      readonly version: string;
      readonly releaseDate?: string;
      readonly releaseNotes?: unknown;
    };
  } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

export function createElectronUpdaterAdapter(params: {
  readonly autoUpdater: AutoUpdaterDriver;
  readonly getCurrentVersion: () => string;
  readonly distribution: DesktopDistribution;
  readonly updaterFeedBaseUrl?: string;
  readonly getEnvFeedUrlOverride?: () => string | undefined;
}): UpdaterFeedAdapter {
  const applyChannelAndFeed = (channel: UpdateChannel): void => {
    params.autoUpdater.allowPrerelease = channel === 'beta';
    params.autoUpdater.channel = channel === 'beta' ? 'beta' : 'latest';
    if (params.distribution === 'custom') {
      const customFeedUrl = resolveCustomUpdaterFeedUrl(params.updaterFeedBaseUrl, channel);
      if (customFeedUrl === null) {
        throw new Error('Desktop updater is not available for this distribution');
      }
      params.autoUpdater.setFeedURL({ provider: 'generic', url: customFeedUrl });
      return;
    }
    const envOverride = params.getEnvFeedUrlOverride?.()?.trim();
    if (envOverride !== undefined && envOverride !== '') {
      params.autoUpdater.setFeedURL({ provider: 'generic', url: envOverride });
    }
  };

  return {
    async checkForUpdate(channel: UpdateChannel): Promise<DesktopUpdateOffer | null> {
      params.autoUpdater.autoDownload = false;
      applyChannelAndFeed(channel);
      const result = await params.autoUpdater.checkForUpdates();
      const info = result?.updateInfo;
      const currentVersion = params.getCurrentVersion();
      if (info === undefined || info.version === currentVersion) return null;
      return {
        currentVersion,
        version: info.version,
        date: info.releaseDate,
        notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      };
    },
    async downloadAndInstall(channel: UpdateChannel): Promise<void> {
      applyChannelAndFeed(channel);
      await params.autoUpdater.downloadUpdate();
      params.autoUpdater.quitAndInstall();
    },
  };
}

const UPDATE_CHECK_CACHE_TTL_MS = 30_000;
const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const windowThemeSchema = z.enum(['light', 'dark', 'system']);

export const DEFAULT_DESKTOP_PREFS: DesktopNativePrefs = {
  notifications: true,
  closeToTray: true,
  updateChannel: 'stable',
  autoUpdate: 'notify',
  logLevel: 'warn',
  compatibility: { homeKind: 'kimi' },
  windowMode: 'switch',
};

const nonEmptyStringListSchema = z
  .array(z.unknown())
  .transform((items) =>
    items.filter((item): item is string => typeof item === 'string' && item.trim() !== ''),
  );

const desktopUpdateStateParsedSchema = z
  .object({
    skipped: z
      .object({
        stable: nonEmptyStringListSchema.optional().catch(undefined),
        beta: nonEmptyStringListSchema.optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
    snoozedUntil: z.number().finite().nonnegative().optional().catch(undefined),
    lastCheckedAt: z.number().finite().nonnegative().optional().catch(undefined),
  })
  .transform((record): DesktopUpdateState | undefined => {
    const skipped =
      record.skipped?.stable !== undefined || record.skipped?.beta !== undefined
        ? {
            ...(record.skipped.stable !== undefined ? { stable: record.skipped.stable } : {}),
            ...(record.skipped.beta !== undefined ? { beta: record.skipped.beta } : {}),
          }
        : undefined;
    if (
      skipped === undefined &&
      record.snoozedUntil === undefined &&
      record.lastCheckedAt === undefined
    ) {
      return undefined;
    }
    return {
      ...(skipped !== undefined ? { skipped } : {}),
      ...(record.snoozedUntil !== undefined ? { snoozedUntil: record.snoozedUntil } : {}),
      ...(record.lastCheckedAt !== undefined ? { lastCheckedAt: record.lastCheckedAt } : {}),
    };
  })
  .catch(undefined);

const compatibilityParsedSchema = z
  .object({
    homeKind: z.enum(['kimi', 'kiki', 'custom']).catch('kimi'),
    customHome: z.string().optional().catch(undefined),
  })
  .transform((compat) => ({
    homeKind: compat.homeKind,
    ...(compat.customHome !== undefined && compat.customHome.trim() !== ''
      ? { customHome: compat.customHome }
      : {}),
  }))
  .catch({ homeKind: 'kimi' as const });

const mainPrefsRecordSchema = z
  .object({
    notifications: z.boolean().catch(DEFAULT_DESKTOP_PREFS.notifications),
    closeToTray: z.boolean().catch(DEFAULT_DESKTOP_PREFS.closeToTray),
    locale: z.string().optional().catch(undefined),
    updateChannel: z.enum(['stable', 'beta']).catch(DEFAULT_DESKTOP_PREFS.updateChannel),
    autoUpdate: z.enum(['off', 'notify', 'install']).catch(DEFAULT_DESKTOP_PREFS.autoUpdate),
    updateState: z.unknown().transform((val) => desktopUpdateStateParsedSchema.parse(val)),
    logLevel: logLevelSchema.catch('warn'),
    compatibility: z.unknown().transform((val) => compatibilityParsedSchema.parse(val)),
    windowMode: z.enum(['switch', 'windows']).optional().catch(undefined),
    window_mode: z.enum(['switch', 'windows']).optional().catch(undefined),
  })
  .transform(
    (record): DesktopNativePrefs => ({
      notifications: record.notifications,
      closeToTray: record.closeToTray,
      ...(record.locale !== undefined ? { locale: record.locale } : {}),
      updateChannel: record.updateChannel,
      autoUpdate: record.autoUpdate,
      ...(record.updateState !== undefined ? { updateState: record.updateState } : {}),
      logLevel: record.logLevel,
      compatibility: record.compatibility,
      windowMode: record.windowMode ?? record.window_mode ?? DEFAULT_DESKTOP_PREFS.windowMode,
    }),
  )
  .catch({ ...DEFAULT_DESKTOP_PREFS });

const childPrefsOverrideSchema = z
  .object({
    notifications: z.boolean().optional().catch(undefined),
    closeToTray: z.boolean().optional().catch(undefined),
    locale: z.string().optional().catch(undefined),
    logLevel: logLevelSchema.optional().catch(undefined),
    compatibility: z
      .object({
        homeKind: z.enum(['kimi', 'kiki', 'custom']),
        customHome: z.string().optional(),
      })
      .transform((compat) => ({
        homeKind: compat.homeKind,
        ...(compat.customHome !== undefined && compat.customHome.trim() !== ''
          ? { customHome: compat.customHome }
          : {}),
      }))
      .optional()
      .catch(undefined),
  })
  .catch({});

export async function readDesktopSpaceToml(homeDir: string): Promise<DesktopSpace | null> {
  const { space, diagnostic } = readSpaceHome(homeDir);
  if (diagnostic !== undefined) {
    throw new Error(diagnostic);
  }
  if (space === undefined) return null;
  return {
    homeId: space.id,
    name: space.name,
    color: space.color ?? null,
    preset: space.preset ?? null,
    path: homeDir,
    baseHome: space.baseHomeDir ?? null,
    credentialsShared: space.inherit.credentials !== 'isolated',
    isPrimary: space.id === 'main',
  };
}

export async function resolveDesktopOauthHome(params: {
  readonly homeDir: string;
  readonly prefs: DesktopNativePrefs;
  readonly kimiHome: string;
  readonly space?: DesktopSpace | null;
}): Promise<string> {
  const space =
    params.space === undefined
      ? await readDesktopSpaceToml(params.homeDir).catch(() => null)
      : params.space;
  if (space !== null && !space.credentialsShared && space.baseHome !== null) {
    return space.path;
  }
  const compatibilityKikiHome = space?.baseHome ?? params.homeDir;
  const { compatibility } = params.prefs;
  if (compatibility.homeKind === 'custom') {
    const customHome = compatibility.customHome?.trim() ?? '';
    if (customHome === '' || !isAbsolute(customHome)) {
      throw new Error('Custom compatibility Home must be an absolute path');
    }
    return customHome;
  }
  if (compatibility.homeKind === 'kiki') {
    return compatibilityKikiHome;
  }
  return params.kimiHome;
}

export function formatSpaceShortcutFileName(name: string, homeId: string): string {
  const sanitized = Array.from(name)
    .map((ch) => (/[\u0000-\u001F\u007F<>:"/\\|?*]/.test(ch) ? '_' : ch))
    .slice(0, 60)
    .join('')
    .trim()
    .replace(/[. ]+$/, '');
  return `Kiki - ${sanitized === '' ? 'Space' : sanitized} (${homeId}).lnk`;
}

export function formatSpaceHomeArguments(
  spaceHomePath: string,
  platform: NodeJS.Platform = process.platform,
):
  | { readonly ok: true; readonly args: string }
  | { readonly ok: false; readonly code: SpaceShortcutErrorCode; readonly message: string } {
  const winAbs = /^[A-Za-z]:[\\/]/.test(spaceHomePath);
  const abs = platform === 'win32' ? winAbs : isAbsolute(spaceHomePath);
  if (!abs || spaceHomePath.includes('"') || /[\u0000-\u001F\u007F]/.test(spaceHomePath)) {
    return {
      ok: false,
      code: 'invalid_space',
      message: 'Space path is not a valid absolute directory',
    };
  }
  return {
    ok: true,
    args: `--home ${quoteShellArg(spaceHomePath, platform)}`,
  };
}

export interface LoginItemController {
  getLoginItemSettings(options?: { readonly path?: string; readonly args?: string[] }): {
    readonly openAtLogin: boolean;
  };
  setLoginItemSettings(settings: {
    readonly openAtLogin: boolean;
    readonly path?: string;
    readonly args?: string[];
  }): void;
}

export interface ShortcutWriter {
  writeShortcutLink(
    shortcutPath: string,
    operation: 'create',
    options: {
      readonly target: string;
      readonly args?: string;
      readonly description?: string;
      readonly cwd?: string;
      readonly icon?: string;
      readonly iconIndex?: number;
    },
  ): boolean;
}

export interface UpdaterFeedAdapter {
  checkForUpdate(channel: UpdateChannel): Promise<DesktopUpdateOffer | null>;
  downloadAndInstall(channel: UpdateChannel, version: string): Promise<void>;
}

export interface PrefsAndUpdateServiceDeps {
  readonly mainHome: string;
  readonly getActiveHome: () => string;
  readonly resolveLaunchExecutable: () => string;
  readonly loginItemController?: LoginItemController;
  readonly windowsRegistry?: WindowsRegistryRunner;
  readonly linuxDesktopEntryPath?: string;
  readonly shortcutWriter?: ShortcutWriter;
  readonly desktopDir?: string;
  readonly distribution?: DesktopDistribution;
  readonly updaterFeedBaseUrl?: string;
  readonly updaterAdapter?: UpdaterFeedAdapter;
  readonly confirmShutdownForUpdate?: () => Promise<boolean>;
  readonly prepareDaemonForUpdate?: () => Promise<void>;
  readonly releaseUpdateLocks?: () => void;
  readonly markInstallingUpdate?: (installing: boolean) => void;
  readonly onLocaleChanged?: (locale: string | undefined) => void;
  readonly onPrefsChanged?: (prefs: DesktopNativePrefs, homeDir: string) => void;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
}

export class PrefsAndUpdateService {
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly checkCache = new Map<
    UpdateChannel,
    { readonly at: number; readonly result: DesktopUpdateOffer | null }
  >();
  private installInFlight = false;

  constructor(private readonly deps: PrefsAndUpdateServiceDeps) {
    this.platform = deps.platform ?? process.platform;
    this.now = deps.now ?? Date.now;
  }

  private enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(fn, fn);
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private prefsFilePath(homeDir: string): string {
    return join(homeDir, 'desktop.json');
  }

  private async readRawPrefsObject(homeDir: string): Promise<Record<string, unknown> | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.prefsFilePath(homeDir), 'utf8'));
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  private preservedMainMeta(raw: Record<string, unknown> | null): {
    readonly autostart?: boolean;
    readonly theme?: DesktopWindowTheme;
  } {
    const autostart = typeof raw?.['autostart'] === 'boolean' ? raw['autostart'] : undefined;
    const parsedTheme = windowThemeSchema.safeParse(raw?.['theme']);
    return {
      ...(autostart !== undefined ? { autostart } : {}),
      ...(parsedTheme.success ? { theme: parsedTheme.data } : {}),
    };
  }

  async readWindowTheme(): Promise<DesktopWindowTheme> {
    const raw = await this.readRawPrefsObject(this.deps.mainHome);
    const parsed = windowThemeSchema.safeParse(raw?.['theme']);
    return parsed.success ? parsed.data : 'system';
  }

  async writeWindowTheme(theme: DesktopWindowTheme): Promise<void> {
    const validated = windowThemeSchema.parse(theme);
    await this.enqueueWrite(async () => {
      const raw = (await this.readRawPrefsObject(this.deps.mainHome)) ?? {};
      await atomicWriteJson(
        this.prefsFilePath(this.deps.mainHome),
        { ...raw, theme: validated },
        { indent: 2, preserveDestinationOnError: true },
      );
    });
  }

  async readPrefs(homeDir: string = this.deps.getActiveHome()): Promise<DesktopNativePrefs> {
    const mainRaw = await this.readRawPrefsObject(this.deps.mainHome);
    const mainPrefs = mainPrefsRecordSchema.parse(mainRaw ?? {});
    if (homeDir === this.deps.mainHome) return mainPrefs;

    const childRaw = await this.readRawPrefsObject(homeDir);
    const overrides = childPrefsOverrideSchema.parse(childRaw ?? {});
    const space = await readDesktopSpaceToml(homeDir).catch(() => null);
    const mergedLocale = overrides.locale ?? mainPrefs.locale;
    const compatibility =
      space !== null && !space.credentialsShared
        ? ({ homeKind: 'kiki' } as const)
        : (overrides.compatibility ?? mainPrefs.compatibility);

    return {
      notifications: overrides.notifications ?? mainPrefs.notifications,
      closeToTray: overrides.closeToTray ?? mainPrefs.closeToTray,
      ...(mergedLocale !== undefined ? { locale: mergedLocale } : {}),
      updateChannel: mainPrefs.updateChannel,
      autoUpdate: mainPrefs.autoUpdate,
      ...(mainPrefs.updateState !== undefined ? { updateState: mainPrefs.updateState } : {}),
      logLevel: overrides.logLevel ?? mainPrefs.logLevel,
      compatibility,
      windowMode: mainPrefs.windowMode,
    };
  }

  async writePrefs(
    patchInput: Partial<DesktopNativePrefs> & { readonly window_mode?: SpaceWindowMode },
    homeDir: string = this.deps.getActiveHome(),
  ): Promise<void> {
    const parsedPatch = desktopPrefsPatchSchema.parse(patchInput);
    await this.enqueueWrite(async () => {
      const current = await this.readPrefs(homeDir);
      const nextWindowMode = parsedPatch.windowMode ?? parsedPatch.window_mode ?? current.windowMode;
      const nextCompat = parsedPatch.compatibility ?? current.compatibility;
      if (nextCompat.homeKind === 'custom') {
        const customHome = nextCompat.customHome?.trim() ?? '';
        if (customHome === '' || !isAbsolute(customHome)) {
          throw new Error('Custom OAuth home must be an absolute path');
        }
      }
      const space = await readDesktopSpaceToml(homeDir);
      if (
        space !== null &&
        space.baseHome !== null &&
        !space.credentialsShared &&
        parsedPatch.compatibility !== undefined &&
        nextCompat.homeKind !== 'kiki'
      ) {
        throw new Error('Isolated spaces must use their own OAuth home');
      }

      let nextUpdateState = current.updateState;
      if (Object.hasOwn(parsedPatch, 'updateState')) {
        nextUpdateState =
          parsedPatch.updateState === null || parsedPatch.updateState === undefined
            ? undefined
            : desktopUpdateStateParsedSchema.parse(parsedPatch.updateState);
      }

      if (homeDir === this.deps.mainHome) {
        const existingRaw = await this.readRawPrefsObject(this.deps.mainHome);
        const next: DesktopNativePrefs = {
          notifications: parsedPatch.notifications ?? current.notifications,
          closeToTray: parsedPatch.closeToTray ?? current.closeToTray,
          ...(parsedPatch.locale !== undefined
            ? { locale: parsedPatch.locale }
            : current.locale !== undefined
              ? { locale: current.locale }
              : {}),
          updateChannel: parsedPatch.updateChannel ?? current.updateChannel,
          autoUpdate: parsedPatch.autoUpdate ?? current.autoUpdate,
          ...(nextUpdateState !== undefined ? { updateState: nextUpdateState } : {}),
          logLevel: parsedPatch.logLevel ?? current.logLevel,
          compatibility: nextCompat,
          windowMode: nextWindowMode,
        };
        await atomicWriteJson(
          this.prefsFilePath(this.deps.mainHome),
          {
            ...this.preservedMainMeta(existingRaw),
            ...next,
            window_mode: next.windowMode,
          },
          { indent: 2, preserveDestinationOnError: true },
        );
        this.deps.onPrefsChanged?.(next, homeDir);
        if (parsedPatch.locale !== undefined && parsedPatch.locale !== current.locale) {
          this.deps.onLocaleChanged?.(parsedPatch.locale);
        }
        return;
      }

      const hasChildPatch =
        parsedPatch.notifications !== undefined ||
        parsedPatch.closeToTray !== undefined ||
        parsedPatch.locale !== undefined ||
        parsedPatch.compatibility !== undefined ||
        parsedPatch.logLevel !== undefined;

      if (hasChildPatch) {
        const childRaw = (await this.readRawPrefsObject(homeDir)) ?? {};
        const childNext: Record<string, unknown> = { ...childRaw };
        if (parsedPatch.notifications !== undefined) childNext['notifications'] = parsedPatch.notifications;
        if (parsedPatch.closeToTray !== undefined) childNext['closeToTray'] = parsedPatch.closeToTray;
        if (parsedPatch.locale !== undefined) childNext['locale'] = parsedPatch.locale;
        if (parsedPatch.compatibility !== undefined) childNext['compatibility'] = nextCompat;
        if (parsedPatch.logLevel !== undefined) childNext['logLevel'] = parsedPatch.logLevel;
        await atomicWriteJson(this.prefsFilePath(homeDir), childNext, {
          indent: 2,
          preserveDestinationOnError: true,
        });
      }

      const hasMainPatch =
        parsedPatch.updateChannel !== undefined ||
        parsedPatch.autoUpdate !== undefined ||
        parsedPatch.windowMode !== undefined ||
        parsedPatch.window_mode !== undefined ||
        Object.hasOwn(parsedPatch, 'updateState');

      if (hasMainPatch) {
        const mainRaw = await this.readRawPrefsObject(this.deps.mainHome);
        const mainCurrent = await this.readPrefs(this.deps.mainHome);
        const mainNext: DesktopNativePrefs = {
          ...mainCurrent,
          updateChannel: parsedPatch.updateChannel ?? mainCurrent.updateChannel,
          autoUpdate: parsedPatch.autoUpdate ?? mainCurrent.autoUpdate,
          ...(nextUpdateState !== undefined ? { updateState: nextUpdateState } : {}),
          windowMode: nextWindowMode,
        };
        if (nextUpdateState === undefined) delete mainNext.updateState;
        await atomicWriteJson(
          this.prefsFilePath(this.deps.mainHome),
          {
            ...this.preservedMainMeta(mainRaw),
            ...mainNext,
            window_mode: mainNext.windowMode,
          },
          { indent: 2, preserveDestinationOnError: true },
        );
      }

      const effective = await this.readPrefs(homeDir);
      this.deps.onPrefsChanged?.(effective, homeDir);
      if (parsedPatch.locale !== undefined && parsedPatch.locale !== current.locale) {
        this.deps.onLocaleChanged?.(parsedPatch.locale);
      }
    });
  }

  async mutateUpdateState(mutation: DesktopUpdateMutation): Promise<DesktopUpdateState> {
    return this.enqueueWrite(async () => {
      const mainRaw = await this.readRawPrefsObject(this.deps.mainHome);
      const mainPrefs = await this.readPrefs(this.deps.mainHome);
      const current = mainPrefs.updateState ?? {};
      const next: {
        skipped?: { stable?: string[]; beta?: string[] };
        snoozedUntil?: number;
        lastCheckedAt?: number;
      } = {
        ...(current.skipped !== undefined && current.skipped !== null
          ? {
              skipped: {
                ...(Array.isArray(current.skipped.stable) ? { stable: [...current.skipped.stable] } : {}),
                ...(Array.isArray(current.skipped.beta) ? { beta: [...current.skipped.beta] } : {}),
              },
            }
          : {}),
        ...(typeof current.snoozedUntil === 'number' ? { snoozedUntil: current.snoozedUntil } : {}),
        ...(typeof current.lastCheckedAt === 'number' ? { lastCheckedAt: current.lastCheckedAt } : {}),
      };

      const validateEpoch = (value: number): number => {
        if (!Number.isFinite(value) || value < 0) {
          throw new Error('Update timestamps must be non-negative epoch milliseconds');
        }
        return value;
      };

      if (mutation.kind === 'checked') {
        const at = validateEpoch(mutation.at);
        if (next.lastCheckedAt === undefined || next.lastCheckedAt < at) {
          next.lastCheckedAt = at;
        }
      } else if (mutation.kind === 'snooze') {
        const until = validateEpoch(mutation.until);
        if (next.snoozedUntil === undefined || next.snoozedUntil < until) {
          next.snoozedUntil = until;
        }
      } else {
        const version = mutation.version.trim();
        if (version === '') throw new Error('Skipped version must not be empty');
        next.skipped ??= {};
        const list =
          mutation.channel === 'stable'
            ? (next.skipped.stable ??= [])
            : (next.skipped.beta ??= []);
        if (!list.includes(version)) {
          list.push(version);
        }
      }

      const persisted: DesktopNativePrefs = {
        ...mainPrefs,
        updateState: next,
      };
      await atomicWriteJson(
        this.prefsFilePath(this.deps.mainHome),
        {
          ...this.preservedMainMeta(mainRaw),
          ...persisted,
          window_mode: persisted.windowMode,
        },
        { indent: 2, preserveDestinationOnError: true },
      );
      return next;
    });
  }

  private resolveAutostartExe(): string {
    return resolveAutostartExecutablePath(this.deps.resolveLaunchExecutable(), this.platform);
  }

  getAutostart(): DesktopAutostartStatus {
    if (this.platform === 'win32' && this.deps.windowsRegistry !== undefined) {
      const command = this.deps.windowsRegistry.queryValue(WINDOWS_RUN_KEY, WINDOWS_RUN_VALUE_NAME);
      return {
        enabled: command !== null,
        supported: true,
        command,
      };
    }
    if (this.platform === 'linux') {
      const entryPath = this.deps.linuxDesktopEntryPath ?? resolveLinuxAutostartDesktopPath();
      return readLinuxAutostartStatus(entryPath);
    }
    const controller = this.deps.loginItemController;
    const supported =
      controller !== undefined && (this.platform === 'win32' || this.platform === 'darwin');
    if (!supported) {
      return { enabled: false, supported: false, command: null };
    }
    const exePath = this.deps.resolveLaunchExecutable();
    const args = ['--autostart'];
    const settings = controller.getLoginItemSettings({ path: exePath, args });
    return {
      enabled: settings.openAtLogin,
      supported: true,
      command: `"${exePath}" --autostart`,
    };
  }

  setAutostart(enabled: boolean): DesktopAutostartStatus {
    let status: DesktopAutostartStatus;
    if (this.platform === 'win32' && this.deps.windowsRegistry !== undefined) {
      cleanupStaleWindowsElectronRunEntries(this.deps.windowsRegistry);
      if (enabled) {
        const exePath = this.resolveAutostartExe();
        const command = formatAutostartCommand(exePath, 'win32');
        this.deps.windowsRegistry.setValue(WINDOWS_RUN_KEY, WINDOWS_RUN_VALUE_NAME, command);
        status = { enabled: true, supported: true, command };
      } else {
        this.deps.windowsRegistry.deleteValue(WINDOWS_RUN_KEY, WINDOWS_RUN_VALUE_NAME);
        status = { enabled: false, supported: true, command: null };
      }
    } else if (this.platform === 'linux') {
      const entryPath = this.deps.linuxDesktopEntryPath ?? resolveLinuxAutostartDesktopPath();
      status = writeLinuxAutostartStatus(entryPath, enabled, this.resolveAutostartExe());
    } else {
      const controller = this.deps.loginItemController;
      if (controller === undefined || (this.platform !== 'win32' && this.platform !== 'darwin')) {
        throw new Error('Autostart is not supported on this platform');
      }
      const exePath = this.deps.resolveLaunchExecutable();
      const args = ['--autostart'];
      controller.setLoginItemSettings({
        openAtLogin: enabled,
        path: exePath,
        args,
      });
      status = this.getAutostart();
    }

    void this.enqueueWrite(async () => {
      const raw = (await this.readRawPrefsObject(this.deps.mainHome)) ?? {};
      await atomicWriteJson(
        this.prefsFilePath(this.deps.mainHome),
        { ...raw, autostart: enabled },
        { indent: 2, preserveDestinationOnError: true },
      );
    }).catch(() => undefined);

    return status;
  }

  async refreshAutostartIfEnabled(): Promise<void> {
    try {
      const raw = await this.readRawPrefsObject(this.deps.mainHome);
      if (raw?.['autostart'] === false) return;
      const current = this.getAutostart();
      if (!current.supported || !current.enabled) return;
      this.setAutostart(true);
    } catch {
      // Best-effort startup autostart target refresh.
    }
  }

  createSpaceShortcut(
    homeId: string,
    spaceHomePath: string,
    spaceName: string,
  ): SpaceShortcutResult {
    if (this.platform !== 'win32') {
      return {
        ok: false,
        code: 'unsupported_platform',
        message: 'Desktop space shortcuts are currently supported only on Windows',
      };
    }
    if (this.deps.shortcutWriter === undefined || this.deps.desktopDir === undefined || this.deps.desktopDir.trim() === '') {
      return {
        ok: false,
        code: 'desktop_unavailable',
        message: 'Cannot locate the Windows desktop directory',
      };
    }
    const homeArgs = formatSpaceHomeArguments(spaceHomePath, 'win32');
    if (!homeArgs.ok) {
      return homeArgs;
    }
    let exePath: string;
    try {
      exePath = this.deps.resolveLaunchExecutable();
      if (exePath.trim() === '') throw new Error('Empty executable path');
    } catch (error) {
      return {
        ok: false,
        code: 'executable_unavailable',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const shortcutPath = join(this.deps.desktopDir, formatSpaceShortcutFileName(spaceName, homeId));
    if (existsSync(shortcutPath)) {
      return {
        ok: false,
        code: 'shortcut_exists',
        message: 'A shortcut for this space already exists',
      };
    }
    let ok = false;
    try {
      ok = this.deps.shortcutWriter.writeShortcutLink(shortcutPath, 'create', {
        target: exePath,
        args: homeArgs.args,
        description: spaceName,
        cwd: dirname(exePath),
        icon: exePath,
        iconIndex: 0,
      });
    } catch (error) {
      if (existsSync(shortcutPath)) {
        return {
          ok: false,
          code: 'shortcut_exists',
          message: 'A shortcut for this space already exists',
        };
      }
      return {
        ok: false,
        code: 'shortcut_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (!ok) {
      return {
        ok: false,
        code: existsSync(shortcutPath) ? 'shortcut_exists' : 'shortcut_failed',
        message: existsSync(shortcutPath)
          ? 'A shortcut for this space already exists'
          : `Failed to create shortcut at ${shortcutPath}`,
      };
    }
    return { ok: true, homeId, path: shortcutPath };
  }

  supportsUpdates(): boolean {
    if (this.deps.updaterAdapter === undefined) return false;
    if (this.deps.distribution === 'github') return true;
    if (this.deps.distribution === 'custom') {
      return normalizeHttpsUpdaterFeedBaseUrl(this.deps.updaterFeedBaseUrl) !== null;
    }
    return false;
  }

  async checkUpdate(channel: UpdateChannel = 'stable'): Promise<DesktopUpdateOffer | null> {
    if (!this.supportsUpdates() || this.deps.updaterAdapter === undefined) {
      throw new Error('Desktop updater is not available for this distribution');
    }
    const cached = this.checkCache.get(channel);
    if (cached !== undefined && this.now() - cached.at < UPDATE_CHECK_CACHE_TTL_MS) {
      return cached.result;
    }
    const result = await this.deps.updaterAdapter.checkForUpdate(channel);
    this.checkCache.set(channel, { at: this.now(), result });
    return result;
  }

  async installUpdate(expectedChannel?: UpdateChannel, expectedVersion?: string): Promise<void> {
    if (!this.supportsUpdates() || this.deps.updaterAdapter === undefined) {
      throw new Error('Desktop updater is not available for this distribution');
    }
    if (this.installInFlight) {
      throw new Error('A desktop update is already being installed');
    }
    this.installInFlight = true;
    this.checkCache.clear();
    try {
      const prefsBefore = await this.readPrefs(this.deps.mainHome);
      const channel = expectedChannel ?? prefsBefore.updateChannel;
      const offer = await this.deps.updaterAdapter.checkForUpdate(channel);
      if (
        offer === null ||
        channel !== prefsBefore.updateChannel ||
        (expectedVersion !== undefined && offer.version !== expectedVersion)
      ) {
        throw new Error('Desktop update selection changed; check for updates again');
      }
      if (this.deps.confirmShutdownForUpdate !== undefined) {
        const confirmed = await this.deps.confirmShutdownForUpdate();
        if (!confirmed) {
          throw new Error('Update cancelled; running sessions continue');
        }
      }
      const prefsAfter = await this.readPrefs(this.deps.mainHome);
      if (channel !== prefsAfter.updateChannel) {
        throw new Error('Desktop update selection changed; check for updates again');
      }
      await this.deps.prepareDaemonForUpdate?.();
      this.deps.markInstallingUpdate?.(true);
      this.deps.releaseUpdateLocks?.();
      try {
        await this.deps.updaterAdapter.downloadAndInstall(channel, offer.version);
      } catch (error) {
        this.deps.markInstallingUpdate?.(false);
        throw error;
      }
    } finally {
      this.deps.releaseUpdateLocks?.();
      this.installInFlight = false;
    }
  }
}

export { createDefaultWindowsRegistryRunner };
