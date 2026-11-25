import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeSettings } from '@kiki/session-core/settings';

import {
  createElectronHost,
  electronHost,
  isElectronHost,
  type KikiElectronBridge,
} from './electron';
import { isDesktopHost } from './host';
import { resolveHostAdapter } from './index';

function createMockBridge() {
  const bridge: KikiElectronBridge = {
    discoverConnection: vi.fn(),
    cancelStartup: vi.fn(),
    onBackendStage: vi.fn(() => () => {}),
    ssh: {
      listProfiles: vi.fn(),
      saveProfile: vi.fn(),
      removeProfile: vi.fn(),
      connectProfile: vi.fn(),
      prepareProfile: vi.fn(),
      resumeScopeConnection: vi.fn(),
      commitScopeConnection: vi.fn(),
      takeScopeConnection: vi.fn(),
      tunnelRunning: vi.fn(),
      disconnectProfile: vi.fn(),
      setWorkspaceScope: vi.fn(),
    },
    window: {
      showMainWindow: vi.fn(),
      isVisibleAndFocused: vi.fn(),
      onFocus: vi.fn(() => () => {}),
      setTheme: vi.fn(),
      setZoom: vi.fn(),
      getWindowMode: vi.fn(),
    },
    pluginFocus: {
      read: vi.fn(),
      ack: vi.fn(),
      remember: vi.fn(),
    },
    notifications: {
      send: vi.fn(),
      acknowledge: vi.fn(),
      onClick: vi.fn(() => () => {}),
      takeNavigationIntent: vi.fn(async () => null),
      setUnreadBadge: vi.fn(),
    },
    files: {
      openSaveSink: vi.fn(),
      writeSaveSink: vi.fn(),
      closeSaveSink: vi.fn(),
      abortSaveSink: vi.fn(),
      saveBlob: vi.fn(),
      pickFilePath: vi.fn(),
      pickFiles: vi.fn(),
      readSelectedFile: vi.fn(),
      pickDirectory: vi.fn(),
      pickDirectories: vi.fn(),
      readClipboardFiles: vi.fn(),
      readDroppedFiles: vi.fn(),
      onFileDrop: vi.fn(() => () => {}),
      revealPath: vi.fn(),
      openPath: vi.fn(),
      openExternalUrl: vi.fn(),
      writeFileText: vi.fn(),
    },
    desktop: {
      readPrefs: vi.fn(),
      writePrefs: vi.fn(),
      getAutostart: vi.fn(),
      setAutostart: vi.fn(),
      activeSpace: vi.fn(),
      spaceStatuses: vi.fn(),
      switchSpace: vi.fn(),
      prepareSpace: vi.fn(),
      openSpace: vi.fn(),
      openRemoteSpace: vi.fn(),
      createSpaceShortcut: vi.fn(),
      restartSpace: vi.fn(),
      restartServer: vi.fn(),
      logInfo: vi.fn(),
      openLogDirectory: vi.fn(),
      supportsUpdates: vi.fn(),
      checkUpdate: vi.fn(),
      installUpdate: vi.fn(),
      mutateUpdateState: vi.fn(),
      onTrayNewSession: vi.fn(() => () => {}),
      peekSubscribeIntent: vi.fn(async () => null),
      ackSubscribeIntent: vi.fn(async () => false),
      onSubscribeIntent: vi.fn(() => () => {}),
      onSubscribeUrl: vi.fn(() => () => {}),
    },
  };
  return bridge;
}

