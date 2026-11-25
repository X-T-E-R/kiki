import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'pathe';
import { parse as parseToml } from 'smol-toml';
import writeFileAtomic from 'write-file-atomic';
import { z } from 'zod';
import { desktopPrefsPatchSchema } from '#/shared/ipcChannels';
import type {
  DesktopAutostartStatus,
  DesktopLogLevel,
  DesktopNativePrefs,
  DesktopSpace,
  DesktopUpdateMutation,
  DesktopUpdateOffer,
  DesktopUpdateState,
  SpaceWindowMode,
  UpdateChannel,
} from '#/shared/types';

const UPDATE_CHECK_CACHE_TTL_MS = 30_000;

export const DEFAULT_DESKTOP_PREFS: DesktopNativePrefs = {
  notifications: true,
  closeToTray: true,
  updateChannel: 'stable',
  autoUpdate: 'notify',
  logLevel: 'warn',
  compatibility: { homeKind: 'kimi' },
  windowMode: 'switch',
};

const homeTomlSchema = z.object({
  id: z.string().min(1).optional(),
  home_id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  color: z.string().nullable().optional(),
  preset: z.string().nullable().optional(),
  base_home: z.string().min(1).nullable().optional(),
  credentials_shared: z.boolean().optional(),
});

function normalizeUpdateState(raw: unknown): DesktopUpdateState | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const cleanList = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const filtered = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
    return filtered;
  };
  let skipped: DesktopUpdateState['skipped'];
  if (typeof record['skipped'] === 'object' && record['skipped'] !== null && !Array.isArray(record['skipped'])) {
    const skippedObj = record['skipped'] as Record<string, unknown>;
    const stable = cleanList(skippedObj['stable']);
    const beta = cleanList(skippedObj['beta']);
    if (stable !== undefined || beta !== undefined) {
      skipped = {
        ...(stable !== undefined ? { stable } : {}),
        ...(beta !== undefined ? { beta } : {}),
      };
    }
  }
  const readEpoch = (key: string): number | undefined => {
    const val = record[key];
    return typeof val === 'number' && Number.isFinite(val) && val >= 0 ? val : undefined;
  };
  const snoozedUntil = readEpoch('snoozedUntil');
  const lastCheckedAt = readEpoch('lastCheckedAt');
  if (skipped === undefined && snoozedUntil === undefined && lastCheckedAt === undefined) {
    return undefined;
  }
  return {
    ...(skipped !== undefined ? { skipped } : {}),
    ...(snoozedUntil !== undefined ? { snoozedUntil } : {}),
    ...(lastCheckedAt !== undefined ? { lastCheckedAt } : {}),
  };
}

function parseDesktopPrefsRecord(raw: unknown): DesktopNativePrefs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_DESKTOP_PREFS };
  }
  const record = raw as Record<string, unknown>;
  const windowModeRaw = record['windowMode'] ?? record['window_mode'];
  const windowMode: SpaceWindowMode = windowModeRaw === 'windows' ? 'windows' : 'switch';
  const updateChannel: UpdateChannel = record['updateChannel'] === 'beta' ? 'beta' : 'stable';
  const autoUpdate =
    record['autoUpdate'] === 'off' || record['autoUpdate'] === 'install'
      ? record['autoUpdate']
      : 'notify';
  const logLevelValues = new Set<DesktopLogLevel>([
    'fatal',
    'error',
    'warn',
    'info',
    'debug',
    'trace',
    'silent',
  ]);
  const logLevel: DesktopLogLevel =
    typeof record['logLevel'] === 'string' && logLevelValues.has(record['logLevel'] as DesktopLogLevel)
      ? (record['logLevel'] as DesktopLogLevel)
      : 'warn';
  const compatRaw = record['compatibility'];
  const compatibility =
    typeof compatRaw === 'object' && compatRaw !== null && !Array.isArray(compatRaw)
      ? {
          homeKind:
            (compatRaw as Record<string, unknown>)['homeKind'] === 'custom'
              ? ('custom' as const)
              : ('kimi' as const),
          ...(typeof (compatRaw as Record<string, unknown>)['customHome'] === 'string'
            ? { customHome: (compatRaw as Record<string, unknown>)['customHome'] as string }
            : {}),
        }
      : { homeKind: 'kimi' as const };
  const updateState = normalizeUpdateState(record['updateState']);
  return {
    notifications: typeof record['notifications'] === 'boolean' ? record['notifications'] : true,
    closeToTray: typeof record['closeToTray'] === 'boolean' ? record['closeToTray'] : true,
    ...(typeof record['locale'] === 'string' ? { locale: record['locale'] } : {}),
    updateChannel,
    autoUpdate,
    ...(updateState !== undefined ? { updateState } : {}),
    logLevel,
    compatibility,
    windowMode,
  };
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' });
}

