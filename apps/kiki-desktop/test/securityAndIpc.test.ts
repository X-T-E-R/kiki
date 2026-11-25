import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';
import { FuseState, FuseV1Options } from '@electron/fuses';
import { DaemonSupervisor } from '#/main/daemonSupervisor';
import {
  decodeClipboardUriList,
  FileAndClipboardService,
  validateExternalUrl,
  validateHostPath,
} from '#/main/fileAndClipboardService';
import { NotificationService, type NativeNotificationHandle } from '#/main/notificationService';
import { PrefsAndUpdateService } from '#/main/prefsAndUpdateService';
import { createIpcHandlers } from '#/main/registerIpc';
import { SpaceCatalog } from '#/main/spaceCatalog';
import { parseSubscribeIntent, SubscribeIntentQueue } from '#/main/subscribeIntent';
import { WindowService } from '#/main/windowService';
import { IPC_CHANNELS } from '#/shared/ipcChannels';
import { verifyFuseConfig } from '../scripts/verify-fuses.mjs';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kiki-desktop-sec-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('host path and URL safety', () => {
  it('blocks UNC, device, verbatim, relative, and executable paths on open while permitting reveal/write', async () => {
    await expect(validateHostPath('\\\\server\\share\\file.txt', 'open', 'win32')).rejects.toThrow(/plain local drive/);
    await expect(validateHostPath('\\\\.\\PhysicalDrive0', 'write', 'win32')).rejects.toThrow(/plain local drive/);
    await expect(validateHostPath('\\\\?\\C:\\file.txt', 'reveal', 'win32')).rejects.toThrow(/plain local drive/);
    await expect(validateHostPath('relative/file.txt', 'open', 'linux')).rejects.toThrow(/absolute/);
    await expect(validateHostPath('C:/tools/run.exe', 'open', 'win32')).rejects.toThrow(/executable/);
    await expect(validateHostPath('C:/tools/run.bat. ', 'open', 'win32')).rejects.toThrow(/executable/);
    await expect(validateHostPath('/Applications/Evil.app', 'open', 'darwin')).rejects.toThrow(/executable/);
    await expect(validateHostPath('/home/u/evil.desktop', 'open', 'linux')).rejects.toThrow(/executable/);

    expect(await validateHostPath('/C:/docs/readme.md', 'open', 'win32')).toBe('C:/docs/readme.md');
    expect(await validateHostPath('C:/tools/run.exe', 'reveal', 'win32')).toBe('C:/tools/run.exe');
  });

  it('blocks internal webview hosts, document origins, non-http(s)/mailto schemes, and control characters', () => {
    expect(validateExternalUrl('https://example.com/docs')).toBe('https://example.com/docs');
    expect(validateExternalUrl('mailto:team@example.test')).toBe('mailto:team@example.test');
    expect(() => validateExternalUrl('file:///etc/passwd')).toThrow(/external http/);
    expect(() => validateExternalUrl('javascript:alert(1)')).toThrow(/external http/);
    expect(() => validateExternalUrl('http://tauri.localhost/')).toThrow(/external http/);
    expect(() => validateExternalUrl('http://abc.kiki-document.localhost:9999/')).toThrow(/external http/);
    expect(() => validateExternalUrl('mailto:   ')).toThrow(/external http/);
    expect(() => validateExternalUrl('https://example.com/\n')).toThrow(/Invalid URL/);
  });

  it('parses kiki://subscribe deep links via URL/URLSearchParams and manages FIFO queue', () => {
    const parsed = parseSubscribeIntent(
      'kiki://subscribe?url=https%3A%2F%2Fexample.com%2Fsub.json&name=Team+Feed&mode=auto',
    );
    expect(parsed).toEqual({
      url: 'https://example.com/sub.json',
      name: 'Team Feed',
      mode: 'auto',
    });
    expect(() => parseSubscribeIntent('kiki://subscribe?url=http://example.com/insecure')).toThrow(/https/);
    expect(() => parseSubscribeIntent('kiki://subscribe?url=https://a.example&url=https://b.example')).toThrow(/Duplicate/);

    const queue = new SubscribeIntentQueue();
    const first = queue.enqueue(parsed!);
    expect(queue.peek()?.id).toBe(first.id);
    expect(queue.ack('wrong-id')).toBe(false);
    expect(queue.ack(first.id)).toBe(true);
    expect(queue.peek()).toBeNull();
  });

  it('decodes file:// clipboard URI lists via node:url fileURLToPath', () => {
    const posixDecoded = decodeClipboardUriList(
      '# comment\nfile:///tmp/hello%20world.png\nhttps://ignored.example\n',
      'linux',
    );
    expect(posixDecoded).toEqual(['/tmp/hello world.png']);

    const winDecoded = decodeClipboardUriList('file:///C:/Users/demo/hello%20world.png\n', 'win32');
    expect(winDecoded).toEqual(['C:\\Users\\demo\\hello world.png']);
  });
});

