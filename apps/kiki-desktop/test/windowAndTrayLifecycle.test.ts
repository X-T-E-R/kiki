import { describe, expect, it } from 'vitest';
import {
  parseLaunchArgs,
  resolveInstanceIdentity,
} from '#/main/launchArgs';
import {
  buildTrayMenuTemplate,
  retryTrayCreation,
} from '#/main/trayService';
import {
  isAllowedRendererNavigation,
  shouldBlockRendererAccelerator,
  WindowService,
  type ManagedWindowLike,
} from '#/main/windowService';

function createFakeWindow(): ManagedWindowLike & {
  visible: boolean;
  focused: boolean;
  minimized: boolean;
  fullScreen: boolean;
  lastLoadedUrl: string | null;
  zoomFactor: number;
  triggerLeaveFullScreen: () => void;
} {
  let leaveFullScreenListener: (() => void) | null = null;
  const win = {
    visible: false,
    focused: false,
    minimized: false,
    fullScreen: false,
    lastLoadedUrl: null as string | null,
    zoomFactor: 1,
    isDestroyed: () => false,
    isVisible: () => win.visible,
    isFocused: () => win.focused,
    isMinimized: () => win.minimized,
    isFullScreen: () => win.fullScreen,
    restore: () => {
      win.minimized = false;
    },
    show: () => {
      win.visible = true;
    },
    focus: () => {
      win.focused = true;
    },
    hide: () => {
      win.visible = false;
      win.focused = false;
    },
    setFullScreen: (flag: boolean) => {
      win.fullScreen = flag;
    },
    once: (_event: 'leave-full-screen', listener: () => void) => {
      leaveFullScreenListener = listener;
    },
    triggerLeaveFullScreen: () => {
      const fn = leaveFullScreenListener;
      leaveFullScreenListener = null;
      fn?.();
    },
    reload: () => undefined,
    loadURL: async (url: string) => {
      win.lastLoadedUrl = url;
    },
    setZoomFactor: (factor: number) => {
      win.zoomFactor = factor;
    },
    close: () => undefined,
  };
  return win;
}

describe('launchArgs and single-instance identity', () => {
  it('parses --tray-only, --autostart, --home, --preset, and --remote-connection via node:util parseArgs', () => {
    const trayOnly = parseLaunchArgs(['kiki-desktop', '--tray-only']);
    expect(trayOnly.startTrayOnly).toBe(true);
    expect(trayOnly.startWindowless).toBe(true);
    expect(trayOnly.startInBackground).toBe(true);

    const autostart = parseLaunchArgs(['kiki-desktop', '--autostart']);
    expect(autostart.startAutostart).toBe(true);
    expect(autostart.startWindowless).toBe(true);

    const remoteId = '11111111-1111-4111-8111-111111111111';
    const full = parseLaunchArgs([
      'kiki-desktop',
      '--home',
      '/spaces/work',
      '--preset',
      'work',
      '--remote-connection',
      remoteId,
      'kiki://subscribe?url=https%3A%2F%2Fexample.com',
    ]);
    expect(full.home).toBe('/spaces/work');
    expect(full.preset).toBe('work');
    expect(full.remoteConnection).toBe(remoteId);
    expect(full.positionals).toEqual(['kiki://subscribe?url=https%3A%2F%2Fexample.com']);
  });

  it('rejects malformed or duplicate --preset and --remote-connection flags', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(() => parseLaunchArgs(['kiki-desktop', '--preset', '../bad'])).toThrow(/--preset/);
    expect(() => parseLaunchArgs(['kiki-desktop', '--preset', 'work', '--preset', 'kiki'])).toThrow(/--preset/);
    expect(() => parseLaunchArgs(['kiki-desktop', '--remote-connection', 'https://bad.example'])).toThrow(/remote connection/);
    expect(() =>
      parseLaunchArgs(['kiki-desktop', '--remote-connection', id, '--remote-connection', id]),
    ).toThrow(/Only one remote connection/);
  });

  it('produces distinct single-instance keys for child spaces, remote connections, and work presets', () => {
    const id1 = '11111111-1111-4111-8111-111111111111';
    const id2 = '22222222-2222-4222-8222-222222222222';
    const main = resolveInstanceIdentity({
      baseAppId: 'com.kiki.desktop',
      startupHome: '/home/user/.kiki',
      mainHome: '/home/user/.kiki',
      windowMode: 'switch',
      platform: 'linux',
    });
    const remote1 = resolveInstanceIdentity({
      baseAppId: 'com.kiki.desktop',
      startupHome: '/home/user/.kiki',
      mainHome: '/home/user/.kiki',
      windowMode: 'windows',
      remoteConnection: id1,
      platform: 'linux',
    });
    const remote2 = resolveInstanceIdentity({
      baseAppId: 'com.kiki.desktop',
      startupHome: '/home/user/.kiki',
      mainHome: '/home/user/.kiki',
      windowMode: 'windows',
      remoteConnection: id2,
      platform: 'linux',
    });
    const presetWork = resolveInstanceIdentity({
      baseAppId: 'com.kiki.desktop',
      startupHome: '/home/user/.kiki',
      mainHome: '/home/user/.kiki',
      windowMode: 'switch',
      preset: 'work',
      platform: 'linux',
    });

    expect(new Set([main.userDataSuffix, remote1.userDataSuffix, remote2.userDataSuffix, presetWork.userDataSuffix]).size).toBe(4);
    expect(remote1.effectiveWindowMode).toBe('windows');
    expect(presetWork.descriptor.presetId).toBe('work');
  });
});

