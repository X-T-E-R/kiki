import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  protocol,
  screen,
  session,
  shell,
  Tray,
  type Event as ElectronEvent,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { dirname, join, resolve } from 'pathe';
import {
  createKikiAppProtocolHandler,
  KIKI_APP_ORIGIN,
  KIKI_APP_SCHEME,
} from '#/main/appProtocol';
import { parseWindowsCfHdropBuffer } from '#/main/clipboardDropFiles';
import { DaemonSupervisor, type ManagedQuitPlan } from '#/main/daemonSupervisor';
import {
  decodeClipboardUriList,
  FileAndClipboardService,
} from '#/main/fileAndClipboardService';
import {
  canonicalHomeKey,
  parseLaunchArgs,
  resolveInstanceIdentity,
} from '#/main/launchArgs';
import { NotificationService } from '#/main/notificationService';
import {
  createDefaultWindowsRegistryRunner,
  createElectronUpdaterAdapter,
  PrefsAndUpdateService,
  readDesktopBuildReceiptUpdaterMeta,
  readDesktopSpaceToml,
  resolveDesktopOauthHome,
  resolveDesktopUpdaterConfig,
} from '#/main/prefsAndUpdateService';
import { registerDesktopIpc } from '#/main/registerIpc';
import {
  maybeRedirectToCurrentRelease,
  resolveLaunchExecutable,
} from '#/main/releaseRedirect';
import { OVERLAY_SIZE, renderPendingBadgeRgba, rgbaToBgraBitmap } from '#/main/spaceBadge';
import { isSpaceRegisteredInMain, SpaceCatalog } from '#/main/spaceCatalog';
import {
  extractSubscribeIntentsFromArgs,
  parseSubscribeIntent,
  SubscribeIntentQueue,
} from '#/main/subscribeIntent';
import {
  buildTrayMenuTemplate,
  desktopExitCopy,
  executeStopBackgroundSpace,
  executeTrayQuit,
  formatTrayTooltip,
  retryTrayCreation,
} from '#/main/trayService';
import {
  isAllowedRendererNavigation,
  resolveWindowBackgroundColor,
  shouldBlockRendererAccelerator,
  tryValidateExternalForNavigation,
  WindowService,
  type ManagedWindowLike,
} from '#/main/windowService';
import { readWindowState, rescueWindowBounds, writeWindowState } from '#/main/windowState';
import { IPC_EVENTS } from '#/shared/ipcChannels';
import type {
  DesktopSpace,
  LocalSpaceSummary,
} from '#/shared/types';

declare const __KIKI_DESKTOP_BUILD_ID__: string | undefined;
declare const __KIKI_DESKTOP_CHANNEL__: string | undefined;
declare const __KIKI_DESKTOP_DISTRIBUTION__: string | undefined;
declare const __KIKI_UPDATER_FEED_BASE_URL__: string | undefined;

const BASE_APP_ID = 'com.kiki.desktop';
const APP_NAME = 'Kiki';
const WINDOW_WIDTH = 1440;
const WINDOW_HEIGHT = 920;
const TRAY_POLL_INTERVAL_MS = 5_000;
const MAIN_DIR = import.meta.dirname;
const PRELOAD_PATH = resolve(MAIN_DIR, '../preload/index.cjs');

maybeRedirectToCurrentRelease();

