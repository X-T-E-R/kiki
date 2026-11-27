import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';
import { FuseState, FuseV1Options } from '@electron/fuses';
import {
  createKikiAppProtocolHandler,
  KIKI_APP_CSP,
  resolveKikiAppAssetPath,
} from '#/main/appProtocol';
import { parseWindowsCfHdropBuffer } from '#/main/clipboardDropFiles';
import { DaemonSupervisor } from '#/main/daemonSupervisor';
import {
  decodeClipboardUriList,
  FileAndClipboardService,
  validateExternalUrl,
  validateHostPath,
} from '#/main/fileAndClipboardService';
import { NotificationService, type NativeNotificationHandle } from '#/main/notificationService';
import {
  createElectronUpdaterAdapter,
  normalizeHttpsUpdaterFeedBaseUrl,
  PrefsAndUpdateService,
  readDesktopBuildReceiptUpdaterMeta,
  readDesktopSpaceToml,
  resolveCustomUpdaterFeedUrl,
  resolveDesktopOauthHome,
  resolveDesktopUpdaterConfig,
  type AutoUpdaterDriver,
} from '#/main/prefsAndUpdateService';
import { createIpcHandlers } from '#/main/registerIpc';
import { SpaceCatalog } from '#/main/spaceCatalog';
import { combineSpaceAttentionTotal, OVERLAY_SIZE, renderPendingBadgeRgba } from '#/main/spaceBadge';
import { parseSubscribeIntent, SubscribeIntentQueue } from '#/main/subscribeIntent';
import { WindowService } from '#/main/windowService';
import { rescueWindowBounds } from '#/main/windowState';
import { IPC_CHANNELS, IPC_EVENTS } from '#/shared/ipcChannels';
import { verifyFuseConfig } from '../scripts/verify-fuses.mjs';
import { writeElectronBuildReceipt } from '../scripts/write-build-receipt.mjs';
import { assertWebBundleIntegrity, stageWebBundle } from '../../kiki-gui/scripts/web-bundle-integrity.mjs';

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

  it('serves kiki-app://localhost static files with SPA fallback, Range, CSP, .woff2, and symlink/traversal guards', async () => {
    const webDir = makeTempDir();
    const outsideDir = makeTempDir();
    writeFileSync(join(outsideDir, 'secret.txt'), 'TOP_SECRET');
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Kiki</title>');
    const assetsDir = join(webDir, 'assets');
    writeFileSync(join(webDir, 'favicon.svg'), '<svg/>');
    await import('node:fs/promises').then((fs) => fs.mkdir(assetsDir, { recursive: true }));
    writeFileSync(join(assetsDir, 'app.js'), 'console.log(1);');
    writeFileSync(join(assetsDir, 'font.woff2'), 'WOFF2DATA0123456789');

    expect(await resolveKikiAppAssetPath(webDir, 'kiki-app://localhost/assets/app.js')).toMatchObject({
      status: 200,
      filePath: join(assetsDir, 'app.js'),
    });
    expect(await resolveKikiAppAssetPath(webDir, 'kiki-app://localhost/s/session-123?panel=config')).toMatchObject({
      status: 200,
      filePath: join(webDir, 'index.html'),
    });
    // Query params containing ../ must NOT trigger pathname traversal 403
    expect(await resolveKikiAppAssetPath(webDir, 'kiki-app://localhost/s/123?path=../foo')).toMatchObject({
      status: 200,
      filePath: join(webDir, 'index.html'),
    });
    // Dotted SPA routes fall back to index.html while missing static assets stay 404
    expect(await resolveKikiAppAssetPath(webDir, 'kiki-app://localhost/s/v0.7.0')).toMatchObject({
      status: 200,
      filePath: join(webDir, 'index.html'),
    });
    expect(await resolveKikiAppAssetPath(webDir, 'kiki-app://localhost/assets/missing.js')).toEqual({
      status: 404,
    });
    expect(await resolveKikiAppAssetPath(webDir, 'kiki-app://localhost/missing.woff2')).toEqual({
      status: 404,
    });
    expect(await resolveKikiAppAssetPath(webDir, 'kiki-app://localhost/%2e%2e/secret.txt')).toEqual({
      status: 403,
    });

    // Symlink/junction escaping webRootDir is blocked by realpath containment
    const fsPromises = await import('node:fs/promises');
    const escapedLink = join(webDir, 'escaped-dir');
    await fsPromises
      .symlink(outsideDir, escapedLink, process.platform === 'win32' ? 'junction' : 'dir')
      .catch(() => undefined);
    if (await fsPromises.stat(escapedLink).then(() => true, () => false)) {
      expect(await resolveKikiAppAssetPath(webDir, 'kiki-app://localhost/escaped-dir/secret.txt')).toEqual({
        status: 403,
      });
    }

    const handler = createKikiAppProtocolHandler(webDir, async (fileUrl) => {
      const { fileURLToPath } = await import('node:url');
      const body = await fsPromises.readFile(fileURLToPath(fileUrl));
      return new Response(body, { status: 200 });
    });

    const spaRes = await handler(new Request('kiki-app://localhost/s/v0.7.0?path=../foo'));
    expect(spaRes.status).toBe(200);
    expect(spaRes.headers.get('Content-Security-Policy')).toBe(KIKI_APP_CSP);

    const woffRes = await handler(new Request('kiki-app://localhost/assets/font.woff2'));
    expect(woffRes.status).toBe(200);
    expect(woffRes.headers.get('Content-Type')).toBe('font/woff2');

    const rangeRes = await handler(
      new Request('kiki-app://localhost/assets/font.woff2', {
        headers: { Range: 'bytes=0-3' },
      }),
    );
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get('Content-Range')).toBe('bytes 0-3/19');
    expect(await rangeRes.text()).toBe('WOFF');

    const badRangeRes = await handler(
      new Request('kiki-app://localhost/assets/font.woff2', {
        headers: { Range: 'bytes=999-1000' },
      }),
    );
    expect(badRangeRes.status).toBe(416);
    expect(badRangeRes.headers.get('Content-Range')).toBe('bytes */19');
  });

  it('parses multi-file Unicode Windows CF_HDROP buffers and classifies audio/video/image via pastedMediaType', async () => {
    const dir = makeTempDir();
    const audioFile = join(dir, 'voice 世界.mp3');
    const docFile = join(dir, 'notes.pdf');
    writeFileSync(audioFile, Buffer.from([1, 2, 3]));
    writeFileSync(docFile, Buffer.from([4, 5]));

    const header = Buffer.alloc(20);
    header.writeUInt32LE(20, 0);
    header.writeInt32LE(1, 16);
    const widePayload = Buffer.from(`${audioFile}\0${docFile}\0\0`, 'utf16le');
    const cfHdrop = new Uint8Array(Buffer.concat([header, widePayload]));

    const parsedPaths = parseWindowsCfHdropBuffer(cfHdrop);
    expect(parsedPaths).toEqual([audioFile, docFile]);

    // Narrow ANSI (fWide=0) GBK/GB18030 CJK path fallback
    const narrowHeader = Buffer.alloc(20);
    narrowHeader.writeUInt32LE(20, 0);
    narrowHeader.writeInt32LE(0, 16);
    // "C:\测试\a.txt" in GBK: 43 3a 5c b2 e2 ca d4 5c 61 2e 74 78 74
    const gbkBytes = Buffer.from([
      0x43, 0x3a, 0x5c, 0xb2, 0xe2, 0xca, 0xd4, 0x5c, 0x61, 0x2e, 0x74, 0x78, 0x74, 0x00, 0x00,
    ]);
    expect(parseWindowsCfHdropBuffer(new Uint8Array(Buffer.concat([narrowHeader, gbkBytes])))).toEqual([
      'C:\\测试\\a.txt',
    ]);

    const service = new FileAndClipboardService({
      platform: 'win32',
      tempSaveDir: join(dir, 'tmp'),
      showSaveDialog: async () => join(dir, 'blob-out.bin'),
      showOpenDialog: async () => null,
      readOsClipboardFilePaths: () => parsedPaths,
      revealInFileManager: () => undefined,
      openWithDefaultApp: async () => undefined,
      openExternal: async () => undefined,
    });
    const classified = await service.readClipboardFiles();
    expect(classified?.paths).toEqual([docFile]);
    expect(classified?.files).toHaveLength(1);
    expect(classified?.files[0]?.type).toBe('audio/mpeg');
    expect(await service.saveBlob(new Uint8Array([9, 8, 7]), 'blob-out.bin')).toBe(true);
    expect([...readFileSync(join(dir, 'blob-out.bin'))]).toEqual([9, 8, 7]);
  });

  it('renders 32x32 RGBA taskbar badges, unions attention session IDs, and rescues off-screen window bounds', () => {
    expect(renderPendingBadgeRgba(0)).toBeNull();
    const badge = renderPendingBadgeRgba(12)!;
    expect(badge.byteLength).toBe(OVERLAY_SIZE * OVERLAY_SIZE * 4);
    expect([...badge.subarray((3 * OVERLAY_SIZE + 19) * 4, (3 * OVERLAY_SIZE + 19) * 4 + 4)]).toEqual([
      255, 255, 255, 255,
    ]);
    expect(
      combineSpaceAttentionTotal({
        scopeUnreadTotal: 2,
        scopeSessionIds: new Set(['s1', 's2']),
        statuses: [
          { homeId: 'main', active: true, hot: true, pendingCount: 5, busyCount: 0, needsYouSessionIds: ['s1'] },
          { homeId: 'work', active: false, hot: true, pendingCount: 2, busyCount: 1, needsYouSessionIds: ['s2', 's3'] },
        ],
      }),
    ).toBe(3);

    const rescued = rescueWindowBounds(
      { x: -9000, y: -9000, width: 1200, height: 800, isMaximized: false, isFullScreen: false },
      [{ x: 0, y: 0, width: 1920, height: 1040 }],
      { width: 1440, height: 920 },
    );
    expect(rescued.x).toBe(360);
    expect(rescued.y).toBe(120);
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

    // Child space inherits mainPrefs keys unless explicitly overridden in child desktop.json
    await service.writePrefs({
      notifications: false,
      closeToTray: false,
      locale: 'zh',
      logLevel: 'info',
    });
    await service.writePrefs({ logLevel: 'debug' }, childHome);
    const inheritedChildPrefs = await service.readPrefs(childHome);
    expect(inheritedChildPrefs).toMatchObject({
      notifications: false,
      closeToTray: false,
      locale: 'zh',
      logLevel: 'debug',
      windowMode: 'windows',
    });

    // Canonical [inherit] credentials = "isolated" home.toml forces isolated space OAuth home
    writeFileSync(
      join(childHome, 'home.toml'),
      `schema = 1\nid = "h-child"\nname = "Child"\nbase = ${JSON.stringify(mainHome)}\n\n[inherit]\ncredentials = "isolated"\n`,
    );
    const parsedIsolated = await readDesktopSpaceToml(childHome);
    expect(parsedIsolated?.credentialsShared).toBe(false);
    const isolatedPrefs = await service.readPrefs(childHome);
    expect(isolatedPrefs.compatibility).toEqual({ homeKind: 'kiki' });
    expect(
      await resolveDesktopOauthHome({
        homeDir: childHome,
        prefs: isolatedPrefs,
        kimiHome: '/home/user/.kimi',
        space: parsedIsolated,
      }),
    ).toBe(childHome);
    await expect(
      service.writePrefs({ compatibility: { homeKind: 'custom', customHome: '/tmp/other' } }, childHome),
    ).rejects.toThrow(/Isolated spaces must use their own OAuth home/);

    // Shared child space honors compatibility homeKind ('kimi' vs 'custom')
    const sharedChildHome = join(root, 'shared-child');
    await import('node:fs/promises').then((fs) => fs.mkdir(sharedChildHome, { recursive: true }));
    writeFileSync(
      join(sharedChildHome, 'home.toml'),
      `schema = 1\nid = "h-shared"\nname = "Shared"\nbase = ${JSON.stringify(mainHome)}\n\n[inherit]\ncredentials = "shared"\n`,
    );
    const parsedShared = await readDesktopSpaceToml(sharedChildHome);
    expect(parsedShared?.credentialsShared).toBe(true);
    expect(
      await resolveDesktopOauthHome({
        homeDir: sharedChildHome,
        prefs: { ...(await service.readPrefs(sharedChildHome)), compatibility: { homeKind: 'kimi' } },
        kimiHome: '/home/user/.kimi',
        space: parsedShared,
      }),
    ).toBe('/home/user/.kimi');
    expect(
      await resolveDesktopOauthHome({
        homeDir: sharedChildHome,
        prefs: {
          ...(await service.readPrefs(sharedChildHome)),
          compatibility: { homeKind: 'custom', customHome: join(root, 'custom-oauth') },
        },
        kimiHome: '/home/user/.kimi',
        space: parsedShared,
      }),
    ).toBe(join(root, 'custom-oauth'));

    // Autostart uses Electron loginItemController (and Windows registry when configured)
    expect(service.setAutostart(true).enabled).toBe(true);
    expect(service.getAutostart().command).toBe('"C:/Kiki/active/kiki-desktop.exe" --autostart');

    const desktopDir = join(root, 'Desktop');
    await import('node:fs/promises').then((fs) => fs.mkdir(desktopDir, { recursive: true }));
    const shortcutSvc = new PrefsAndUpdateService({
      mainHome,
      getActiveHome: () => mainHome,
      resolveLaunchExecutable: () => 'C:\\Kiki\\active\\kiki-desktop.exe',
      platform: 'win32',
      desktopDir,
      shortcutWriter: {
        writeShortcutLink: (shortcutPath) => {
          writeFileSync(shortcutPath, 'lnk');
          return true;
        },
      },
    });
    const createdShortcut = shortcutSvc.createSpaceShortcut('work', 'C:\\Spaces\\Work', 'Work:Space');
    expect(createdShortcut).toEqual({
      ok: true,
      homeId: 'work',
      path: join(desktopDir, 'Kiki - Work_Space (work).lnk'),
    });
    expect(shortcutSvc.createSpaceShortcut('work', 'C:\\Spaces\\Work', 'Work:Space')).toMatchObject({
      ok: false,
      code: 'shortcut_exists',
    });

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

    // Verified quitAndInstall bypass: markInstallingUpdate(true) fires BEFORE downloadAndInstall
    // so before-quit lets autoUpdater.quitAndInstall() exit cleanly without preventDefault().
    const events: string[] = [];
    let installingFlag = false;
    let quitPrevented = false;
    const installSvc = new PrefsAndUpdateService({
      mainHome,
      getActiveHome: () => mainHome,
      resolveLaunchExecutable: () => 'C:/Kiki/active/kiki-desktop.exe',
      distribution: 'github',
      confirmShutdownForUpdate: async () => {
        events.push('confirm');
        return true;
      },
      prepareDaemonForUpdate: async () => {
        events.push('prepare-daemon');
      },
      markInstallingUpdate: (flag) => {
        installingFlag = flag;
        events.push(`installing:${String(flag)}`);
      },
      releaseUpdateLocks: () => {
        events.push('release-locks');
      },
      updaterAdapter: {
        checkForUpdate: async () => ({ currentVersion: '0.7.0', version: '0.7.1' }),
        downloadAndInstall: async () => {
          events.push('download-and-quitAndInstall');
          // Simulate Electron before-quit firing inside autoUpdater.quitAndInstall()
          if (!installingFlag) {
            quitPrevented = true;
          }
        },
      },
    });
    await installSvc.installUpdate('stable', '0.7.1');
    expect(quitPrevented).toBe(false);
    expect(installingFlag).toBe(true);
    expect(events).toEqual([
      'confirm',
      'prepare-daemon',
      'installing:true',
      'release-locks',
      'download-and-quitAndInstall',
      'release-locks',
    ]);
  });

  it('validates every IPC handler payload with Zod before executing service methods', async () => {
    const dir = makeTempDir();
    const daemon = new DaemonSupervisor({
      electronBinary: '/opt/kiki/kiki-desktop',
      serverEntry: '/opt/kiki/server-entry.mjs',
      homeDir: dir,
    });
    const appliedThemes: Array<'light' | 'dark' | 'system'> = [];
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
      setNativeTheme: (theme) => {
        appliedThemes.push(theme);
      },
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
    handlers[IPC_CHANNELS.windowSetTheme]({ theme: 'system' });
    expect(appliedThemes).toEqual(['system']);
    expect(() => handlers[IPC_CHANNELS.windowSetTheme]({ theme: 'sepia' })).toThrow(/Invalid IPC payload/);
    expect(IPC_EVENTS.windowFocus).toBe('kiki:event:windowFocus');
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

  it('supports domain-neutral custom updater feed in desktop-build-receipt.json and routes electronUpdaterAdapter to ${updaterFeedBaseUrl}/${channel}', async () => {
    const candidateDir = makeTempDir();
    const unpackedServerDir = join(
      candidateDir,
      'resources',
      'app.asar.unpacked',
      'dist',
      'server',
    );
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(join(unpackedServerDir, 'web', 'assets'), { recursive: true }),
    );
    writeFileSync(join(candidateDir, 'kiki-desktop.exe'), 'electron-bin');
    writeFileSync(join(candidateDir, 'resources', 'app.asar'), 'asar-payload');
    writeFileSync(join(unpackedServerDir, 'server-entry.mjs'), 'export {};\n');
    writeFileSync(join(unpackedServerDir, 'native-addons.json'), '{"version":1}\n');
    writeFileSync(
      join(unpackedServerDir, 'web', 'index.html'),
      '<!doctype html><html><head><link rel="stylesheet" href="/assets/index-test.css"><script type="module" src="/assets/index-test.js"></script></head><body></body></html>\n',
    );
    writeFileSync(join(unpackedServerDir, 'web', 'assets', 'index-test.css'), 'body{}\n');
    writeFileSync(join(unpackedServerDir, 'web', 'assets', 'index-test.js'), 'export {};\n');

    const commit = 'a'.repeat(40);
    await expect(
      writeElectronBuildReceipt({
        candidateDir,
        sourceCommit: commit,
        distribution: 'custom',
      }),
    ).rejects.toThrow(/valid https:\/\/ KIKI_UPDATER_FEED_BASE_URL/);
    await expect(
      writeElectronBuildReceipt({
        candidateDir,
        sourceCommit: commit,
        distribution: 'custom',
        updaterFeedBaseUrl: 'http://example.com/updater',
      }),
    ).rejects.toThrow(/valid https:\/\/ KIKI_UPDATER_FEED_BASE_URL/);

    const written = await writeElectronBuildReceipt({
      candidateDir,
      sourceCommit: commit,
      distribution: 'custom',
      updaterFeedBaseUrl: 'https://example.com/updater/',
    });
    expect(written.receipt.distribution).toBe('custom');
    expect(written.receipt.updaterFeedBaseUrl).toBe('https://example.com/updater');

    expect(normalizeHttpsUpdaterFeedBaseUrl('https://example.com/updater///')).toBe(
      'https://example.com/updater',
    );
    expect(normalizeHttpsUpdaterFeedBaseUrl('http://example.com/updater')).toBeNull();
    expect(normalizeHttpsUpdaterFeedBaseUrl('https://user:pass@example.com/updater')).toBeNull();
    expect(normalizeHttpsUpdaterFeedBaseUrl('https://example.com/updater?foo=1')).toBeNull();
    expect(resolveCustomUpdaterFeedUrl('https://example.com/updater/', 'stable')).toBe(
      'https://example.com/updater/stable',
    );
    expect(resolveCustomUpdaterFeedUrl('https://example.com/updater/', 'beta')).toBe(
      'https://example.com/updater/beta',
    );

    const parsedMeta = readDesktopBuildReceiptUpdaterMeta([written.receiptPath]);
    expect(parsedMeta).toEqual({
      distribution: 'custom',
      updaterFeedBaseUrl: 'https://example.com/updater',
    });

    const resolvedConfig = resolveDesktopUpdaterConfig({
      isPackaged: true,
      receipt: parsedMeta,
    });
    expect(resolvedConfig).toEqual({
      distribution: 'custom',
      updaterFeedBaseUrl: 'https://example.com/updater',
    });

    const feedCalls: Array<{ readonly provider: 'generic'; readonly url: string }> = [];
    let quitAndInstallCalled = false;
    const fakeAutoUpdater: AutoUpdaterDriver = {
      autoDownload: true,
      allowPrerelease: false,
      channel: null,
      setFeedURL: (opts) => {
        feedCalls.push(opts);
      },
      checkForUpdates: async () => ({
        updateInfo: {
          version: '0.7.1',
          releaseDate: '2026-11-26T00:00:00.000Z',
          releaseNotes: 'Domain-neutral custom feed release',
        },
      }),
      downloadUpdate: async () => [],
      quitAndInstall: () => {
        quitAndInstallCalled = true;
      },
    };

    const adapter = createElectronUpdaterAdapter({
      autoUpdater: fakeAutoUpdater,
      getCurrentVersion: () => '0.7.0',
      distribution: resolvedConfig.distribution,
      updaterFeedBaseUrl: resolvedConfig.updaterFeedBaseUrl,
    });

    const homeDir = makeTempDir();
    const customSvc = new PrefsAndUpdateService({
      mainHome: homeDir,
      getActiveHome: () => homeDir,
      resolveLaunchExecutable: () => 'C:/Kiki/kiki-desktop.exe',
      distribution: resolvedConfig.distribution,
      updaterFeedBaseUrl: resolvedConfig.updaterFeedBaseUrl,
      updaterAdapter: adapter,
    });
    expect(customSvc.supportsUpdates()).toBe(true);

    const stableOffer = await customSvc.checkUpdate('stable');
    expect(stableOffer).toMatchObject({ currentVersion: '0.7.0', version: '0.7.1' });
    expect(fakeAutoUpdater.autoDownload).toBe(false);
    expect(fakeAutoUpdater.allowPrerelease).toBe(false);
    expect(fakeAutoUpdater.channel).toBe('latest');

    const betaOffer = await customSvc.checkUpdate('beta');
    expect(betaOffer?.version).toBe('0.7.1');
    expect(fakeAutoUpdater.allowPrerelease).toBe(true);
    expect(fakeAutoUpdater.channel).toBe('beta');

    await customSvc.writePrefs({ updateChannel: 'beta' });
    await customSvc.installUpdate('beta', '0.7.1');
    expect(quitAndInstallCalled).toBe(true);
    expect(feedCalls).toEqual([
      { provider: 'generic', url: 'https://example.com/updater/stable' },
      { provider: 'generic', url: 'https://example.com/updater/beta' },
      { provider: 'generic', url: 'https://example.com/updater/beta' },
      { provider: 'generic', url: 'https://example.com/updater/beta' },
    ]);

    const invalidCustomSvc = new PrefsAndUpdateService({
      mainHome: homeDir,
      getActiveHome: () => homeDir,
      resolveLaunchExecutable: () => 'C:/Kiki/kiki-desktop.exe',
      distribution: 'custom',
      updaterFeedBaseUrl: 'http://example.com/insecure',
      updaterAdapter: adapter,
    });
    expect(invalidCustomSvc.supportsUpdates()).toBe(false);
    await expect(invalidCustomSvc.checkUpdate('stable')).rejects.toThrow(
      /Desktop updater is not available/,
    );
  });

  it('rejects missing or truncated web/assets entrypoints in writeElectronBuildReceipt and stageWebBundle', async () => {
    const candidateDir = makeTempDir();
    const unpackedServerDir = join(
      candidateDir,
      'resources',
      'app.asar.unpacked',
      'dist',
      'server',
    );
    const webAssetsDir = join(unpackedServerDir, 'web', 'assets');
    await import('node:fs/promises').then((fs) => fs.mkdir(webAssetsDir, { recursive: true }));
    writeFileSync(join(candidateDir, 'kiki-desktop.exe'), 'electron-bin');
    writeFileSync(join(candidateDir, 'resources', 'app.asar'), 'asar-payload');
    writeFileSync(join(unpackedServerDir, 'server-entry.mjs'), 'export {};\n');
    writeFileSync(join(unpackedServerDir, 'native-addons.json'), '{"version":1}\n');
    writeFileSync(
      join(unpackedServerDir, 'web', 'index.html'),
      '<!doctype html><html><head><link rel="stylesheet" href="/assets/index-main.css"><link rel="modulepreload" href="/assets/vendor-react-abc.js"><script type="module" src="/assets/index-main.js"></script></head><body></body></html>\n',
    );
    writeFileSync(join(webAssetsDir, 'index-main.css'), 'body { margin: 0; }\n');

    const commit = 'b'.repeat(40);
    await expect(
      writeElectronBuildReceipt({ candidateDir, sourceCommit: commit }),
    ).rejects.toThrow(/missing or empty entrypoint asset\(s\):.*vendor-react-abc\.js.*index-main\.js/);

    writeFileSync(join(webAssetsDir, 'vendor-react-abc.js'), '');
    writeFileSync(join(webAssetsDir, 'index-main.js'), 'console.log("ok");\n');
    await expect(
      writeElectronBuildReceipt({ candidateDir, sourceCommit: commit }),
    ).rejects.toThrow(/vendor-react-abc\.js \(empty\)/);

    writeFileSync(join(webAssetsDir, 'vendor-react-abc.js'), 'export const react = 1;\n');
    const valid = await writeElectronBuildReceipt({ candidateDir, sourceCommit: commit });
    expect(valid.receipt.schemaVersion).toBe(2);

    const sourceDist = makeTempDir();
    const stagedWeb = join(makeTempDir(), 'web');
    await import('node:fs/promises').then((fs) => fs.mkdir(join(sourceDist, 'assets'), { recursive: true }));
    writeFileSync(
      join(sourceDist, 'index.html'),
      '<!doctype html><script type="module" src="/assets/app.js"></script>',
    );
    writeFileSync(join(sourceDist, 'assets', 'app.js'), 'export default 1;\n');
    writeFileSync(join(sourceDist, 'assets', 'chunk-extra.js'), 'export const x = 2;\n');
    await import('node:fs/promises').then((fs) => fs.mkdir(stagedWeb, { recursive: true }));
    writeFileSync(join(stagedWeb, 'stale.js'), 'stale');
    const staged = await stageWebBundle({
      sourceDistDir: sourceDist,
      targetWebDir: stagedWeb,
      minFileCount: 3,
    });
    expect(staged.fileCount).toBe(3);

    rmSync(join(stagedWeb, 'assets', 'chunk-extra.js'));
    await expect(
      assertWebBundleIntegrity(stagedWeb, { sourceDistDir: sourceDist, minFileCount: 2 }),
    ).rejects.toThrow(/Web bundle copy mismatch: source .* has 3 files, staged .* has 2 files/);
  });
});
