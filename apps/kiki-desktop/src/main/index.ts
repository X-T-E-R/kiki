import { existsSync } from 'node:fs';
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
  Notification,
  session,
  shell,
  Tray,
  type Event as ElectronEvent,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { join, resolve } from 'pathe';
import { DaemonSupervisor } from '#/main/daemonSupervisor';
import {
  decodeClipboardUriList,
  FileAndClipboardService,
} from '#/main/fileAndClipboardService';
import { parseLaunchArgs, resolveInstanceIdentity } from '#/main/launchArgs';
import { NotificationService } from '#/main/notificationService';
import {
  PrefsAndUpdateService,
  readDesktopSpaceToml,
  type UpdaterFeedAdapter,
} from '#/main/prefsAndUpdateService';
import { registerDesktopIpc } from '#/main/registerIpc';
import {
  maybeRedirectToCurrentRelease,
  resolveLaunchExecutable,
} from '#/main/releaseRedirect';
import { SpaceCatalog } from '#/main/spaceCatalog';
import {
  extractSubscribeIntentsFromArgs,
  parseSubscribeIntent,
  SubscribeIntentQueue,
} from '#/main/subscribeIntent';
import {
  buildTrayMenuTemplate,
  executeStopBackgroundSpace,
  executeTrayQuit,
  retryTrayCreation,
} from '#/main/trayService';
import {
  isAllowedRendererNavigation,
  shouldBlockRendererAccelerator,
  tryValidateExternalForNavigation,
  WindowService,
  type ManagedWindowLike,
} from '#/main/windowService';
import { IPC_EVENTS } from '#/shared/ipcChannels';
import type { DesktopUpdateOffer, LocalSpaceSummary, UpdateChannel } from '#/shared/types';

const BASE_APP_ID = 'com.kiki.desktop';
const APP_NAME = 'Kiki';
const WINDOW_WIDTH = 1440;
const WINDOW_HEIGHT = 920;
const MAIN_DIR = import.meta.dirname;
const PRELOAD_PATH = resolve(MAIN_DIR, '../preload/index.cjs');

// Step 1: Execute release redirect BEFORE single-instance lock, window creation, or daemon startup.
maybeRedirectToCurrentRelease();

const launchArgs = parseLaunchArgs(process.argv);
const defaultHome = join(homedir(), '.kiki');
const startupHome = launchArgs.home ?? process.env['KIKI_HOME']?.trim() ?? defaultHome;
const startupSpace = await readDesktopSpaceToml(startupHome).catch(() => null);
const mainHome = startupSpace?.baseHome ?? startupHome;

const preBootPrefsService = new PrefsAndUpdateService({
  mainHome,
  getActiveHome: () => startupHome,
  resolveLaunchExecutable: () => resolveLaunchExecutable(process.execPath),
});
const initialPrefs = await preBootPrefsService.readPrefs(mainHome);