protocol.registerSchemesAsPrivileged([
  {
    scheme: KIKI_APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const explicitUserDataDir = process.env['KIKI_DESKTOP_USER_DATA_DIR']?.trim();
if (explicitUserDataDir !== undefined && explicitUserDataDir !== '') {
  app.setPath('userData', resolve(explicitUserDataDir));
}

const launchArgs = parseLaunchArgs(process.argv);
const defaultHome = process.env['KIKI_HOME']?.trim() || join(homedir(), '.kiki');
const kimiHome = process.env['KIMI_HOME']?.trim() || join(homedir(), '.kimi');
const startupHome = launchArgs.home ?? defaultHome;
const startupSpace = await readDesktopSpaceToml(startupHome).catch(() => null);
const mainHome = startupSpace?.baseHome ?? startupHome;

const preBootPrefsService = new PrefsAndUpdateService({
  mainHome,
  getActiveHome: () => startupHome,
  resolveLaunchExecutable: () => resolveLaunchExecutable(process.execPath),
});
const [initialPrefs, initialActivePrefs, initialTheme] = await Promise.all([
  preBootPrefsService.readPrefs(mainHome),
  preBootPrefsService.readPrefs(startupHome),
  preBootPrefsService.readWindowTheme(),
]);
nativeTheme.themeSource = initialTheme;

const registeredInMain =
  startupSpace !== null && canonicalHomeKey(startupHome) !== canonicalHomeKey(mainHome)
    ? await isSpaceRegisteredInMain(mainHome, startupSpace.homeId, startupHome)
    : true;

const instanceIdentity = resolveInstanceIdentity({
  baseAppId: BASE_APP_ID,
  startupHome,
  mainHome,
  defaultHome,
  explicitHomePassed: launchArgs.home !== undefined,
  registeredInMain,
  windowMode: initialPrefs.windowMode,
  spaceHomeId: startupSpace?.homeId,
  preset: launchArgs.preset,
  remoteConnection: launchArgs.remoteConnection,
});

if (instanceIdentity.userDataSuffix !== 'default') {
  app.setPath('userData', join(app.getPath('userData'), instanceIdentity.userDataSuffix));
}
if (process.platform === 'win32') {
  app.setAppUserModelId(instanceIdentity.appId);
}

const subscribeQueue = new SubscribeIntentQueue();
for (const intent of extractSubscribeIntentsFromArgs(process.argv)) {
  try {
    subscribeQueue.enqueue(intent);
  } catch {
    continue;
  }
}

const singleInstanceLock = app.requestSingleInstanceLock({
  argv: process.argv,
  cwd: process.cwd(),
});

if (!singleInstanceLock) {
  app.quit();
} else {
  let tray: Tray | null = null;
  let trayActive = false;
  let lastTraySignature = '';
  let lastTrayTooltip = '';
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let quitReleased = false;
  let installingUpdate = false;
  let quitInFlight: Promise<void> | null = null;
  let activeBrowserWindow: BrowserWindow | null = null;

  const userDataDir = app.getPath('userData');
  const spaces = new SpaceCatalog(mainHome, defaultHome, startupSpace ?? undefined);

  const envServerEntry = process.env['KIKI_DESKTOP_SERVER_ENTRY']?.trim();
  const resolveDevServerEntry = (): string => {
    const stagedEntry = resolve(MAIN_DIR, '../server/server-entry.mjs');
    if (existsSync(stagedEntry)) return stagedEntry;
    return resolve(MAIN_DIR, '../../../kimi-code/dist/main.mjs');
  };

  const serverEntry =
    envServerEntry !== undefined && envServerEntry !== ''
      ? envServerEntry
      : app.isPackaged
        ? join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'server', 'server-entry.mjs')
        : resolveDevServerEntry();

  const resolveWebRootDir = (): string => {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'server', 'web');
    }
    const stagedWeb = resolve(MAIN_DIR, '../server/web');
    if (existsSync(join(stagedWeb, 'index.html'))) return stagedWeb;
    return resolve(MAIN_DIR, '../../../kiki-gui/dist');
  };

  const devRendererOrigin = !app.isPackaged
    ? process.env['KIKI_DESKTOP_DEV_URL']?.trim() || undefined
    : undefined;
  const effectiveRendererOrigin = devRendererOrigin ?? KIKI_APP_ORIGIN;

  const bakedBuildId =
    (typeof __KIKI_DESKTOP_BUILD_ID__ === 'string' && __KIKI_DESKTOP_BUILD_ID__ !== ''
      ? __KIKI_DESKTOP_BUILD_ID__
      : undefined) ?? process.env['KIKI_BUILD_ID']?.trim();
  const bakedChannel =
    (typeof __KIKI_DESKTOP_CHANNEL__ === 'string' && __KIKI_DESKTOP_CHANNEL__ !== ''
      ? __KIKI_DESKTOP_CHANNEL__
      : undefined) ?? process.env['KIKI_CHANNEL']?.trim();
  const bakedDistributionRaw =
    typeof __KIKI_DESKTOP_DISTRIBUTION__ === 'string' && __KIKI_DESKTOP_DISTRIBUTION__ !== ''
      ? __KIKI_DESKTOP_DISTRIBUTION__
      : undefined;
  const bakedUpdaterFeedBaseUrlRaw =
    typeof __KIKI_UPDATER_FEED_BASE_URL__ === 'string' && __KIKI_UPDATER_FEED_BASE_URL__ !== ''
      ? __KIKI_UPDATER_FEED_BASE_URL__
      : undefined;
  const receiptUpdaterMeta = readDesktopBuildReceiptUpdaterMeta([
    join(dirname(process.execPath), 'desktop-build-receipt.json'),
    join(process.resourcesPath, 'desktop-build-receipt.json'),
    resolve(MAIN_DIR, '../../desktop-build-receipt.json'),
  ]);
  const resolvedUpdaterConfig = resolveDesktopUpdaterConfig({
    isPackaged: app.isPackaged,
    envDistribution: process.env['KIKI_DESKTOP_DISTRIBUTION'],
    envUpdaterFeedBaseUrl: process.env['KIKI_UPDATER_FEED_BASE_URL'],
    receipt: receiptUpdaterMeta,
    bakedDistribution: bakedDistributionRaw,
    bakedUpdaterFeedBaseUrl: bakedUpdaterFeedBaseUrlRaw,
  });

  const initialOauthHome = await resolveDesktopOauthHome({
    homeDir: startupHome,
    prefs: initialActivePrefs,
    kimiHome,
    space: startupSpace,
  }).catch(() => kimiHome);

  const daemon = new DaemonSupervisor(
    {
      electronBinary: resolveLaunchExecutable(process.execPath),
      serverEntry,
      homeDir: startupHome,
      oauthHomeDir: initialOauthHome,
      ...(bakedBuildId ? { buildId: bakedBuildId } : {}),
      ...(bakedChannel ? { buildChannel: bakedChannel } : {}),
      logLevel: initialActivePrefs.logLevel ?? 'warn',
      idleExit:
        instanceIdentity.effectiveWindowMode === 'switch' &&
        canonicalHomeKey(startupHome) !== canonicalHomeKey(mainHome),
    },
    {
      autoRecoverManagedExit: true,
    },
  );

  const sendToRenderer = (channel: string, payload?: unknown): void => {
    if (activeBrowserWindow !== null && !activeBrowserWindow.isDestroyed()) {
      activeBrowserWindow.webContents.send(channel, payload);
    }
  };

  const applyWindowsOverlayBadge = (win: BrowserWindow | null, pendingCount: number): void => {
    if (process.platform !== 'win32' || win === null || win.isDestroyed()) return;
    const rgba = renderPendingBadgeRgba(pendingCount);
    if (rgba === null) {
      win.setOverlayIcon(null, '');
      return;
    }
    const bgra = rgbaToBgraBitmap(rgba);
    const overlayImage = nativeImage.createFromBitmap(bgra, {
      width: OVERLAY_SIZE,
      height: OVERLAY_SIZE,
    });
    win.setOverlayIcon(
      overlayImage,
      pendingCount > 9 ? '9+ items need attention' : `${pendingCount} item(s) need attention`,
    );
  };

  const hardenSession = (): void => {
    const defaultSession = session.defaultSession;
    defaultSession.setPermissionCheckHandler((_webContents, permission) => {
      return permission === 'clipboard-sanitized-write' || permission === 'notifications';
    });
    defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === 'clipboard-sanitized-write' || permission === 'notifications');
    });
  };

  const cleanupGlobalUiHandles = (): void => {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    globalShortcut.unregisterAll();
    tray?.destroy();
    tray = null;
    trayActive = false;
  };

  const releaseAppQuit = (): void => {
    quitReleased = true;
    cleanupGlobalUiHandles();
    app.exit(0);
  };

  const wrapBrowserWindow = (win: BrowserWindow): ManagedWindowLike => ({
    isDestroyed: () => win.isDestroyed(),
    isVisible: () => win.isVisible(),
    isFocused: () => win.isFocused(),
    isMinimized: () => win.isMinimized(),
    isFullScreen: () => win.isFullScreen(),
    restore: () => {
      win.restore();
    },
    minimize: () => {
      win.minimize();
    },
    show: () => {
      win.show();
    },
    focus: () => {
      win.focus();
    },
    hide: () => {
      win.hide();
    },
    setBackgroundColor: (bg) => {
      win.setBackgroundColor(bg);
    },
    setFullScreen: (flag) => {
      win.setFullScreen(flag);
    },
    once: (event, listener) => win.once(event, listener),
    reload: () => {
      win.webContents.reload();
    },
    loadURL: (url) => win.loadURL(url),
    getURL: () => win.webContents.getURL(),
    setZoomFactor: (factor) => {
      win.webContents.setZoomFactor(factor);
    },
    close: () => {
      win.close();
    },
    destroy: () => {
      win.destroy();
    },
  });

  let closeToTrayCached = initialActivePrefs.closeToTray;
  let activeLocaleCached = initialActivePrefs.locale;
  let notificationsRef: NotificationService | null = null;

  const persistCurrentWindowBounds = (win: BrowserWindow): void => {
    if (win.isDestroyed()) return;
    const normalBounds = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
    void writeWindowState(userDataDir, {
      x: normalBounds.x,
      y: normalBounds.y,
      width: normalBounds.width,
      height: normalBounds.height,
      isMaximized: win.isMaximized(),
      isFullScreen: win.isFullScreen(),
    }).catch(() => undefined);
  };

  const readDiskCloseToTray = (): boolean => {
    const activePath = spaces.getActiveSpace().path;
    const candidates =
      canonicalHomeKey(activePath) === canonicalHomeKey(mainHome)
        ? [join(mainHome, 'desktop.json')]
        : [join(activePath, 'desktop.json'), join(mainHome, 'desktop.json')];
    for (const filePath of candidates) {
      try {
        if (!existsSync(filePath)) continue;
        const parsed = JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
        if (typeof parsed?.['closeToTray'] === 'boolean') {
          closeToTrayCached = parsed['closeToTray'];
          return parsed['closeToTray'];
        }
      } catch {
        continue;
      }
    }
    return closeToTrayCached;
  };

  const windows = new WindowService({
    windowMode: instanceIdentity.descriptor,
    spaceWindowMode: instanceIdentity.effectiveWindowMode,
    startWindowless: launchArgs.startWindowless,
    rendererOrigin: effectiveRendererOrigin,
    getCloseToTray: readDiskCloseToTray,
    isTrayActive: () => trayActive,
    getDaemonOrigin: () => daemon.currentConnection?.url ?? null,
    ensureDaemonOrigin: async () => (await daemon.discoverConnection()).config.url,
    detachDesktop: () => {
      daemon.detachDesktop();
    },
    releaseAppQuit,
    setDockVisible: (visible) => {
      if (process.platform !== 'darwin') return;
      if (visible) void app.dock?.show();
      else app.dock?.hide();
    },
    setNativeTheme: (theme) => {
      nativeTheme.themeSource = theme;
    },
    isDarkTheme: () => nativeTheme.shouldUseDarkColors,
    resolveLaunchExecutable: () => resolveLaunchExecutable(process.execPath),
    createBrowserWindow: async (initialUrl) => {
      const savedBounds = await readWindowState(userDataDir);
      const workAreas = screen.getAllDisplays().map((display) => display.workArea);
      const bounds = rescueWindowBounds(savedBounds, workAreas, {
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT,
      });

      const win = new BrowserWindow({
        ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
        width: bounds.width,
        height: bounds.height,
        minWidth: 960,
        minHeight: 640,
        show: false,
        backgroundColor: resolveWindowBackgroundColor(nativeTheme.shouldUseDarkColors),
        autoHideMenuBar: true,
        title: APP_NAME,
        webPreferences: {
          preload: PRELOAD_PATH,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });
      if (bounds.isMaximized) win.maximize();
      if (bounds.isFullScreen) win.setFullScreen(true);

      activeBrowserWindow = win;
      const wrapped = wrapBrowserWindow(win);

      let boundsSaveTimer: ReturnType<typeof setTimeout> | null = null;
      const scheduleBoundsSave = (): void => {
        if (boundsSaveTimer !== null) clearTimeout(boundsSaveTimer);
        boundsSaveTimer = setTimeout(() => {
          boundsSaveTimer = null;
          persistCurrentWindowBounds(win);
        }, 250);
      };

      win.on('resize', scheduleBoundsSave);
      win.on('move', scheduleBoundsSave);
      win.on('focus', () => {
        sendToRenderer(IPC_EVENTS.windowFocus);
      });
      win.on('close', (event) => {
        persistCurrentWindowBounds(win);
        windows.onWindowClose(event);
      });
      win.on('closed', () => {
        if (boundsSaveTimer !== null) {
          clearTimeout(boundsSaveTimer);
          boundsSaveTimer = null;
        }
        if (activeBrowserWindow === win) activeBrowserWindow = null;
        windows.onWindowClosed(wrapped);
      });
      win.webContents.on('before-input-event', (event, input) => {
        if (shouldBlockRendererAccelerator(input)) {
          event.preventDefault();
        }
      });
      win.webContents.on('will-navigate', (event, targetUrl) => {
        if (isAllowedRendererNavigation(targetUrl, devRendererOrigin ?? daemon.currentConnection?.url ?? null)) {
          return;
        }
        event.preventDefault();
        const external = tryValidateExternalForNavigation(targetUrl);
        if (external !== null) void shell.openExternal(external);
      });
      win.webContents.setWindowOpenHandler(({ url }) => {
        const external = tryValidateExternalForNavigation(url);
        if (external !== null) void shell.openExternal(external);
        return { action: 'deny' };
      });

      await win.loadURL(initialUrl);
      if (notificationsRef !== null) {
        applyWindowsOverlayBadge(win, notificationsRef.currentBadgeTotal());
      }
      return wrapped;
    },
  });

  nativeTheme.on('updated', () => {
    if (activeBrowserWindow !== null && !activeBrowserWindow.isDestroyed()) {
      activeBrowserWindow.setBackgroundColor(
        resolveWindowBackgroundColor(nativeTheme.shouldUseDarkColors),
      );
    }
  });

  const notifications = new NotificationService({
    isSupported: () => Notification.isSupported(),
    createNotification: (opts) => {
      const notification = new Notification({
        title: opts.title,
        body: opts.body,
      });
      return {
        show: () => {
          notification.show();
        },
        close: () => {
          notification.close();
        },
        on: (event, listener) => {
          if (event === 'click') return notification.on('click', listener);
          return notification.on('close', listener);
        },
      };
    },
    onActivateWindow: async () => {
      await windows.showMainWindow();
    },
    setOsBadgeCount: (total) => {
      if (typeof app.setBadgeCount === 'function') {
        app.setBadgeCount(total);
      }
    },
    setOverlayBadgeCount: (total) => {
      applyWindowsOverlayBadge(activeBrowserWindow, total);
    },
    registryPath: join(userDataDir, 'notifications-registry.json'),
  });
  notificationsRef = notifications;

  if (launchArgs.remoteConnection !== undefined) {
    notifications.setPendingRemoteConnectionIntent(launchArgs.remoteConnection);
  }

  const readOsClipboardFilePaths = async (): Promise<readonly string[] | null> => {
    const items = await clipboard.read();
    for (const item of items) {
      if (process.platform === 'win32') {
        const cfHdropType = item.types.find((type) =>
          type.toLowerCase().includes('format="cf_hdrop"'),
        );
        if (cfHdropType !== undefined) {
          const blob = await item.getType(cfHdropType);
          if (blob instanceof Blob) {
            const parsedDrop = parseWindowsCfHdropBuffer(new Uint8Array(await blob.arrayBuffer()));
            if (parsedDrop !== null && parsedDrop.length > 0) {
              return parsedDrop;
            }
          }
        }
      }
      if (item.types.includes('text/uri-list')) {
        const blob = await item.getType('text/uri-list');
        const parsed = decodeClipboardUriList(await blob.text());
        if (parsed.length > 0) return parsed;
      }
      const winFormat = 'electron application/osclipboard;format="FileNameW"';
      if (process.platform === 'win32' && item.types.includes(winFormat)) {
        const blob = await item.getType(winFormat);
        const decoded = Buffer.from(await blob.arrayBuffer())
          .toString('utf16le')
          .replace(/\0+$/, '')
          .trim();
        if (decoded !== '') return [decoded];
      }
      const macFormat = 'electron application/osclipboard;format="public.file-url"';
      if (process.platform === 'darwin' && item.types.includes(macFormat)) {
        const blob = await item.getType(macFormat);
        const parsed = decodeClipboardUriList(await blob.text());
        if (parsed.length > 0) return parsed;
      }
    }
    return null;
  };

  const files = new FileAndClipboardService({
    tempSaveDir: join(userDataDir, 'kiki-media-saves'),
    showSaveDialog: async (defaultPath) => {
      const result = await dialog.showSaveDialog({ defaultPath });
      return result.canceled ? null : result.filePath ?? null;
    },
    showOpenDialog: async ({ directory, multiple }) => {
      const properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> = [
        directory ? 'openDirectory' : 'openFile',
      ];
      if (multiple) properties.push('multiSelections');
      const result = await dialog.showOpenDialog({ properties });
      return result.canceled ? null : result.filePaths;
    },
    readOsClipboardFilePaths,
    revealInFileManager: (validatedPath) => {
      shell.showItemInFolder(validatedPath);
    },
    openWithDefaultApp: async (validatedPath) => {
      const errorMessage = await shell.openPath(validatedPath);
      if (errorMessage !== '') throw new Error(errorMessage);
    },
    openExternal: (validatedUrl) => shell.openExternal(validatedUrl),
  });

  const electronUpdaterAdapter = createElectronUpdaterAdapter({
    autoUpdater,
    getCurrentVersion: () => app.getVersion(),
    distribution: resolvedUpdaterConfig.distribution,
    ...(resolvedUpdaterConfig.updaterFeedBaseUrl !== undefined
      ? { updaterFeedBaseUrl: resolvedUpdaterConfig.updaterFeedBaseUrl }
      : {}),
    getEnvFeedUrlOverride: () => process.env['KIKI_UPDATE_FEED_URL'],
  });

  const confirmShutdownDialog = async (_reason: string, pendingWork: readonly string[]): Promise<boolean> => {
    const zh = activeLocaleCached === 'zh';
    const copy = desktopExitCopy(zh);
    const count = pendingWork.length;
    const response = await dialog.showMessageBox({
      type: 'warning',
      buttons: [copy.cancelButton, copy.confirmButton],
      defaultId: 0,
      cancelId: 0,
      title: APP_NAME,
      message: zh
        ? `当前有 ${count} 个活跃会话正在运行。`
        : `${count} active Kiki session(s) are still running.`,
      detail: copy.message,
    });
    return response.response === 1;
  };

  const confirmStopSpaceDialog = async (spaceName: string, zh: boolean): Promise<boolean> => {
    const response = await dialog.showMessageBox({
      type: 'warning',
      buttons: zh ? ['取消', '停止后台服务'] : ['Cancel', 'Stop Background Server'],
      defaultId: 0,
      cancelId: 0,
      title: APP_NAME,
      message: zh
        ? `停止空间「${spaceName}」的后台服务？`
        : `Stop background server for space "${spaceName}"?`,
      detail: zh
        ? '这将断开连接到该空间的所有窗口和客户端，并中断尚未完成的工作。'
        : 'This will disconnect windows and clients attached to that space and interrupt unfinished work.',
    });
    return response.response === 1;
  };

  const beginImmediateQuitUi = (): void => {
    if (activeBrowserWindow !== null && !activeBrowserWindow.isDestroyed()) {
      persistCurrentWindowBounds(activeBrowserWindow);
    }
    windows.hideAllForQuit();
    for (const bw of BrowserWindow.getAllWindows()) {
      if (!bw.isDestroyed() && bw.isVisible()) {
        try {
          bw.hide();
        } catch {
          // Ignore already-closing window during quit.
        }
      }
    }
    daemon.markShuttingDown();
    cleanupGlobalUiHandles();
  };

  const requestConfirmedQuit = (): Promise<void> => {
    if (quitInFlight !== null) return quitInFlight;
    let quitPlan: ManagedQuitPlan | undefined;
    quitInFlight = executeTrayQuit({
      collectPendingWork: async () => {
        quitPlan = await daemon.probeManagedQuitPlan();
        return quitPlan.pendingWork;
      },
      beginImmediateQuitUi,
      stopManagedDaemon: ({ interruptWork }) =>
        daemon.shutdownAllManagedDaemons({
          interruptWork,
          ...(quitPlan !== undefined ? { preProbed: quitPlan } : {}),
        }),
      confirmInterruptPendingWork: (pending) => confirmShutdownDialog('Quitting Kiki', pending),
      detachDesktop: () => {
        daemon.detachDesktop();
      },
      releaseQuit: () => {
        releaseAppQuit();
      },
    })
      .then(() => undefined)
      .finally(() => {
        quitInFlight = null;
      });
    return quitInFlight;
  };

  const prefsAndUpdates = new PrefsAndUpdateService({
    mainHome,
    getActiveHome: () => spaces.getActiveSpace().path,
    resolveLaunchExecutable: () => resolveLaunchExecutable(process.execPath),
    ...(process.platform === 'win32'
      ? { windowsRegistry: createDefaultWindowsRegistryRunner() }
      : {}),
    loginItemController: {
      getLoginItemSettings: (opts) => app.getLoginItemSettings(opts),
      setLoginItemSettings: (settings) => {
        app.setLoginItemSettings(settings);
      },
    },
    shortcutWriter:
      process.platform === 'win32'
        ? {
            writeShortcutLink: (shortcutPath, operation, opts) =>
              shell.writeShortcutLink(shortcutPath, operation, opts),
          }
        : undefined,
    desktopDir: process.env['KIKI_DESKTOP_SHORTCUT_DIR']?.trim() || app.getPath('desktop'),
    distribution: resolvedUpdaterConfig.distribution,
    ...(resolvedUpdaterConfig.updaterFeedBaseUrl !== undefined
      ? { updaterFeedBaseUrl: resolvedUpdaterConfig.updaterFeedBaseUrl }
      : {}),
    updaterAdapter: electronUpdaterAdapter,
    confirmShutdownForUpdate: async () => {
      const pending = await daemon.collectManagedQuitPendingWork();
      if (pending.length === 0) return true;
      return confirmShutdownDialog('Installing the update', pending);
    },
    prepareDaemonForUpdate: async () => {
      await daemon.shutdownAllManagedDaemons({ action: 'update', interruptWork: true });
    },
    markInstallingUpdate: (flag) => {
      installingUpdate = flag;
      if (flag) {
        beginImmediateQuitUi();
      }
    },
    onPrefsChanged: (nextPrefs, changedHomeDir) => {
      const activeSpace = spaces.getActiveSpace();
      const changedKey = canonicalHomeKey(changedHomeDir);
      if (
        changedKey === canonicalHomeKey(activeSpace.path) ||
        changedKey === canonicalHomeKey(mainHome)
      ) {
        closeToTrayCached = nextPrefs.closeToTray;
        activeLocaleCached = nextPrefs.locale;
        daemon.setLogLevel(nextPrefs.logLevel ?? 'warn');
        void resolveDesktopOauthHome({
          homeDir: activeSpace.path,
          prefs: nextPrefs,
          kimiHome,
          space: activeSpace,
        })
          .then((nextOauthHome) => {
            daemon.setOauthHomeDir(nextOauthHome);
          })
          .catch(() => undefined);
      }
      void refreshTrayMenu(true);
    },
    onLocaleChanged: () => {
      void refreshTrayMenu(true);
    },
  });

  daemon.onBackendStage((payload) => {
    sendToRenderer(IPC_EVENTS.backendStage, payload);
  });

  notifications.onClick((intent) => {
    sendToRenderer(IPC_EVENTS.notificationClick, intent);
  });

  subscribeQueue.onIntent((intent) => {
    sendToRenderer(IPC_EVENTS.subscribeIntent, intent);
    sendToRenderer(IPC_EVENTS.subscribeUrl, intent.url);
  });

  registerDesktopIpc(ipcMain, {
    daemon,
    windows,
    notifications,
    files,
    prefsAndUpdates,
    subscribeQueue,
    spaces,
    spaceWindowMode: instanceIdentity.effectiveWindowMode,
    kimiHome,
    openLogDirectory: async (dirPath) => {
      await mkdir(dirPath, { recursive: true });
      await files.openPath(dirPath);
    },
  });

  const switchToSpaceInCurrentWindow = async (space: DesktopSpace): Promise<void> => {
    const targetPrefs = await prefsAndUpdates.readPrefs(space.path);
    const oauthHomeDir = await resolveDesktopOauthHome({
      homeDir: space.path,
      prefs: targetPrefs,
      kimiHome,
      space,
    });
    daemon.setLogLevel(targetPrefs.logLevel ?? 'warn');
    daemon.setTargetHome(space.path, oauthHomeDir);
    spaces.setActiveSpace(space);
    await windows.reloadForSwitchedSpace();
    await refreshTrayMenu(true);
  };

  // Start the detached backend daemon in parallel with Chromium app.whenReady() + BrowserWindow creation.
  const earlyDaemonBoot = !launchArgs.startTrayOnly
    ? daemon.discoverConnection().catch((error: unknown) => {
        console.error('Kiki daemon startup failed:', error);
        return null;
      })
    : null;

  const loadTrayIcon = (): Electron.NativeImage => {
    const candidates = [
      join(process.resourcesPath, 'icons', '32x32.png'),
      resolve(MAIN_DIR, '../../icons/32x32.png'),
    ];
    const existing = candidates.find((candidate) => existsSync(candidate));
    const image = existing !== undefined ? nativeImage.createFromPath(existing) : nativeImage.createEmpty();
    if (process.platform === 'darwin') image.setTemplateImage(true);
    return image;
  };

  const refreshTrayMenu = async (force = false): Promise<void> => {
    const activeSpace = spaces.getActiveSpace();
    const prefs = await prefsAndUpdates.readPrefs(activeSpace.path);
    closeToTrayCached = prefs.closeToTray;
    activeLocaleCached = prefs.locale;
    const zh = prefs.locale === 'zh';
    const windowVisible = windows.currentWindow?.isVisible() === true;
    const autostart = prefsAndUpdates.getAutostart();

    let localSpaces: LocalSpaceSummary[] = [];
    if (daemon.currentConnection !== null) {
      try {
        const listed = await daemon.listSpacesAndStatuses(activeSpace.homeId);
        localSpaces = listed.spaces;
        await notifications.reconcileBackgroundSpaceAttention({
          statuses: listed.statuses,
          spaces: listed.spaces,
          spaceWindowMode: instanceIdentity.effectiveWindowMode,
          notificationsEnabled: prefs.notifications,
          zh,
        });
      } catch {
        localSpaces = [];
      }
    }

    if (tray === null) return;

    const tooltip = formatTrayTooltip({
      spaces: localSpaces,
      activeSpace,
      windowVisible,
      zh,
    });
    if (tooltip !== lastTrayTooltip) {
      lastTrayTooltip = tooltip;
      tray.setToolTip(tooltip);
    }

    const signature = JSON.stringify({
      zh,
      windowVisible,
      autostartSupported: autostart.supported,
      autostartEnabled: autostart.enabled,
      spaces: localSpaces,
    });
    if (!force && signature === lastTraySignature) return;
    lastTraySignature = signature;

    const template = buildTrayMenuTemplate({
      zh,
      windowVisible,
      autostartSupported: autostart.supported,
      autostartEnabled: autostart.enabled,
      spaces: localSpaces,
      callbacks: {
        onShowWindow: () => {
          void windows.showMainWindow().then(() => refreshTrayMenu(true));
        },
        onHideWindow: () => {
          windows.hideMainWindow();
          void refreshTrayMenu(true);
        },
        onNewSession: () => {
          void windows.showMainWindow().then(() => {
            sendToRenderer(IPC_EVENTS.trayNewSession);
          });
        },
        onOpenSpace: (homeId) => {
          void spaces
            .findSpace(homeId)
            .then((space) => {
              if (instanceIdentity.effectiveWindowMode === 'switch') {
                return switchToSpaceInCurrentWindow(space);
              }
              windows.openSpaceWindow(space.path);
              return undefined;
            })
            .catch((error: unknown) => {
              dialog.showErrorBox(
                APP_NAME,
                error instanceof Error ? error.message : String(error),
              );
            });
        },
        onStopSpace: (homeId) => {
          void spaces
            .findSpace(homeId)
            .then(async (space) => {
              await executeStopBackgroundSpace({
                spaceName: space.name,
                spacePath: space.path,
                confirmStopSpace: (name) => confirmStopSpaceDialog(name, prefs.locale === 'zh'),
                stopManagedDaemonForHome: (homeDir, opts) =>
                  daemon.stopManagedDaemonForHome(homeDir, opts),
              });
              await refreshTrayMenu(true);
            })
            .catch((error: unknown) => {
              dialog.showErrorBox(
                APP_NAME,
                error instanceof Error ? error.message : String(error),
              );
            });
        },
        onToggleAutostart: (enabled) => {
          try {
            prefsAndUpdates.setAutostart(enabled);
          } finally {
            void refreshTrayMenu(true);
          }
        },
        onCloseWindowKeepTray: () => {
          windows.destroyMainWindowKeepTray();
          void refreshTrayMenu(true);
        },
        onQuitCompletely: () => {
          void requestConfirmedQuit();
        },
      },
    });
    tray.setContextMenu(Menu.buildFromTemplate(template));
  };

  app.on('open-url', (event, rawUrl) => {
    event.preventDefault();
    try {
      const parsed = parseSubscribeIntent(rawUrl);
      if (parsed !== null) {
        subscribeQueue.enqueue(parsed);
        void windows.showMainWindow();
      }
    } catch {
      // Ignore malformed deep-link URLs.
    }
  });

  app.on('second-instance', (_event, argv, _cwd, additionalData) => {
    const incomingArgv =
      typeof additionalData === 'object' &&
      additionalData !== null &&
      Array.isArray((additionalData as { argv?: unknown }).argv)
        ? ((additionalData as { argv: string[] }).argv)
        : argv;
    for (const intent of extractSubscribeIntentsFromArgs(incomingArgv)) {
      try {
        subscribeQueue.enqueue(intent);
      } catch {
        continue;
      }
    }
    try {
      const secondArgs = parseLaunchArgs(incomingArgv);
      if (!secondArgs.startInBackground) {
        if (
          secondArgs.home !== undefined &&
          launchArgs.preset === undefined &&
          instanceIdentity.effectiveWindowMode === 'switch'
        ) {
          void readDesktopSpaceToml(secondArgs.home)
            .then((targetSpace) => spaces.findSpace(targetSpace?.homeId ?? 'main'))
            .then((space) => switchToSpaceInCurrentWindow(space))
            .catch(() => windows.showMainWindow());
        } else {
          void windows.showMainWindow();
        }
      } else {
        void refreshTrayMenu(true);
      }
    } catch {
      void windows.showMainWindow();
    }
  });

  app.on('activate', () => {
    void windows.showMainWindow();
  });

  app.on('window-all-closed', () => {
    if (installingUpdate || windows.shouldPreventQuitOnAllWindowsClosed()) return;
    daemon.detachDesktop();
    releaseAppQuit();
  });

  app.on('before-quit', (event: ElectronEvent) => {
    if (quitReleased || installingUpdate) return;
    event.preventDefault();
    void requestConfirmedQuit();
  });

  void app.whenReady().then(async () => {
    protocol.handle(
      KIKI_APP_SCHEME,
      createKikiAppProtocolHandler(resolveWebRootDir(), (fileUrl, init) => net.fetch(fileUrl, init)),
    );
    hardenSession();
    windows.applyInitialWindowlessPolicy();

    const showWindowPromise =
      !launchArgs.startTrayOnly && !launchArgs.startWindowless
        ? windows.showMainWindow()
        : Promise.resolve();

    await Promise.all([
      showWindowPromise,
      notifications.restoreFromDisk(),
      prefsAndUpdates.refreshAutostartIfEnabled(),
    ]);

    const isDefaultSwitchInstance =
      instanceIdentity.effectiveWindowMode === 'switch' &&
      instanceIdentity.userDataSuffix === 'default';

    if (isDefaultSwitchInstance) {
      if (process.defaultApp && process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('kiki', process.execPath, [resolve(process.argv[1]!)]);
      } else {
        app.setAsDefaultProtocolClient('kiki');
      }
    }

    const trayResult = await retryTrayCreation({
      startInBackground: launchArgs.startInBackground,
      isQuitting: () => windows.isQuitting,
      attemptCreate: () => {
        tray = new Tray(loadTrayIcon());
        tray.setToolTip(APP_NAME);
        if (process.platform !== 'darwin') {
          tray.on('click', () => {
            void windows.showMainWindow().then(() => refreshTrayMenu(true));
          });
        }
      },
    });
    trayActive = trayResult.trayCreated;
    if (trayActive) {
      await refreshTrayMenu(true);
    } else if (trayResult.revealFallbackWindow) {
      await windows.showMainWindow();
    }

    if (isDefaultSwitchInstance) {
      try {
        globalShortcut.register('CommandOrControl+Shift+K', () => {
          const win = windows.currentWindow;
          if (win !== null && win.isVisible() && win.isFocused()) {
            windows.hideMainWindow();
          } else {
            void windows.showMainWindow();
          }
        });
      } catch {
        // Global shortcut registration is optional.
      }
    }

    pollTimer = setInterval(() => {
      void daemon
        .checkHealthAndRecoverIfNeeded()
        .then(() => refreshTrayMenu(false))
        .catch(() => undefined);
    }, TRAY_POLL_INTERVAL_MS);
    pollTimer.unref?.();

    if (launchArgs.startTrayOnly) {
      await daemon.attachIfRunning();
      await refreshTrayMenu(true);
      return;
    }

    await earlyDaemonBoot;
    await refreshTrayMenu(true);
  });
}