export async function readDesktopSpaceToml(homeDir: string): Promise<DesktopSpace | null> {
  const tomlPath = join(homeDir, 'home.toml');
  let raw: string;
  try {
    raw = await readFile(tomlPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed = homeTomlSchema.parse(parseToml(raw));
  const homeId = parsed.id ?? parsed.home_id ?? 'main';
  return {
    homeId,
    name: parsed.name ?? basename(homeDir) ?? 'Main space',
    color: parsed.color ?? null,
    preset: parsed.preset ?? null,
    path: homeDir,
    baseHome: parsed.base_home ?? null,
    credentialsShared: parsed.credentials_shared ?? true,
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
  readonly shortcutWriter?: ShortcutWriter;
  readonly desktopDir?: string;
  readonly distribution?: 'github' | 'local';
  readonly updaterAdapter?: UpdaterFeedAdapter;
  readonly confirmShutdownForUpdate?: () => Promise<boolean>;
  readonly prepareDaemonForUpdate?: () => Promise<void>;
  readonly releaseUpdateLocks?: () => void;
  readonly onLocaleChanged?: (locale: string | undefined) => void;
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

  async readPrefs(homeDir: string = this.deps.getActiveHome()): Promise<DesktopNativePrefs> {
    let localRaw: unknown = null;
    try {
      localRaw = JSON.parse(await readFile(this.prefsFilePath(homeDir), 'utf8'));
    } catch {
      localRaw = null;
    }
    const localPrefs = parseDesktopPrefsRecord(localRaw);
    if (homeDir === this.deps.mainHome) return localPrefs;

    let mainRaw: unknown = null;
    try {
      mainRaw = JSON.parse(await readFile(this.prefsFilePath(this.deps.mainHome), 'utf8'));
    } catch {
      mainRaw = null;
    }
    const mainPrefs = parseDesktopPrefsRecord(mainRaw);
    return {
      ...localPrefs,
      updateChannel: mainPrefs.updateChannel,
      autoUpdate: mainPrefs.autoUpdate,
      ...(mainPrefs.updateState !== undefined ? { updateState: mainPrefs.updateState } : {}),
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
        nextCompat.homeKind !== 'kimi'
      ) {
        throw new Error('Isolated spaces must use their own OAuth home');
      }

      let nextUpdateState = current.updateState;
      if (Object.hasOwn(parsedPatch, 'updateState')) {
        nextUpdateState =
          parsedPatch.updateState === null || parsedPatch.updateState === undefined
            ? undefined
            : normalizeUpdateState(parsedPatch.updateState);
      }

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

      const persisted = {
        ...next,
        window_mode: next.windowMode,
      };
      await atomicWriteJson(this.prefsFilePath(homeDir), persisted);

      if (
        homeDir !== this.deps.mainHome &&
        (parsedPatch.updateChannel !== undefined ||
          parsedPatch.autoUpdate !== undefined ||
          parsedPatch.windowMode !== undefined ||
          parsedPatch.window_mode !== undefined ||
          Object.hasOwn(parsedPatch, 'updateState'))
      ) {
        const mainCurrent = await this.readPrefs(this.deps.mainHome);
        const mainNext: DesktopNativePrefs = {
          ...mainCurrent,
          updateChannel: next.updateChannel,
          autoUpdate: next.autoUpdate,
          ...(nextUpdateState !== undefined ? { updateState: nextUpdateState } : {}),
          windowMode: next.windowMode,
        };
        if (nextUpdateState === undefined) delete mainNext.updateState;
        await atomicWriteJson(this.prefsFilePath(this.deps.mainHome), {
          ...mainNext,
          window_mode: mainNext.windowMode,
        });
      }

      if (parsedPatch.locale !== undefined && parsedPatch.locale !== current.locale) {
        this.deps.onLocaleChanged?.(parsedPatch.locale);
      }
    });
  }

  async mutateUpdateState(mutation: DesktopUpdateMutation): Promise<DesktopUpdateState> {
    return this.enqueueWrite(async () => {
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
      await atomicWriteJson(this.prefsFilePath(this.deps.mainHome), {
        ...persisted,
        window_mode: persisted.windowMode,
      });
      return next;
    });
  }

  getAutostart(): DesktopAutostartStatus {
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
    return this.getAutostart();
  }

  async createSpaceShortcut(
    homeId: string,
    spaceHomePath: string,
    spaceName: string,
  ): Promise<{ readonly homeId: string; readonly path: string }> {
    if (this.platform !== 'win32') {
      throw Object.assign(new Error('Desktop space shortcuts are only supported on Windows'), {
        code: 'UNSUPPORTED_PLATFORM',
      });
    }
    if (this.deps.shortcutWriter === undefined || this.deps.desktopDir === undefined) {
      throw Object.assign(new Error('Windows shortcut writer is unavailable'), {
        code: 'UNAVAILABLE',
      });
    }
    const safeName = spaceName.replaceAll(/[<>:"/\\|?*]/g, '_').trim() || homeId;
    const shortcutPath = join(this.deps.desktopDir, `Kiki - ${safeName}.lnk`);
    if (existsSync(shortcutPath)) {
      throw Object.assign(new Error(`Shortcut already exists: ${shortcutPath}`), {
        code: 'ALREADY_EXISTS',
      });
    }
    const exePath = this.deps.resolveLaunchExecutable();
    const ok = this.deps.shortcutWriter.writeShortcutLink(shortcutPath, 'create', {
      target: exePath,
      args: `--home "${spaceHomePath}"`,
      description: `Open Kiki space ${spaceName}`,
      cwd: dirname(exePath),
    });
    if (!ok) {
      throw Object.assign(new Error(`Failed to create shortcut at ${shortcutPath}`), {
        code: 'CREATE_FAILED',
      });
    }
    return { homeId, path: shortcutPath };
  }

  supportsUpdates(): boolean {
    return this.deps.distribution === 'github' && this.deps.updaterAdapter !== undefined;
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
      await this.deps.updaterAdapter.downloadAndInstall(channel, offer.version);
    } finally {
      this.deps.releaseUpdateLocks?.();
      this.installInFlight = false;
    }
  }
}