const instanceIdentity = resolveInstanceIdentity({
  baseAppId: BASE_APP_ID,
  startupHome,
  mainHome,
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
  let quitReleased = false;
  let quitInFlight: Promise<void> | null = null;
  let activeBrowserWindow: BrowserWindow | null = null;

  const spaces = new SpaceCatalog(mainHome, defaultHome, startupSpace ?? undefined);

  const serverEntry = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'server', 'server-entry.mjs')
    : process.env['KIKI_DESKTOP_SERVER_ENTRY']?.trim() ||
      resolve(MAIN_DIR, '../../../kimi-code/dist/index.mjs');

  const daemon = new DaemonSupervisor({
    electronBinary: resolveLaunchExecutable(process.execPath),
    serverEntry,
    homeDir: startupHome,
    oauthHomeDir: mainHome,
    logLevel: initialPrefs.logLevel ?? 'warn',
    idleExit: instanceIdentity.effectiveWindowMode === 'switch' && startupHome !== mainHome,
  });

  const sendToRenderer = (channel: string, payload?: unknown): void => {
    if (activeBrowserWindow !== null && !activeBrowserWindow.isDestroyed()) {
      activeBrowserWindow.webContents.send(channel, payload);
    }
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

  const releaseAppQuit = (): void => {
    quitReleased = true;
    globalShortcut.unregisterAll();
    tray?.destroy();
    tray = null;
    trayActive = false;
    app.quit();
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
    show: () => {
      win.show();
    },
    focus: () => {
      win.focus();
    },
    hide: () => {
      win.hide();
    },
    setFullScreen: (flag) => {
      win.setFullScreen(flag);
    },
    once: (event, listener) => win.once(event, listener),
    reload: () => {
      win.webContents.reload();
    },
    loadURL: (url) => win.loadURL(url),
    setZoomFactor: (factor) => {
      win.webContents.setZoomFactor(factor);
    },
    close: () => {
      win.close();
    },
  });

  let closeToTrayCached = initialPrefs.closeToTray;

  const windows = new WindowService({
    windowMode: instanceIdentity.descriptor,
    spaceWindowMode: instanceIdentity.effectiveWindowMode,
    startWindowless: launchArgs.startWindowless,
    getCloseToTray: () => closeToTrayCached,
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
    resolveLaunchExecutable: () => resolveLaunchExecutable(process.execPath),
    createBrowserWindow: async (initialUrl) => {
      const win = new BrowserWindow({
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT,
        minWidth: 960,
        minHeight: 640,
        show: false,
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
      activeBrowserWindow = win;
      const wrapped = wrapBrowserWindow(win);

      win.on('focus', () => {
        sendToRenderer(IPC_EVENTS.windowFocus);
      });
      win.on('close', (event) => {
        windows.onWindowClose(event);
      });
      win.on('closed', () => {
        if (activeBrowserWindow === win) activeBrowserWindow = null;
        windows.onWindowClosed(wrapped);
      });
      win.webContents.on('before-input-event', (event, input) => {
        if (shouldBlockRendererAccelerator(input)) {
          event.preventDefault();
        }
      });
      win.webContents.on('will-navigate', (event, targetUrl) => {
        if (isAllowedRendererNavigation(targetUrl, daemon.currentConnection?.url ?? null)) return;
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
      return wrapped;
    },
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
  });

  if (launchArgs.remoteConnection !== undefined) {
    notifications.setPendingRemoteConnectionIntent(launchArgs.remoteConnection);
  }

  const readOsClipboardFilePaths = async (): Promise<readonly string[] | null> => {
    const items = await clipboard.read();
    for (const item of items) {
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
    tempSaveDir: join(app.getPath('userData'), 'kiki-media-saves'),
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

  const electronUpdaterAdapter: UpdaterFeedAdapter = {
    async checkForUpdate(channel: UpdateChannel): Promise<DesktopUpdateOffer | null> {
      autoUpdater.autoDownload = false;
      autoUpdater.allowPrerelease = channel === 'beta';
      const result = await autoUpdater.checkForUpdates();
      const info = result?.updateInfo;
      if (info === undefined || info.version === app.getVersion()) return null;
      return {
        currentVersion: app.getVersion(),
        version: info.version,
        date: info.releaseDate,
        notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      };
    },
    async downloadAndInstall(channel: UpdateChannel): Promise<void> {
      autoUpdater.allowPrerelease = channel === 'beta';
      await autoUpdater.downloadUpdate();
      autoUpdater.quitAndInstall();
    },
  };

  const confirmShutdownDialog = async (reason: string, pendingWork: readonly string[]): Promise<boolean> => {
    const count = pendingWork.length;
    const response = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Stop Services and Continue'],
      defaultId: 0,
      cancelId: 0,
      title: APP_NAME,
      message: `${reason} will stop ${count} active Kiki session(s).`,
      detail: 'Wait for running work to finish or confirm to interrupt and stop the managed Kiki daemon.',
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

  const requestConfirmedQuit = (): Promise<void> => {
    if (quitInFlight !== null) return quitInFlight;
    quitInFlight = executeTrayQuit({
      stopManagedDaemon: (opts) => daemon.stopManagedDaemon(opts),
      confirmInterruptPendingWork: (pending) => confirmShutdownDialog('Quitting Kiki', pending),
      detachDesktop: () => {
        daemon.detachDesktop();
      },
      releaseQuit: () => {
        windows.markQuitting();
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
    desktopDir: app.getPath('desktop'),
    distribution: process.env['KIKI_DESKTOP_DISTRIBUTION'] === 'github' ? 'github' : 'local',
    updaterAdapter: electronUpdaterAdapter,
    confirmShutdownForUpdate: async () => {
      const state = await daemon.readLifecycleState();
      if (state === null || !state.managed || state.work_pending.length === 0) return true;
      return confirmShutdownDialog('Installing the update', state.work_pending);
    },
    prepareDaemonForUpdate: async () => {
      await daemon.stopManagedDaemon({ action: 'update', interruptWork: true });
    },
    onLocaleChanged: () => {
      void refreshTrayMenu();
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
    openLogDirectory: async (dirPath) => {
      await mkdir(dirPath, { recursive: true });
      await files.openPath(dirPath);
    },
  });

  const loadTrayIcon = (): Electron.NativeImage => {
    const candidates = [
      join(process.resourcesPath, 'icons', '32x32.png'),
      resolve(MAIN_DIR, '../../../kiki-gui/src-tauri/icons/32x32.png'),
    ];
    const existing = candidates.find((candidate) => existsSync(candidate));
    const image = existing !== undefined ? nativeImage.createFromPath(existing) : nativeImage.createEmpty();
    if (process.platform === 'darwin') image.setTemplateImage(true);
    return image;
  };

  const refreshTrayMenu = async (): Promise<void> => {
    if (tray === null) return;
    const prefs = await prefsAndUpdates.readPrefs(spaces.getActiveSpace().path);
    closeToTrayCached = prefs.closeToTray;
    const autostart = prefsAndUpdates.getAutostart();
    let localSpaces: LocalSpaceSummary[] = [];
    try {
      localSpaces = (await daemon.listSpacesAndStatuses()).spaces;
    } catch {
      localSpaces = [];
    }
    const template = buildTrayMenuTemplate({
      zh: prefs.locale === 'zh',
      windowVisible: windows.currentWindow?.isVisible() === true,
      autostartSupported: autostart.supported,
      autostartEnabled: autostart.enabled,
      spaces: localSpaces,
      callbacks: {
        onShowWindow: () => {
          void windows.showMainWindow().then(() => refreshTrayMenu());
        },
        onHideWindow: () => {
          windows.hideMainWindow();
          void refreshTrayMenu();
        },
        onNewSession: () => {
          void windows.showMainWindow().then(() => {
            sendToRenderer(IPC_EVENTS.trayNewSession);
          });
        },
        onOpenSpace: (homeId) => {
          void spaces.findSpace(homeId).then((space) => {
            if (instanceIdentity.effectiveWindowMode === 'switch') {
              daemon.setTargetHome(space.path);
              spaces.setActiveSpace(space);
              return windows.reloadForSwitchedSpace();
            }
            windows.openSpaceWindow(space.path);
            return undefined;
          });
        },
        onStopSpace: (homeId) => {
          void spaces.findSpace(homeId).then(async (space) => {
            await executeStopBackgroundSpace({
              spaceName: space.name,
              spacePath: space.path,
              confirmStopSpace: (name) => confirmStopSpaceDialog(name, prefs.locale === 'zh'),
              stopManagedDaemonForHome: (homeDir, opts) =>
                daemon.stopManagedDaemonForHome(homeDir, opts),
            });
            await refreshTrayMenu();
          });
        },
        onToggleAutostart: (enabled) => {
          try {
            prefsAndUpdates.setAutostart(enabled);
          } finally {
            void refreshTrayMenu();
          }
        },
        onCloseWindowKeepTray: () => {
          windows.hideMainWindow();
          void refreshTrayMenu();
        },
        onQuitCompletely: () => {
          void requestConfirmedQuit();
        },
      },
    });
    tray.setContextMenu(Menu.buildFromTemplate(template));
  };

  // Register macOS open-url BEFORE app.whenReady() so cold deep links are queued cleanly.
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
            .then(async (space) => {
              daemon.setTargetHome(space.path);
              spaces.setActiveSpace(space);
              await windows.reloadForSwitchedSpace();
            })
            .catch(() => windows.showMainWindow());
        } else {
          void windows.showMainWindow();
        }
      } else {
        void refreshTrayMenu();
      }
    } catch {
      void windows.showMainWindow();
    }
  });

  app.on('activate', () => {
    void windows.showMainWindow();
  });

  app.on('window-all-closed', () => {
    if (windows.shouldPreventQuitOnAllWindowsClosed()) return;
    daemon.detachDesktop();
    releaseAppQuit();
  });

  app.on('before-quit', (event: ElectronEvent) => {
    if (quitReleased) return;
    event.preventDefault();
    void requestConfirmedQuit();
  });

  void app.whenReady().then(async () => {
    hardenSession();
    windows.applyInitialWindowlessPolicy();
    if (startupHome === mainHome && instanceIdentity.effectiveWindowMode === 'switch') {
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
            void windows.showMainWindow().then(() => refreshTrayMenu());
          });
        }
      },
    });
    trayActive = trayResult.trayCreated;
    if (trayActive) {
      await refreshTrayMenu();
    } else if (trayResult.revealFallbackWindow) {
      await windows.showMainWindow();
    }

    if (startupHome === mainHome && instanceIdentity.effectiveWindowMode === 'switch') {
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

    if (launchArgs.startTrayOnly) {
      // Windowless tray-only mode: attach only if a verified daemon is already running.
      await daemon.attachIfRunning();
      await refreshTrayMenu();
      return;
    }

    if (!launchArgs.startWindowless) {
      await windows.showMainWindow();
    }

    try {
      const connection = await daemon.discoverConnection();
      if (windows.currentWindow !== null) {
        await windows.navigateToDaemonOrigin(connection.config.url);
      }
      await refreshTrayMenu();
    } catch (error) {
      console.error('Kiki daemon startup failed:', error);
    }
  });
}