describe('save sink, notifications, prefs, updates, IPC Zod validation, and Electron Fuses', () => {
  it('streams chunks through save sink, enforces 64 KiB cap, and reads tokenized selections only', async () => {
    const dir = makeTempDir();
    const targetPath = join(dir, 'saved.txt');
    const sourceImage = join(dir, 'pic.png');
    writeFileSync(sourceImage, Buffer.from([137, 80, 78, 71]));

    const service = new FileAndClipboardService({
      tempSaveDir: join(dir, 'tmp'),
      showSaveDialog: async () => targetPath,
      showOpenDialog: async () => [sourceImage],
      readOsClipboardFilePaths: () => [sourceImage],
      revealInFileManager: () => undefined,
      openWithDefaultApp: async () => undefined,
      openExternal: async () => undefined,
    });

    const sink = await service.openSaveSink('saved.txt');
    expect(sink).not.toBeNull();
    await service.writeSaveSink(sink!.sinkId, new TextEncoder().encode('hello '));
    await service.writeSaveSink(sink!.sinkId, new TextEncoder().encode('world'));
    await expect(service.writeSaveSink(sink!.sinkId, new Uint8Array(64 * 1024 + 1))).rejects.toThrow(/64 KiB/);
    expect(await service.closeSaveSink(sink!.sinkId)).toBe(true);
    expect(readFileSync(targetPath, 'utf8')).toBe('hello world');

    const picked = await service.pickFiles();
    expect(picked).toHaveLength(1);
    const bytes = await service.readSelectedFile(picked![0]!.token);
    expect([...bytes]).toEqual([137, 80, 78, 71]);
    await expect(service.readSelectedFile('unknown-token')).rejects.toThrow(/Unknown or expired/);
  });

  it('routes notification clicks, honors conditional ack, and aggregates per-scope unread badges', async () => {
    const handles: Array<EventEmitter & NativeNotificationHandle & { closed: boolean }> = [];
    const badgeTotals: number[] = [];

    const service = new NotificationService({
      isSupported: () => true,
      createNotification: () => {
        const emitter = new EventEmitter();
        const handle = Object.assign(emitter, {
          closed: false,
          show: () => undefined,
          close: () => {
            handle.closed = true;
          },
        });
        handles.push(handle);
        return handle;
      },
      onActivateWindow: () => undefined,
      setOsBadgeCount: (total) => badgeTotals.push(total),
    });

    await service.send({
      title: 'Turn done',
      route: '/s/abc',
      scope: { homeId: 'main', scopeId: 'local' },
      sessionIds: ['abc'],
      deliveryId: 'del-1',
    });

    handles[0]?.emit('click');
    expect(service.ackNavigationIntent('wrong')).toBe(false);
    const intent = service.takeNavigationIntent();
    expect(intent).toMatchObject({ route: '/s/abc', homeId: 'main' });

    await service.send({
      title: 'Second',
      scope: { homeId: 'main', scopeId: 'local' },
      sessionIds: ['abc'],
      deliveryId: 'del-2',
    });
    service.acknowledge('abc', { homeId: 'main', scopeId: 'local' }, 'del-2');
    expect(handles[1]?.closed).toBe(true);

    expect(service.setUnreadBadge(2, 'main', 'local')).toBe(2);
    expect(service.setUnreadBadge(3, 'work', 'local')).toBe(5);
    expect(service.setUnreadBadge(0, 'main', 'local')).toBe(3);
    expect(badgeTotals).toEqual([2, 5, 3]);
  });

  it('persists desktop.json atomically, guards isolated-space OAuth, enforces monotonic updateState, and validates updater install selection', async () => {
    const root = makeTempDir();
    const mainHome = join(root, 'main');
    const childHome = join(root, 'child');
    let nowMs = 1_000;
    let checkCalls = 0;
    let loginOpenAtLogin = false;

    const service = new PrefsAndUpdateService({
      mainHome,
      getActiveHome: () => mainHome,
      resolveLaunchExecutable: () => 'C:/Kiki/active/kiki-desktop.exe',
      platform: 'win32',
      now: () => nowMs,
      loginItemController: {
        getLoginItemSettings: () => ({ openAtLogin: loginOpenAtLogin }),
        setLoginItemSettings: ({ openAtLogin }) => {
          loginOpenAtLogin = openAtLogin;
        },
      },
      distribution: 'github',
      updaterAdapter: {
        checkForUpdate: async () => {
          checkCalls += 1;
          return { currentVersion: '0.7.0', version: '0.7.1' };
        },
        downloadAndInstall: async () => undefined,
      },
      confirmShutdownForUpdate: async () => false,
    });

    await service.writePrefs({ closeToTray: false, windowMode: 'windows' });
    const loaded = await service.readPrefs();
    expect(loaded.closeToTray).toBe(false);
    expect(loaded.windowMode).toBe('windows');

    // Monotonic update state mutations
    await service.mutateUpdateState({ kind: 'checked', at: 5000 });
    const afterRegress = await service.mutateUpdateState({ kind: 'checked', at: 2000 });
    expect(afterRegress.lastCheckedAt).toBe(5000);
    const afterSkip = await service.mutateUpdateState({ kind: 'skip', channel: 'beta', version: '0.7.2-beta.1' });
    expect(afterSkip.skipped?.beta).toEqual(['0.7.2-beta.1']);

    // Isolated space refuses non-kiki OAuth home
    await service.writePrefs({ notifications: true }, childHome);
    writeFileSync(
      join(childHome, 'home.toml'),
      `id = "child"\nname = "Child"\nbase_home = ${JSON.stringify(mainHome)}\ncredentials_shared = false\n`,
    );
    await expect(
      service.writePrefs({ compatibility: { homeKind: 'custom', customHome: '/tmp/other' } }, childHome),
    ).rejects.toThrow(/Isolated spaces must use their own OAuth home/);

    // Autostart uses Electron loginItemController
    expect(service.setAutostart(true).enabled).toBe(true);
    expect(service.getAutostart().command).toBe('"C:/Kiki/active/kiki-desktop.exe" --autostart');

    // 30s update check caching + stale selection + cancel confirmation
    expect((await service.checkUpdate('stable'))?.version).toBe('0.7.1');
    expect((await service.checkUpdate('stable'))?.version).toBe('0.7.1');
    expect(checkCalls).toBe(1);
    nowMs += 31_000;
    expect((await service.checkUpdate('stable'))?.version).toBe('0.7.1');
    expect(checkCalls).toBe(2);

    await expect(service.installUpdate('stable', '0.7.9')).rejects.toThrow(
      /Desktop update selection changed; check for updates again/,
    );
    await expect(service.installUpdate('stable', '0.7.1')).rejects.toThrow(
      /Update cancelled; running sessions continue/,
    );
  });

  it('validates every IPC handler payload with Zod before executing service methods', async () => {
    const dir = makeTempDir();
    const daemon = new DaemonSupervisor({
      electronBinary: '/opt/kiki/kiki-desktop',
      serverEntry: '/opt/kiki/server-entry.mjs',
      homeDir: dir,
    });
    const windows = new WindowService({
      windowMode: { presetId: 'kiki', windowId: 'w-1' },
      spaceWindowMode: 'switch',
      startWindowless: false,
      getCloseToTray: () => true,
      isTrayActive: () => false,
      createBrowserWindow: async () => {
        throw new Error('not called');
      },
      getDaemonOrigin: () => null,
      ensureDaemonOrigin: async () => 'http://127.0.0.1:41234',
      detachDesktop: () => undefined,
      releaseAppQuit: () => undefined,
      resolveLaunchExecutable: () => '/opt/kiki/kiki-desktop',
    });
    const notifications = new NotificationService({
      isSupported: () => false,
      createNotification: () => {
        throw new Error('not called');
      },
      onActivateWindow: () => undefined,
    });
    const files = new FileAndClipboardService({
      tempSaveDir: join(dir, 'tmp'),
      showSaveDialog: async () => null,
      showOpenDialog: async () => null,
      readOsClipboardFilePaths: () => null,
      revealInFileManager: () => undefined,
      openWithDefaultApp: async () => undefined,
      openExternal: async () => undefined,
    });
    const prefsAndUpdates = new PrefsAndUpdateService({
      mainHome: dir,
      getActiveHome: () => dir,
      resolveLaunchExecutable: () => '/opt/kiki/kiki-desktop',
    });
    const handlers = createIpcHandlers({
      daemon,
      windows,
      notifications,
      files,
      prefsAndUpdates,
      subscribeQueue: new SubscribeIntentQueue(),
      spaces: new SpaceCatalog(dir, dir),
      spaceWindowMode: 'switch',
      openLogDirectory: async () => undefined,
    });

    expect(handlers[IPC_CHANNELS.windowGetMode](undefined)).toEqual({ presetId: 'kiki', windowId: 'w-1' });
    expect(() => handlers[IPC_CHANNELS.windowSetZoom]({ factor: 99 })).toThrow(/Invalid IPC payload/);
    await expect(
      handlers[IPC_CHANNELS.pluginFocusAck]({ homeId: 'main', requestId: 'not-a-number' }),
    ).rejects.toThrow(/Invalid IPC payload/);
    await expect(
      handlers[IPC_CHANNELS.filesWriteSaveSink]({ sinkId: 's1', chunk: new Uint8Array(64 * 1024 + 1) }),
    ).rejects.toThrow(/64 KiB/);
    await expect(
      handlers[IPC_CHANNELS.desktopWritePrefs]({ prefs: { unknownKey: true } }),
    ).rejects.toThrow(/Invalid IPC payload/);
  });

  it('verifies Electron Fuses policy (RunAsNode=ENABLE, GrantFileProtocolExtraPrivileges=DISABLE)', () => {
    expect(
      verifyFuseConfig({
        [FuseV1Options.RunAsNode]: FuseState.ENABLE,
        [FuseV1Options.GrantFileProtocolExtraPrivileges]: FuseState.DISABLE,
        [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
      }, { packaged: true }),
    ).toEqual({ ok: true, failures: [] });

    const broken = verifyFuseConfig({
      [FuseV1Options.RunAsNode]: FuseState.DISABLE,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: FuseState.ENABLE,
    });
    expect(broken.ok).toBe(false);
    expect(broken.failures).toHaveLength(2);
  });
});