describe('Electron host adapter', () => {
  beforeEach(() => {
    delete (globalThis as { __KIKI_ELECTRON__?: unknown }).__KIKI_ELECTRON__;
    delete (globalThis as { __KIKI_SUBSCRIBE_URL__?: unknown }).__KIKI_SUBSCRIBE_URL__;
  });

  afterEach(() => {
    delete (globalThis as { __KIKI_ELECTRON__?: unknown }).__KIKI_ELECTRON__;
    delete (globalThis as { __KIKI_SUBSCRIBE_URL__?: unknown }).__KIKI_SUBSCRIBE_URL__;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('deduplicates in-flight discovery, retries after failure, and gates restarts behind cancelStartup', async () => {
    const bridge = createMockBridge();
    const host = createElectronHost(bridge);
    expect(isDesktopHost(host)).toBe(true);
    expect(host.kind).toBe('electron');

    let rejectFirst!: (error: Error) => void;
    vi.mocked(bridge.discoverConnection).mockReturnValueOnce(
      new Promise((_resolve, reject) => { rejectFirst = reject; }),
    );
    const first = host.connection.discover();
    const second = host.connection.discover();
    expect(bridge.discoverConnection).toHaveBeenCalledOnce();
    rejectFirst(new Error('boot failed'));
    expect((await Promise.allSettled([first, second])).map((item) => item.status)).toEqual(['rejected', 'rejected']);

    let rejectOld!: (error: Error) => void;
    let resolveCancel!: () => void;
    vi.mocked(bridge.discoverConnection).mockReturnValueOnce(
      new Promise((_resolve, reject) => { rejectOld = reject; }),
    );
    vi.mocked(bridge.cancelStartup).mockReturnValueOnce(
      new Promise<void>((resolve) => { resolveCancel = resolve; }),
    );

    const oldFlight = host.connection.discover().catch(() => undefined);
    const cancel = host.connection.cancelStartup();
    const nextFlight = host.connection.discover();
    expect(bridge.discoverConnection).toHaveBeenCalledTimes(2);
    expect(bridge.cancelStartup).toHaveBeenCalledOnce();

    resolveCancel();
    await Promise.resolve();
    expect(bridge.discoverConnection).toHaveBeenCalledTimes(2);

    const endpoint = { config: { url: 'http://127.0.0.1:43210', token: 'fixture-token' }, persist: false };
    vi.mocked(bridge.discoverConnection).mockResolvedValueOnce(endpoint);
    rejectOld(new Error('cancelled'));
    await oldFlight;
    await cancel;
    await expect(nextFlight).resolves.toEqual(endpoint);
    expect(bridge.discoverConnection).toHaveBeenCalledTimes(3);
  });

  it('forwards SSH profile/tunnel bridge calls and blocks local file ops while SSH scope is active', async () => {
    const bridge = createMockBridge();
    const host = createElectronHost(bridge);
    const profile = {
      id: 'host-1',
      label: 'Remote',
      target: { kind: 'alias', alias: 'remote-box' },
      releaseChannel: 'stable',
    } as const;
    const resolved = {
      config: { url: 'http://127.0.0.1:45555', token: 'ssh-token' },
      tunnelId: 'tunnel-1',
      serverHomeId: 'home-remote',
      serverInstanceId: 'inst-1',
      serverVersion: '0.7.0',
      buildId: null,
      buildChannel: null,
    };

    vi.mocked(bridge.ssh.listProfiles).mockResolvedValueOnce([profile]);
    vi.mocked(bridge.ssh.saveProfile).mockResolvedValueOnce([profile]);
    vi.mocked(bridge.ssh.removeProfile).mockResolvedValueOnce([]);
    vi.mocked(bridge.ssh.connectProfile).mockResolvedValueOnce(resolved);
    vi.mocked(bridge.ssh.prepareProfile).mockResolvedValueOnce(resolved);
    vi.mocked(bridge.ssh.resumeScopeConnection).mockResolvedValueOnce({ profile, connection: resolved });
    vi.mocked(bridge.ssh.commitScopeConnection).mockResolvedValueOnce(undefined);
    vi.mocked(bridge.ssh.takeScopeConnection).mockResolvedValueOnce({ profile, connection: resolved });
    vi.mocked(bridge.ssh.tunnelRunning).mockResolvedValueOnce(true);
    vi.mocked(bridge.ssh.disconnectProfile).mockResolvedValueOnce(undefined);

    await expect(host.connection.listSshProfiles()).resolves.toEqual([profile]);
    await expect(host.connection.saveSshProfile(profile)).resolves.toEqual([profile]);
    await expect(host.connection.removeSshProfile('host-1')).resolves.toEqual([]);
    await expect(host.connection.connectSshProfile('host-1', 'tok')).resolves.toEqual(resolved);
    await expect(host.connection.prepareSshProfile('host-1', 'tok')).resolves.toEqual(resolved);
    await expect(host.connection.resumeScopeConnection('home-1', 'host-1', 'tunnel-1')).resolves.toEqual({ profile, connection: resolved });
    await expect(host.connection.commitScopeConnection('home-1', 'host-1', 'tunnel-1', true)).resolves.toBeUndefined();
    await expect(host.connection.takeScopeConnection()).resolves.toEqual({ profile, connection: resolved });
    await expect(host.connection.sshTunnelRunning('host-1', 'tunnel-1')).resolves.toBe(true);
    await expect(host.connection.disconnectSshProfile('host-1', 'tunnel-1')).resolves.toBeUndefined();

    host.connection.setWorkspaceScope('ssh');
    expect(bridge.ssh.setWorkspaceScope).toHaveBeenCalledWith('ssh');
    await expect(host.pickFilePath()).rejects.toThrow('SSH workspace');
    await expect(host.pickDirectory()).rejects.toThrow('SSH workspace');
    await expect(host.pickDirectories()).rejects.toThrow('SSH workspace');
    await expect(host.revealPath('/C:/work/file.ts')).rejects.toThrow('SSH workspace');
    await expect(host.openPath('/C:/work/file.ts')).rejects.toThrow('SSH workspace');
    await expect(host.writeFileText('/C:/work/file.ts', 'hello')).rejects.toThrow('SSH workspace');
    expect(bridge.files.openPath).not.toHaveBeenCalled();

    host.connection.setWorkspaceScope('local');
    vi.mocked(bridge.files.revealPath).mockResolvedValueOnce(undefined);
    vi.mocked(bridge.files.openPath).mockResolvedValueOnce(undefined);
    vi.mocked(bridge.files.writeFileText).mockResolvedValueOnce(undefined);
    await host.revealPath('/C:/work/file.ts');
    await host.openPath('/D:\\work\\dir');
    await host.writeFileText('/C:/work/note.md', 'content');
    expect(bridge.files.revealPath).toHaveBeenCalledWith('C:/work/file.ts');
    expect(bridge.files.openPath).toHaveBeenCalledWith('D:\\work\\dir');
    expect(bridge.files.writeFileText).toHaveBeenCalledWith('C:/work/note.md', 'content');
  });

  it('streams chunks through openSaveSink and enforces close/abort lifecycle', async () => {
    const bridge = createMockBridge();
    const host = createElectronHost(bridge);

    vi.mocked(bridge.files.openSaveSink).mockResolvedValueOnce(null);
    await expect(host.openSaveSink('cancelled.bin')).resolves.toBeNull();

    vi.mocked(bridge.files.openSaveSink).mockResolvedValueOnce({ sinkId: 'sink-1' });
    vi.mocked(bridge.files.writeSaveSink).mockResolvedValue(undefined);
    vi.mocked(bridge.files.closeSaveSink).mockResolvedValueOnce(true);
    const sink = (await host.openSaveSink('image.png'))!;
    expect(sink.streaming).toBe(true);
    await sink.write(new Uint8Array([1, 2, 3]));
    await expect(sink.close()).resolves.toBe(true);
    await expect(sink.close()).resolves.toBe(false);
    await expect(sink.write(new Uint8Array([4]))).rejects.toThrow('closed');
    expect(bridge.files.writeSaveSink).toHaveBeenCalledExactlyOnceWith('sink-1', new Uint8Array([1, 2, 3]));
    expect(bridge.files.closeSaveSink).toHaveBeenCalledExactlyOnceWith('sink-1');

    vi.mocked(bridge.files.openSaveSink).mockResolvedValueOnce({ sinkId: 'sink-2' });
    vi.mocked(bridge.files.abortSaveSink).mockResolvedValueOnce(undefined);
    const aborted = (await host.openSaveSink('abort.bin'))!;
    await aborted.abort();
    await aborted.abort();
    expect(bridge.files.abortSaveSink).toHaveBeenCalledExactlyOnceWith('sink-2');
    await expect(aborted.write(new Uint8Array([9]))).rejects.toThrow('closed');

    vi.mocked(bridge.files.openSaveSink).mockResolvedValueOnce({ sinkId: 'sink-3' });
    vi.mocked(bridge.files.closeSaveSink).mockRejectedValueOnce(new Error('disk full'));
    vi.mocked(bridge.files.abortSaveSink).mockResolvedValueOnce(undefined);
    const failedClose = (await host.openSaveSink('failed.bin'))!;
    await expect(failedClose.close()).rejects.toThrow('disk full');
    await expect(failedClose.write(new Uint8Array([1]))).rejects.toThrow('closed');
    await failedClose.abort();
    await failedClose.abort();
    expect(bridge.files.abortSaveSink).toHaveBeenCalledWith('sink-3');

    vi.mocked(bridge.files.saveBlob).mockResolvedValueOnce(true);
    await expect(host.saveBlob(new Blob([new Uint8Array([7, 8])]), 'clip.bin')).resolves.toBe(true);
    expect(bridge.files.saveBlob).toHaveBeenCalledWith(new Uint8Array([7, 8]), 'clip.bin');
  });

  it('wraps picked, clipboard, and dropped files lazily and disposes file-drop listeners', async () => {
    const bridge = createMockBridge();
    const host = createElectronHost(bridge);

    vi.mocked(bridge.files.pickFiles).mockResolvedValueOnce([
      { token: 'tok-1', name: 'photo.png', size: 3, type: 'image/png' },
    ]);
    vi.mocked(bridge.files.readSelectedFile).mockResolvedValue(new Uint8Array([10, 20, 30]));
    const picked = await host.pickFiles();
    expect(bridge.files.readSelectedFile).not.toHaveBeenCalled();
    expect(picked).toHaveLength(1);
    const file = await picked![0]!.read();
    expect(bridge.files.readSelectedFile).toHaveBeenCalledExactlyOnceWith('tok-1');
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe('photo.png');
    expect(file.type).toBe('image/png');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([10, 20, 30]));

    vi.mocked(bridge.files.readClipboardFiles).mockResolvedValueOnce({
      paths: ['C:/doc.pdf'],
      files: [{ token: 'tok-2', name: 'shot.webp', size: 2, type: 'image/webp' }],
    });
    const clipboard = await host.readClipboardFiles();
    expect(clipboard?.paths).toEqual(['C:/doc.pdf']);
    expect(clipboard?.media).toHaveLength(1);
    await clipboard!.media[0]!.read();
    expect(bridge.files.readSelectedFile).toHaveBeenCalledWith('tok-2');

    vi.mocked(bridge.files.readDroppedFiles).mockResolvedValueOnce({
      paths: ['C:/README.md'],
      files: [{ token: 'tok-3', name: 'clip.png', size: 1, type: 'image/png' }],
    });
    const dropped = await host.readDroppedFiles(['C:/README.md', 'C:/clip.png']);
    expect(dropped.paths).toEqual(['C:/README.md']);
    expect(dropped.media).toHaveLength(1);

    let emitDrop!: (drop: { paths: readonly string[]; position?: { x: number; y: number } }) => void;
    const unlistenDrop = vi.fn();
    vi.mocked(bridge.files.onFileDrop).mockImplementation((cb) => {
      emitDrop = cb;
      return unlistenDrop;
    });
    const onDrop = vi.fn();
    const stopDrop = host.onFileDrop(onDrop);
    emitDrop({ paths: ['C:/a.txt'], position: { x: 40, y: 80 } });
    expect(onDrop).toHaveBeenCalledExactlyOnceWith({ paths: ['C:/a.txt'], position: { x: 40, y: 80 } });
    stopDrop();
    expect(unlistenDrop).toHaveBeenCalledOnce();
    emitDrop({ paths: ['C:/b.txt'] });
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it('sanitizes notification scope, clamps unread badges, and handles live vs boot clicks cleanly', async () => {
    const bridge = createMockBridge();
    const host = createElectronHost(bridge);

    const rawScope = {
      homeId: 'home-a',
      scopeId: 'ssh:box',
      serverHomeId: 'server-a',
      connectionRef: 'conn-a',
      token: 'secret-token',
    };
    await host.notify({ title: 'Done', route: '/s/1', scope: rawScope, sessionIds: ['1'], deliveryId: 'del-1' });
    await host.acknowledgeNotifications('1', rawScope, 'del-1');
    const cleanScope = { homeId: 'home-a', scopeId: 'ssh:box', serverHomeId: 'server-a', connectionRef: 'conn-a' };
    expect(bridge.notifications.send).toHaveBeenCalledWith({
      title: 'Done',
      route: '/s/1',
      scope: cleanScope,
      sessionIds: ['1'],
      deliveryId: 'del-1',
    });
    expect(bridge.notifications.acknowledge).toHaveBeenCalledWith('1', cleanScope, 'del-1');

    await host.setUnreadBadge(-5.8, 'home-a', 'local', ['1']);
    expect(bridge.notifications.setUnreadBadge).toHaveBeenCalledWith(0, 'home-a', 'local', ['1']);
    vi.mocked(bridge.notifications.setUnreadBadge).mockRejectedValueOnce(new Error('unsupported'));
    await expect(host.setUnreadBadge(3)).resolves.toBeUndefined();

    let emitClick!: (route: string, homeId?: string, scope?: typeof cleanScope) => void;
    let resolveBootIntent!: (value: { route: string; homeId?: string } | null) => void;
    const unlistenClick = vi.fn();
    vi.mocked(bridge.notifications.onClick).mockImplementation((cb) => {
      emitClick = cb;
      return unlistenClick;
    });
    vi.mocked(bridge.notifications.takeNavigationIntent).mockReturnValueOnce(
      new Promise((resolve) => { resolveBootIntent = resolve; }),
    );
    const received: unknown[] = [];
    const stop = host.onNotificationClick((route, homeId, scope) => {
      received.push([route, homeId, scope]);
    });
    emitClick('/s/live', 'home-a', cleanScope);
    resolveBootIntent({ route: '/s/stale-boot', homeId: 'home-a' });
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toEqual([['/s/live', 'home-a', cleanScope]]);
    stop();
    expect(unlistenClick).toHaveBeenCalledOnce();
    emitClick('/s/after-stop');
    expect(received).toHaveLength(1);
  });

  it('pumps subscribe intents FIFO with dedup, advances on ACK, and drains __KIKI_SUBSCRIBE_URL__', async () => {
    const bridge = createMockBridge();
    const host = createElectronHost(bridge);

    const queue = [
      { id: '1', url: 'https://example.test/pack-a.tgz', name: 'A', mode: 'auto' as const },
      { id: '2', url: 'https://example.test/pack-b.tgz', name: 'B', mode: 'manual' as const },
    ];
    let wake!: (intent: { id: string; url: string }) => void;
    vi.mocked(bridge.desktop.onSubscribeIntent).mockImplementation((cb) => {
      wake = cb;
      return () => {};
    });
    vi.mocked(bridge.desktop.peekSubscribeIntent).mockImplementation(async () => queue[0] ?? null);
    vi.mocked(bridge.desktop.ackSubscribeIntent).mockImplementation(async (id) => {
      if (queue[0]?.id === id) {
        queue.shift();
        return true;
      }
      return false;
    });

    const received: unknown[] = [];
    const stop = host.onSubscribeIntent((intent) => received.push(intent));
    await vi.waitFor(() => {
      expect(received).toEqual([
        { id: '1', url: 'https://example.test/pack-a.tgz', name: 'A', mode: 'auto' },
      ]);
    });

    wake({ id: '1', url: 'https://example.test/pack-a.tgz' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toHaveLength(1);

    await expect(host.ackSubscribeIntent('1')).resolves.toBe(true);
    await vi.waitFor(() => {
      expect(received).toEqual([
        { id: '1', url: 'https://example.test/pack-a.tgz', name: 'A', mode: 'auto' },
        { id: '2', url: 'https://example.test/pack-b.tgz', name: 'B', mode: 'manual' },
      ]);
    });
    stop();

    (globalThis as { __KIKI_SUBSCRIBE_URL__?: string }).__KIKI_SUBSCRIBE_URL__ = ' https://example.test/boot.tgz ';
    let emitLegacy!: (url: string) => void;
    vi.mocked(bridge.desktop.onSubscribeUrl).mockImplementation((cb) => {
      emitLegacy = cb;
      return () => {};
    });
    const urls: string[] = [];
    const stopUrl = host.onSubscribeUrl((url) => urls.push(url));
    await vi.waitFor(() => {
      expect(urls).toContain('https://example.test/boot.tgz');
    });
    emitLegacy('https://example.test/legacy.tgz');
    expect(urls).toContain('https://example.test/legacy.tgz');
    stopUrl();
  });

  it('forwards update install closure, prefs clearing, window focus/mode, pluginFocus, zoom, and theme', async () => {
    const bridge = createMockBridge();
    const host = createElectronHost(bridge);

    vi.mocked(bridge.desktop.checkUpdate).mockResolvedValueOnce({
      currentVersion: '0.6.1',
      version: '0.7.0',
      notes: 'Electron release',
    });
    const update = await host.checkDesktopUpdate('beta');
    expect(update).toMatchObject({ currentVersion: '0.6.1', version: '0.7.0', notes: 'Electron release' });
    await update!.install();
    expect(bridge.desktop.checkUpdate).toHaveBeenCalledWith('beta');
    expect(bridge.desktop.installUpdate).toHaveBeenCalledWith('beta', '0.7.0');

    await host.writeDesktopPrefs({ updateState: undefined });
    expect(bridge.desktop.writePrefs).toHaveBeenCalledWith({ updateState: {} });

    vi.mocked(bridge.window.setZoom).mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('closed'));
    await expect(host.setZoom(1.25)).resolves.toBe(true);
    await expect(host.setZoom(1.5)).resolves.toBe(false);

    vi.mocked(bridge.window.setTheme).mockResolvedValue(undefined);
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => { store.clear(); },
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() { return store.size; },
    });
    writeSettings({ theme: 'system' });
    await host.setTheme('dark');
    writeSettings({ theme: 'dark' });
    await host.setTheme('dark');
    expect(vi.mocked(bridge.window.setTheme).mock.calls).toEqual([['system'], ['dark']]);

    let emitFocus!: () => void;
    const unlistenFocus = vi.fn();
    vi.mocked(bridge.window.onFocus).mockImplementation((cb) => {
      emitFocus = cb;
      return unlistenFocus;
    });
    const onFocus = vi.fn();
    const stopFocus = host.onWindowFocus(onFocus);
    emitFocus();
    expect(onFocus).toHaveBeenCalledOnce();
    stopFocus();
    expect(unlistenFocus).toHaveBeenCalledOnce();
    emitFocus();
    expect(onFocus).toHaveBeenCalledTimes(1);

    vi.mocked(bridge.window.getWindowMode).mockResolvedValueOnce({ presetId: 'work', windowId: 'win-1' });
    await expect(host.windowMode()).resolves.toEqual({ presetId: 'work', windowId: 'win-1' });

    vi.mocked(bridge.pluginFocus.read).mockResolvedValueOnce({
      homeId: 'space-a',
      route: '/s/session-1',
      requestId: 7,
    });
    await expect(host.pluginFocus.read()).resolves.toEqual({
      homeId: 'space-a',
      route: '/s/session-1',
      requestId: 7,
    });
    await host.pluginFocus.remember('space-a', 7);
    await host.pluginFocus.ack('space-a', 7);
    expect(bridge.pluginFocus.remember).toHaveBeenCalledWith('space-a', 7);
    expect(bridge.pluginFocus.ack).toHaveBeenCalledWith('space-a', 7);
  });

  it('binds singleton electronHost to globalThis.__KIKI_ELECTRON__ and selects Electron ahead of Tauri in host/index', async () => {
    expect(isElectronHost()).toBe(false);
    await expect(electronHost.showMainWindow()).rejects.toThrow('Electron host bridge is unavailable');

    const bridge = createMockBridge();
    vi.mocked(bridge.window.showMainWindow).mockResolvedValueOnce(undefined);
    (globalThis as { isTauri?: unknown }).isTauri = true;
    try {
      expect(resolveHostAdapter().kind).toBe('tauri');

      (globalThis as { __KIKI_ELECTRON__?: KikiElectronBridge }).__KIKI_ELECTRON__ = bridge;
      expect(isElectronHost()).toBe(true);
      expect(resolveHostAdapter().kind).toBe('electron');
      await electronHost.showMainWindow();
      expect(bridge.window.showMainWindow).toHaveBeenCalledOnce();
    } finally {
      delete (globalThis as { isTauri?: unknown }).isTauri;
    }
  });

  it('enforces zero @tauri-apps/* imports in production apps/kiki-gui/src outside src/host/tauri.ts and src/host/index.tsx', async () => {
    const srcRoot = fileURLToPath(new URL('..', import.meta.url));
    const entries = await readdir(srcRoot, { recursive: true, withFileTypes: true });
    const allowed = new Set(['host/tauri.ts', 'host/index.tsx']);
    const candidates = entries
      .filter((entry) => entry.isFile() && /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name) && !/\.test\./.test(entry.name))
      .map((entry) => {
        const fullPath = join(entry.parentPath, entry.name);
        return { fullPath, rel: relative(srcRoot, fullPath).replaceAll('\\', '/') };
      })
      .filter(({ rel }) => !allowed.has(rel));

    const results = await Promise.all(
      candidates.map(async ({ fullPath, rel }) => {
        const content = await readFile(fullPath, 'utf8');
        return /@tauri-apps\//.test(content) ? rel : null;
      }),
    );

    expect(results.filter((item): item is string => item !== null)).toEqual([]);
  }, 15_000);
});