describe('WindowService and TrayService', () => {
  it('hides macOS Dock on windowless startup, reveals Dock on showMainWindow, and guards window-all-closed while tray active', async () => {
    const dockEvents: boolean[] = [];
    const fakeWin = createFakeWindow();
    const service = new WindowService({
      platform: 'darwin',
      windowMode: { presetId: 'kiki', windowId: 'w-main' },
      spaceWindowMode: 'switch',
      startWindowless: true,
      getCloseToTray: () => true,
      isTrayActive: () => true,
      createBrowserWindow: async (url) => {
        await fakeWin.loadURL(url);
        return fakeWin;
      },
      getDaemonOrigin: () => 'http://127.0.0.1:41234',
      ensureDaemonOrigin: async () => 'http://127.0.0.1:41234',
      detachDesktop: () => undefined,
      releaseAppQuit: () => undefined,
      setDockVisible: (visible) => dockEvents.push(visible),
      resolveLaunchExecutable: () => '/Applications/Kiki.app/Contents/MacOS/Kiki',
    });

    service.applyInitialWindowlessPolicy();
    expect(dockEvents).toEqual([false]);
    expect(service.currentWindow).toBeNull();
    expect(service.shouldPreventQuitOnAllWindowsClosed()).toBe(true);

    await service.showMainWindow();
    expect(dockEvents).toEqual([false, true]);
    expect(fakeWin.visible).toBe(true);
    expect(fakeWin.lastLoadedUrl).toBe('http://127.0.0.1:41234');

    // macOS fullscreen close uses leave-full-screen -> hide cleanly (no objc2)
    fakeWin.fullScreen = true;
    let prevented = false;
    service.onWindowClose({
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
    expect(fakeWin.fullScreen).toBe(false);
    expect(fakeWin.visible).toBe(true);
    fakeWin.triggerLeaveFullScreen();
    expect(fakeWin.visible).toBe(false);
  });

  it('detaches desktop on close when close_to_tray=false without stopping ready daemon', async () => {
    let detached = false;
    let quitReleased = false;
    const fakeWin = createFakeWindow();

    const service = new WindowService({
      platform: 'win32',
      windowMode: { presetId: 'kiki', windowId: 'w-main' },
      spaceWindowMode: 'switch',
      startWindowless: false,
      getCloseToTray: () => false,
      isTrayActive: () => true,
      createBrowserWindow: async () => fakeWin,
      getDaemonOrigin: () => 'http://127.0.0.1:41234',
      ensureDaemonOrigin: async () => 'http://127.0.0.1:41234',
      detachDesktop: () => {
        detached = true;
      },
      releaseAppQuit: () => {
        quitReleased = true;
      },
      resolveLaunchExecutable: () => 'C:/Kiki/active/kiki-desktop.exe',
    });

    await service.showMainWindow();
    service.onWindowClose({ preventDefault: () => undefined });
    expect(detached).toBe(true);
    expect(quitReleased).toBe(true);
    expect(service.isQuitting).toBe(true);
  });

  it('retries Windows tray creation and reveals fallback window if all logon retries fail', async () => {
    let attempts = 0;
    const recovered = await retryTrayCreation({
      startInBackground: true,
      isQuitting: () => false,
      retryLimit: 3,
      delayMs: 0,
      sleep: async () => undefined,
      attemptCreate: () => {
        attempts += 1;
        if (attempts < 3) throw new Error('Explorer tray shell not ready');
      },
    });
    expect(recovered).toEqual({
      trayCreated: true,
      revealFallbackWindow: false,
      attempts: 3,
    });

    const exhausted = await retryTrayCreation({
      startInBackground: true,
      isQuitting: () => false,
      retryLimit: 2,
      delayMs: 0,
      sleep: async () => undefined,
      attemptCreate: () => {
        throw new Error('Tray unavailable');
      },
    });
    expect(exhausted.trayCreated).toBe(false);
    expect(exhausted.revealFallbackWindow).toBe(true);
    expect(exhausted.attempts).toBe(3);
  });

  it('enforces loopback-only navigation guard and blocks browser reload/print accelerators', () => {
    expect(isAllowedRendererNavigation('http://127.0.0.1:41234/s/abc', 'http://127.0.0.1:41234')).toBe(true);
    expect(isAllowedRendererNavigation('data:text/html;charset=utf-8,hi', null)).toBe(true);
    expect(isAllowedRendererNavigation('file:///C:/Windows/win.ini', 'http://127.0.0.1:41234')).toBe(false);
    expect(isAllowedRendererNavigation('https://evil.example.test', 'http://127.0.0.1:41234')).toBe(false);

    expect(
      shouldBlockRendererAccelerator({
        type: 'keyDown',
        key: 'F5',
        control: false,
        meta: false,
        alt: false,
        shift: false,
      }),
    ).toBe(true);
    expect(
      shouldBlockRendererAccelerator({
        type: 'keyDown',
        key: 'r',
        control: true,
        meta: false,
        alt: false,
        shift: false,
      }),
    ).toBe(true);
    expect(
      shouldBlockRendererAccelerator({
        type: 'keyDown',
        key: 'k',
        control: true,
        meta: false,
        alt: false,
        shift: false,
      }),
    ).toBe(false);
  });

  it('builds localized zh/en tray menus including local spaces and autostart toggle', () => {
    const menu = buildTrayMenuTemplate({
      zh: true,
      windowVisible: false,
      autostartSupported: true,
      autostartEnabled: true,
      spaces: [{ homeId: 'main', name: 'Main space', path: '/kiki', status: 'running', active: true, managed: true }],
      callbacks: {
        onShowWindow: () => undefined,
        onHideWindow: () => undefined,
        onNewSession: () => undefined,
        onOpenSpace: () => undefined,
        onStopSpace: () => undefined,
        onToggleAutostart: () => undefined,
        onCloseWindowKeepTray: () => undefined,
        onQuitCompletely: () => undefined,
      },
    });
    expect(menu.some((item) => item.label === '打开主窗口')).toBe(true);
    expect(menu.some((item) => item.label === '本地空间')).toBe(true);
    expect(menu.some((item) => item.label === '完全退出（停止后台服务）')).toBe(true);
  });
});
