import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {
  ConnectionConfig,
  DesktopFailurePayload,
  ElectronBridge,
  SpaceShortcutResult,
} from '#/shared/types';

const testDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(testDir, '../..');

function resolveUnpackedPaths() {
  if (process.platform === 'win32') {
    const dir = join(desktopRoot, 'out', 'win-unpacked');
    return {
      dir,
      exe: join(dir, 'kiki-desktop.exe'),
      serverEntry: join(dir, 'resources', 'app.asar.unpacked', 'dist', 'server', 'server-entry.mjs'),
    };
  }
  const dir = join(desktopRoot, 'out', 'linux-unpacked');
  return {
    dir,
    exe: join(dir, 'kiki-desktop'),
    serverEntry: join(dir, 'resources', 'app.asar.unpacked', 'dist', 'server', 'server-entry.mjs'),
  };
}

function cleanGuiEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.toUpperCase() === 'ELECTRON_RUN_AS_NODE') continue;
    env[k] = v;
  }
  env['NO_PROXY'] = '127.0.0.1,localhost';
  env['no_proxy'] = '127.0.0.1,localhost';
  env['KIKI_SKIP_AUTOSTART_SYNC'] = '1';
  return { ...env, ...overrides };
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await delay(100);
  }
  return !isPidAlive(pid);
}

interface InstanceReceipt {
  readonly pid: number;
  readonly port: number;
  readonly server_id: string;
}

function readInstanceReceipts(homeDir: string): InstanceReceipt[] {
  const instancesDir = join(homeDir, 'server', 'instances');
  if (!existsSync(instancesDir)) return [];
  const receipts: InstanceReceipt[] = [];
  for (const file of readdirSync(instancesDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(instancesDir, file), 'utf8')) as Partial<InstanceReceipt>;
      if (
        typeof parsed.pid === 'number' &&
        parsed.pid > 0 &&
        typeof parsed.port === 'number' &&
        parsed.port > 0 &&
        typeof parsed.server_id === 'string'
      ) {
        receipts.push({ pid: parsed.pid, port: parsed.port, server_id: parsed.server_id });
      }
    } catch {
      continue;
    }
  }
  return receipts;
}

async function waitForLiveConnection(page: Page, timeoutMs = 15_000): Promise<ConnectionConfig> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const discovered = await page
      .evaluate(async () => {
        const bridge = (window as unknown as { __KIKI_ELECTRON__?: ElectronBridge }).__KIKI_ELECTRON__;
        if (!bridge || window.location.origin !== 'kiki-app://localhost') return null;
        return bridge.discoverConnection();
      })
      .catch(() => null);
    if (discovered !== null && 'ok' in discovered && discovered.ok) {
      return discovered.connection.config;
    }
    if (discovered !== null && 'config' in discovered && typeof discovered.config.url === 'string') {
      return discovered.config;
    }
    await delay(80);
  }
  throw new Error(`Timed out waiting for __KIKI_ELECTRON__.discoverConnection() on ${page.url()}`);
}

const cleanupCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanupCallbacks.length > 0) {
    const fn = cleanupCallbacks.pop();
    if (fn) await fn();
  }
});

describe('kiki-desktop real unpacked binary E2E (Layer 2)', () => {
  beforeAll(() => {
    const { exe, serverEntry } = resolveUnpackedPaths();
    if (existsSync(exe) && existsSync(serverEntry)) {
      execFileSync(exe, [serverEntry, '--version'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'ignore',
      });
    }
  });

  it('boots under 5s on kiki-app://localhost, preserves localStorage across daemon restart, enforces security & closeToTray, and manages sibling spaces cleanly', async () => {
    const { exe, serverEntry } = resolveUnpackedPaths();
    expect(existsSync(exe)).toBe(true);
    expect(existsSync(serverEntry)).toBe(true);

    const scratch = mkdtempSync(join(tmpdir(), 'kiki-e2e-main-'));
    const mainHome = join(scratch, 'main-home');
    const siblingHome = join(scratch, 'sibling-work');
    const userDataDir = join(scratch, 'user-data');
    const shortcutDir = join(scratch, 'desktop-shortcuts');
    const cacheDir = join(scratch, 'cache');
    mkdirSync(mainHome, { recursive: true });
    mkdirSync(shortcutDir, { recursive: true });

    let appInstance: ElectronApplication | undefined;
    let siblingProc: ChildProcess | undefined;
    const trackedPids = new Set<number>();

    cleanupCallbacks.push(async () => {
      if (siblingProc && siblingProc.exitCode === null) {
        siblingProc.kill();
      }
      if (appInstance) {
        const proc = appInstance.process();
        await appInstance
          .evaluate(({ app }) => {
            app.quit();
          })
          .catch(() => undefined);
        await Promise.race([appInstance.close().catch(() => undefined), delay(5_000)]);
        if (proc.pid && isPidAlive(proc.pid)) {
          try {
            proc.kill();
          } catch {
            // Exited concurrently.
          }
        }
      }
      for (const pid of trackedPids) {
        if (isPidAlive(pid)) {
          try {
            process.kill(pid);
          } catch {
            // Exited concurrently.
          }
        }
      }
      await delay(300);
      rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    });

    const t0 = performance.now();
    appInstance = await electron.launch({
      executablePath: exe,
      args: ['--no-proxy-server', '--no-release-redirect', '--home', mainHome],
      env: cleanGuiEnv({
        KIKI_HOME: mainHome,
        KIKI_DESKTOP_USER_DATA_DIR: userDataDir,
        KIKI_DESKTOP_SHORTCUT_DIR: shortcutDir,
        KIKI_CACHE_DIR: cacheDir,
      }),
    });
    const mainGuiPid = appInstance.process().pid ?? 0;
    if (mainGuiPid > 0) trackedPids.add(mainGuiPid);

    const page = await appInstance.firstWindow();
    const initialConn = await waitForLiveConnection(page, 15_000);
    const coldBootMs = Math.round(performance.now() - t0);
    console.log(`[Layer 2] Cold packaged launch to live daemon connection (${initialConn.url}): ${coldBootMs}ms`);
    expect(coldBootMs).toBeLessThan(5_000);
    for (const r of readInstanceReceipts(mainHome)) trackedPids.add(r.pid);

    // 1. Verify fixed kiki-app://localhost origin, SPA fallback (including ?path=../foo and dotted /s/v0.7.0), Range 206/416, CSP, .woff2, traversal block, and renderer sandbox.
    const webDir = join(
      dirname(exe),
      'resources',
      'app.asar.unpacked',
      'dist',
      'server',
      'web',
      'assets',
    );
    const woff2Asset = existsSync(webDir)
      ? readdirSync(webDir).find((f) => f.endsWith('.woff2'))
      : undefined;

    const originAndSandbox = await page.evaluate(async (woff2File) => {
      const w = window as unknown as Record<string, unknown>;
      const normalizedTraversal = await fetch('kiki-app://localhost/%2e%2e/package.json')
        .then((r) => r.status)
        .catch(() => -1);
      const backslashTraversal = await fetch('kiki-app://localhost/%5c../package.json')
        .then((r) => r.status)
        .catch(() => -1);
      const queryDotsAllowed = await fetch('kiki-app://localhost/s/123?path=../foo').then(async (r) => ({
        status: r.status,
        hasRoot: (await r.text()).includes('id="root"'),
      }));
      const dottedSpaFallback = await fetch('kiki-app://localhost/s/v0.7.0').then(async (r) => ({
        status: r.status,
        csp: r.headers.get('content-security-policy') ?? '',
        hasRoot: (await r.text()).includes('id="root"'),
      }));
      const rangeOk = await fetch('kiki-app://localhost/index.html', {
        headers: { Range: 'bytes=0-3' },
      }).then(async (r) => ({
        status: r.status,
        contentRange: r.headers.get('content-range') ?? '',
        slice: await r.text(),
      }));
      const rangeBad = await fetch('kiki-app://localhost/index.html', {
        headers: { Range: 'bytes=9999999-99999999' },
      }).then((r) => r.status);
      const woff2Mime = woff2File
        ? await fetch(`kiki-app://localhost/assets/${woff2File}`).then(
            (r) => `${r.status}:${r.headers.get('content-type') ?? ''}`,
          )
        : 'skipped';
      return {
        origin: window.location.origin,
        hasProcess: typeof w['process'] !== 'undefined',
        hasRequire: typeof w['require'] !== 'undefined',
        normalizedTraversal,
        backslashTraversal,
        queryDotsAllowed,
        dottedSpaFallback,
        rangeOk,
        rangeBad,
        woff2Mime,
      };
    }, woff2Asset ?? null);
    expect(originAndSandbox.origin).toBe('kiki-app://localhost');
    expect(originAndSandbox.hasProcess).toBe(false);
    expect(originAndSandbox.hasRequire).toBe(false);
    expect(originAndSandbox.normalizedTraversal).toBe(404);
    expect(originAndSandbox.backslashTraversal).toBe(403);
    expect(originAndSandbox.queryDotsAllowed).toEqual({ status: 200, hasRoot: true });
    expect(originAndSandbox.dottedSpaFallback.status).toBe(200);
    expect(originAndSandbox.dottedSpaFallback.hasRoot).toBe(true);
    expect(originAndSandbox.dottedSpaFallback.csp).toContain("default-src 'self' kiki-app:");
    expect(originAndSandbox.rangeOk.status).toBe(206);
    expect(originAndSandbox.rangeOk.contentRange).toMatch(/^bytes 0-3\/\d+$/);
    expect(originAndSandbox.rangeOk.slice.toLowerCase()).toBe('<!do');
    expect(originAndSandbox.rangeBad).toBe(416);
    if (woff2Asset !== undefined) {
      expect(originAndSandbox.woff2Mime).toBe('200:font/woff2');
    }

    // 2. Verify localStorage survives daemon port rotation via desktop.restartServer().
    const activeSpaceSummary = await page.evaluate(async () => {
      window.localStorage.setItem('kiki-070-origin-test', 'persisted-value-42');
      const bridge = (window as unknown as { __KIKI_ELECTRON__: ElectronBridge }).__KIKI_ELECTRON__;
      return (await bridge.desktop.activeSpace()) as { homeId: string; isPrimary: boolean };
    });
    expect(activeSpaceSummary.isPrimary).toBe(true);

    await page.evaluate(async () => {
      const bridge = (window as unknown as { __KIKI_ELECTRON__: ElectronBridge }).__KIKI_ELECTRON__;
      await bridge.desktop.restartServer();
    });
    const nextConn = await waitForLiveConnection(page, 20_000);
    const afterRestart = await page.evaluate(() => ({
      origin: window.location.origin,
      stored: window.localStorage.getItem('kiki-070-origin-test'),
    }));
    expect(afterRestart.origin).toBe('kiki-app://localhost');
    expect(afterRestart.stored).toBe('persisted-value-42');
    expect(nextConn.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const healthAfterRestart = await fetch(`${nextConn.url}/api/healthz`);
    expect(healthAfterRestart.status).toBe(200);
    for (const r of readInstanceReceipts(mainHome)) trackedPids.add(r.pid);

    // 3. Verify dangerous executable block in files.openPath and external navigation block.
    const exeBlocked = await page.evaluate(async () => {
      const bridge = (window as unknown as { __KIKI_ELECTRON__: ElectronBridge }).__KIKI_ELECTRON__;
      try {
        await bridge.files.openPath('C:\\Windows\\System32\\calc.exe');
        return 'allowed';
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    });
    expect(exeBlocked).toMatch(/executable|refus|block|forbidden/i);

    await page.evaluate(() => {
      window.location.href = 'https://example.com/phishing-attempt';
    });
    await delay(250);
    expect(page.url().startsWith('kiki-app://localhost')).toBe(true);

    // 4. Verify live closeToTray toggle via desktop.writePrefs hides instead of quitting, and persists window-state.json.
    await page.evaluate(async () => {
      const bridge = (window as unknown as { __KIKI_ELECTRON__: ElectronBridge }).__KIKI_ELECTRON__;
      await bridge.desktop.writePrefs({ closeToTray: true });
    });
    const prefsOnDisk = JSON.parse(readFileSync(join(mainHome, 'desktop.json'), 'utf8')) as { closeToTray?: boolean };
    expect(prefsOnDisk.closeToTray).toBe(true);

    const hiddenInsteadOfDestroyed = await appInstance.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('Missing main BrowserWindow');
      win.setBounds({ x: 140, y: 120, width: 1260, height: 820 });
      win.close();
      return {
        destroyed: win.isDestroyed(),
        visible: win.isVisible(),
      };
    });
    expect(hiddenInsteadOfDestroyed).toEqual({ destroyed: false, visible: false });

    await delay(400);
    const savedWinStatePath = join(userDataDir, 'window-state.json');
    expect(existsSync(savedWinStatePath)).toBe(true);
    const savedWinState = JSON.parse(readFileSync(savedWinStatePath, 'utf8')) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    expect(savedWinState.width).toBe(1260);
    expect(savedWinState.height).toBe(820);
    await appInstance.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.show();
    });

    // 5. Multi-space: register isolated sibling space (`[inherit] credentials = "isolated"`), start sibling server, verify per-home server.local-owner & isolated restartSpace.
    mkdirSync(siblingHome, { recursive: true });
    writeFileSync(
      join(siblingHome, 'home.toml'),
      `schema = 1\nid = "h-work"\nname = "Work Space"\nbase = ${JSON.stringify(mainHome)}\n\n[inherit]\ncredentials = "isolated"\n`,
      'utf8',
    );
    writeFileSync(
      join(mainHome, 'homes.json'),
      JSON.stringify([{ id: 'h-work', name: 'Work Space', path: siblingHome }], null, 2),
      'utf8',
    );

    siblingProc = spawn(exe, ['--max-old-space-size=8192', serverEntry, 'serve', '--port', '0'], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        KIKI_HOME: siblingHome,
        KIKI_CACHE_DIR: cacheDir,
        KIKI_DESKTOP_BUNDLED: '1',
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    if (siblingProc.pid) trackedPids.add(siblingProc.pid);

    const sibDeadline = Date.now() + 20_000;
    let initialSibReceipts: InstanceReceipt[] = [];
    while (Date.now() < sibDeadline) {
      initialSibReceipts = readInstanceReceipts(siblingHome);
      if (initialSibReceipts.length > 0 && existsSync(join(siblingHome, 'server.local-owner'))) break;
      await delay(100);
    }
    expect(initialSibReceipts.length).toBeGreaterThan(0);
    for (const r of initialSibReceipts) trackedPids.add(r.pid);

    const spacesRes = await fetch(`${nextConn.url}/api/desktop/spaces`, {
      headers: { Authorization: `Bearer ${nextConn.token}` },
    });
    expect(spacesRes.status).toBe(200);
    const spacesEnvelope = (await spacesRes.json()) as {
      code: number;
      data: {
        spaces: Array<{ home_id: string; running: boolean; desktop_managed?: boolean }>;
      };
    };
    expect(spacesEnvelope.code).toBe(0);
    const workEntry = spacesEnvelope.data.spaces.find((s) => s.home_id === 'h-work');
    expect(workEntry?.running).toBe(true);
    expect(workEntry?.desktop_managed).toBe(true);

    // Verify sibling PluginFocusPoller / plugin-focus endpoint returns 200 without 401 token mismatch.
    const focusRes = await fetch(`${nextConn.url}/api/desktop/plugin-focus?home_id=main`, {
      headers: { Authorization: `Bearer ${nextConn.token}` },
    });
    expect(focusRes.status).toBe(200);
    const focusEnvelope = (await focusRes.json()) as { code: number };
    expect(focusEnvelope.code).toBe(0);

    // Verify createSpaceShortcut creates a real .lnk on Windows and returns lowercase `shortcut_exists` on duplicate.
    if (process.platform === 'win32') {
      const firstShortcut = (await page.evaluate(async () => {
        const bridge = (window as unknown as { __KIKI_ELECTRON__: ElectronBridge }).__KIKI_ELECTRON__;
        return bridge.desktop.createSpaceShortcut('h-work');
      })) as SpaceShortcutResult;
      expect(firstShortcut.ok).toBe(true);
      if (firstShortcut.ok) {
        expect(existsSync(firstShortcut.path)).toBe(true);
      }
      const dupShortcut = (await page.evaluate(async () => {
        const bridge = (window as unknown as { __KIKI_ELECTRON__: ElectronBridge }).__KIKI_ELECTRON__;
        return bridge.desktop.createSpaceShortcut('h-work');
      })) as SpaceShortcutResult;
      expect(dupShortcut).toMatchObject({ ok: false, code: 'shortcut_exists' });
    }

    // Restarting sibling space 'h-work' must NOT mutate the active main connection!
    await page.evaluate(async () => {
      const bridge = (window as unknown as { __KIKI_ELECTRON__: ElectronBridge }).__KIKI_ELECTRON__;
      await bridge.desktop.restartSpace('h-work');
    });

    const activeConnAfterSibRestart = await waitForLiveConnection(page, 10_000);
    expect(activeConnAfterSibRestart.url).toBe(nextConn.url);
    const restartedSibReceipts = readInstanceReceipts(siblingHome);
    expect(restartedSibReceipts.length).toBeGreaterThan(0);
    for (const r of restartedSibReceipts) trackedPids.add(r.pid);

    // Verify switchSpace preserves deep route path + kiki.navScopeHandoff.v1 across reloadForSwitchedSpace (webContents.reload) and switches active home!
    await page.evaluate(async () => {
      const bridge = (window as unknown as { __KIKI_ELECTRON__: ElectronBridge }).__KIKI_ELECTRON__;
      await bridge.desktop.writePrefs({ windowMode: 'switch' });
      window.history.replaceState({ idx: 1, key: 'handoff-key-1' }, '', '/usage');
      window.sessionStorage.setItem(
        'kiki.navScopeHandoff.v1',
        JSON.stringify({
          scope: { scopeId: 'local:h-work', homeId: 'h-work' },
          route: '/usage',
          key: 'handoff-key-1',
        }),
      );
    });
    expect(new URL(page.url()).pathname).toBe('/usage');

    const switchToWorkLoad = page.waitForEvent('load', { timeout: 15_000 });
    await page.evaluate(() => {
      const bridge = (window as unknown as { __KIKI_ELECTRON__: ElectronBridge }).__KIKI_ELECTRON__;
      void bridge.desktop.switchSpace('h-work');
    });
    await switchToWorkLoad;
    const switchedConn = await waitForLiveConnection(page, 15_000);
    expect(switchedConn.url).not.toBe(nextConn.url);

    const switchedState = await page.evaluate(async () => {
      const bridge = (window as unknown as { __KIKI_ELECTRON__: ElectronBridge }).__KIKI_ELECTRON__;
      return {
        origin: window.location.origin,
        pathname: window.location.pathname,
        handoffConsumed: window.sessionStorage.getItem('kiki.navScopeHandoff.v1') === null,
        stored: window.localStorage.getItem('kiki-070-origin-test'),
        active: (await bridge.desktop.activeSpace()) as {
          homeId: string;
          isPrimary: boolean;
          credentialsShared: boolean;
        },
        prefs: await bridge.desktop.readPrefs(),
      };
    });
    expect(switchedState.origin).toBe('kiki-app://localhost');
    expect(switchedState.pathname).toBe('/usage');
    expect(switchedState.handoffConsumed).toBe(true);
    expect(switchedState.stored).toBe('persisted-value-42');
    expect(switchedState.active).toEqual(
      expect.objectContaining({
        homeId: 'h-work',
        isPrimary: false,
        credentialsShared: false,
      }),
    );
    expect(switchedState.prefs?.compatibility).toEqual({ homeKind: 'kiki' });

    // Switch back to main before cleanup.
    const switchBackLoad = page.waitForEvent('load', { timeout: 15_000 });
    await page
      .evaluate(async () => {
        const bridge = (window as unknown as { __KIKI_ELECTRON__: ElectronBridge }).__KIKI_ELECTRON__;
        await bridge.desktop.switchSpace('main');
      })
      .catch(() => undefined);
    await switchBackLoad;
    let restoredMainConn: ConnectionConfig | null = null;
    const restoreDeadline = Date.now() + 15_000;
    while (Date.now() < restoreDeadline) {
      const state = await page
        .evaluate(async () => {
          const bridge = (window as unknown as { __KIKI_ELECTRON__?: ElectronBridge }).__KIKI_ELECTRON__;
          if (!bridge || window.location.origin !== 'kiki-app://localhost') return null;
          const space = (await bridge.desktop.activeSpace()) as { homeId: string };
          const env = await bridge.discoverConnection();
          if (env === null) return null;
          const config =
            'ok' in env ? (env.ok ? env.connection.config : null) : env.config;
          return config ? { homeId: space.homeId, config } : null;
        })
        .catch(() => null);
      if (state?.homeId === 'main') {
        restoredMainConn = state.config;
        break;
      }
      await delay(80);
    }
    expect(restoredMainConn?.url).toBe(nextConn.url);

    // Verify `switch`-mode second-instance routing: launching a 2nd packaged `kiki-desktop.exe --home <siblingHome>`
    // with a `kiki://subscribe` deep link reuses the main single-instance lock, exits 0 immediately, switches the
    // existing window to `h-work`, and delivers the subscribe intent!
    const secondLoad = page.waitForEvent('load', { timeout: 15_000 });
    const secondInstanceExit = await new Promise<number | null>((resolveExit) => {
      const secondProc = spawn(
        exe,
        [
          '--no-proxy-server',
          '--no-release-redirect',
          '--home',
          siblingHome,
          'kiki://subscribe?url=https%3A%2F%2Fexample.com%2Fsub.json&name=SwitchFeed',
        ],
        {
          env: cleanGuiEnv({
            KIKI_HOME: mainHome,
            KIKI_DESKTOP_USER_DATA_DIR: userDataDir,
            KIKI_CACHE_DIR: cacheDir,
          }),
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      if (secondProc.pid) trackedPids.add(secondProc.pid);
      secondProc.once('exit', (code) => resolveExit(code));
      secondProc.once('error', () => resolveExit(-1));
    });
    expect(secondInstanceExit).toBe(0);
    await secondLoad;
    await waitForLiveConnection(page, 15_000);

    const afterSecondInstance = await page.evaluate(async () => {
      const bridge = (window as unknown as { __KIKI_ELECTRON__: ElectronBridge }).__KIKI_ELECTRON__;
      const active = (await bridge.desktop.activeSpace()) as { homeId: string };
      const sub = await bridge.desktop.peekSubscribeIntent();
      if (sub) await bridge.desktop.ackSubscribeIntent(sub.id);
      return { homeId: active.homeId, sub };
    });
    expect(afterSecondInstance.homeId).toBe('h-work');
    expect(afterSecondInstance.sub).toMatchObject({
      url: 'https://example.com/sub.json',
      name: 'SwitchFeed',
    });

    // Switch back to main before cleanup.
    const finalSwitchBack = page.waitForEvent('load', { timeout: 15_000 });
    await page
      .evaluate(async () => {
        const bridge = (window as unknown as { __KIKI_ELECTRON__: ElectronBridge }).__KIKI_ELECTRON__;
        await bridge.desktop.switchSpace('main');
      })
      .catch(() => undefined);
    await finalSwitchBack;
    await waitForLiveConnection(page, 15_000);

    // Stop sibling server via its own server.local-owner and wait for exit before closing main app
    // so inherited Windows child handles close before Playwright awaits EOF.
    const sibOwnerToken = readFileSync(join(siblingHome, 'server.local-owner'), 'utf8').trim();
    const allSibReceipts = readInstanceReceipts(siblingHome);
    for (const r of allSibReceipts) {
      trackedPids.add(r.pid);
      await fetch(`http://127.0.0.1:${r.port}/api/desktop-lifecycle`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sibOwnerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'quit',
          server_id: r.server_id,
          consent: true,
          interrupt_work: true,
        }),
      }).catch(() => undefined);
    }
    for (const r of allSibReceipts) {
      expect(await waitForPidExit(r.pid, 12_000)).toBe(true);
    }

    await page.evaluate(async () => {
      const bridge = (window as unknown as { __KIKI_ELECTRON__: ElectronBridge }).__KIKI_ELECTRON__;
      await bridge.desktop.writePrefs({ closeToTray: false });
    });

    const activeReceiptsBeforeQuit = readInstanceReceipts(mainHome);
    await appInstance.evaluate(({ app }) => {
      app.quit();
    });
    await appInstance.close();
    appInstance = undefined;

    for (const r of activeReceiptsBeforeQuit) {
      expect(await waitForPidExit(r.pid, 12_000)).toBe(true);
    }
  });

  it('rescues off-screen persisted window-state.json, guarantees single daemon under concurrent ensure.lock, and renders + recovers injected startup failure UI', async () => {
    const { exe, serverEntry } = resolveUnpackedPaths();
    const scratch = mkdtempSync(join(tmpdir(), 'kiki-e2e-rescue-'));
    const rescueHome = join(scratch, 'rescue-home');
    const rescueUserData = join(scratch, 'rescue-userdata');
    const failHome = join(scratch, 'fail-home');
    const failUserData = join(scratch, 'fail-userdata');
    const cacheDir = join(scratch, 'cache');
    mkdirSync(rescueHome, { recursive: true });
    mkdirSync(rescueUserData, { recursive: true });
    mkdirSync(failHome, { recursive: true });

    writeFileSync(
      join(rescueUserData, 'window-state.json'),
      JSON.stringify({ x: -15000, y: -15000, width: 1200, height: 800, isMaximized: false }),
      'utf8',
    );

    let rescueApp: ElectronApplication | undefined;
    let failApp: ElectronApplication | undefined;
    const pidsToReap = new Set<number>();

    cleanupCallbacks.push(async () => {
      await rescueApp?.close().catch(() => undefined);
      await failApp?.close().catch(() => undefined);
      for (const pid of pidsToReap) {
        if (isPidAlive(pid)) {
          try {
            process.kill(pid);
          } catch {
            // Exited.
          }
        }
      }
      await delay(250);
      rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    });

    // Launch Electron AND a concurrent CLI `serve --ensure-only` on the exact same cold `rescueHome`
    // to verify `<home>/server/ensure.lock` guarantees a single daemon instance!
    const concurrentCliEnsure = new Promise<number | null>((resolveExit) => {
      const child = spawn(
        exe,
        ['--max-old-space-size=8192', serverEntry, 'serve', '--port', '0', '--ensure'],
        {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            KIKI_HOME: rescueHome,
            KIKI_CACHE_DIR: cacheDir,
            KIKI_DESKTOP_BUNDLED: '1',
          },
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      if (child.pid) pidsToReap.add(child.pid);
      child.once('exit', (code) => {
        resolveExit(code);
      });
      child.once('error', () => {
        resolveExit(-1);
      });
    });

    rescueApp = await electron.launch({
      executablePath: exe,
      args: ['--no-proxy-server', '--no-release-redirect', '--home', rescueHome],
      env: cleanGuiEnv({
        KIKI_HOME: rescueHome,
        KIKI_DESKTOP_USER_DATA_DIR: rescueUserData,
        KIKI_CACHE_DIR: cacheDir,
      }),
    });
    const rescuePage = await rescueApp.firstWindow();
    await waitForLiveConnection(rescuePage, 15_000);
    const cliExitCode = await concurrentCliEnsure;
    expect(cliExitCode).toBe(0);

    const rescueReceipts = readInstanceReceipts(rescueHome);
    expect(rescueReceipts.length).toBe(1);
    for (const r of rescueReceipts) pidsToReap.add(r.pid);

    const rescuedCheck = await rescueApp.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('No BrowserWindow');
      const bounds = win.getBounds();
      const displays = screen.getAllDisplays();
      const intersectsVisible = displays.some((d) => {
        const wa = d.workArea;
        const ix = Math.max(0, Math.min(bounds.x + bounds.width, wa.x + wa.width) - Math.max(bounds.x, wa.x));
        const iy = Math.max(0, Math.min(bounds.y + bounds.height, wa.y + wa.height) - Math.max(bounds.y, wa.y));
        return ix >= 120 && iy >= 80;
      });
      return { bounds, intersectsVisible };
    });
    expect(rescuedCheck.intersectsVisible).toBe(true);
    expect(rescuedCheck.bounds.x).toBeGreaterThan(-5000);
    expect(rescuedCheck.bounds.width).toBe(1200);
    expect(rescuedCheck.bounds.height).toBe(800);
    await rescueApp.close();
    rescueApp = undefined;
    for (const r of rescueReceipts) {
      expect(await waitForPidExit(r.pid, 12_000)).toBe(true);
    }

    // Injected startup failure on real unpacked `kiki-desktop.exe`: verify React failure card (`stderrTail` + `logPath`) + live Retry recovery!
    const brokenEntry = join(scratch, 'broken-server.mjs');
    writeFileSync(
      brokenEntry,
      'process.stderr.write("INJECTED_FATAL_BOOT_DIAGNOSTIC: synthetic port bind crash\\n"); process.exit(42);\n',
      'utf8',
    );
    failApp = await electron.launch({
      executablePath: exe,
      args: ['--no-proxy-server', '--no-release-redirect', '--home', failHome],
      env: cleanGuiEnv({
        KIKI_HOME: failHome,
        KIKI_DESKTOP_USER_DATA_DIR: failUserData,
        KIKI_CACHE_DIR: cacheDir,
        KIKI_DESKTOP_SERVER_ENTRY: brokenEntry,
      }),
    });
    const failPage = await failApp.firstWindow();
    let failureRecord: DesktopFailurePayload | null = null;
    const failDeadline = Date.now() + 15_000;
    while (Date.now() < failDeadline) {
      const env = await failPage
        .evaluate(async () => {
          const bridge = (window as unknown as { __KIKI_ELECTRON__?: ElectronBridge }).__KIKI_ELECTRON__;
          if (!bridge || window.location.origin !== 'kiki-app://localhost') return null;
          return bridge.discoverConnection();
        })
        .catch(() => null);
      if (env !== null && 'ok' in env && !env.ok) {
        failureRecord = env.failure;
        break;
      }
      await delay(100);
    }

    expect(failureRecord).not.toBeNull();
    expect((failureRecord?.stderrTail ?? []).join('\n')).toContain('INJECTED_FATAL_BOOT_DIAGNOSTIC');
    expect(failureRecord?.message ?? '').toContain('INJECTED_FATAL_BOOT_DIAGNOSTIC');
    expect(failureRecord?.logPath ?? '').toContain('desktop-backend.log');
    expect(existsSync(failureRecord!.logPath!)).toBe(true);

    // Wait for the real React DesktopFailureCard `<pre>` on `kiki-app://localhost` to render the diagnostic text!
    await failPage.waitForFunction(
      () => document.body.innerText.includes('INJECTED_FATAL_BOOT_DIAGNOSTIC'),
      undefined,
      { timeout: 10_000 },
    );

    // Repair the server entry script in place and click the real Retry button in DesktopFailureCard!
    writeFileSync(
      brokenEntry,
      `await import(${JSON.stringify(pathToFileURL(serverEntry).href)});\n`,
      'utf8',
    );
    await failPage.locator('button').first().click();

    const recoveredConn = await waitForLiveConnection(failPage, 20_000);
    expect(recoveredConn.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const recoveredReceipts = readInstanceReceipts(failHome);
    expect(recoveredReceipts.length).toBe(1);
    for (const r of recoveredReceipts) pidsToReap.add(r.pid);

    await failApp.close();
    failApp = undefined;
    for (const r of recoveredReceipts) {
      expect(await waitForPidExit(r.pid, 12_000)).toBe(true);
    }
  });

  it('hides windows immediately, tree-kills a hung daemon + grandchild process within <= 6s, and exits 0 on Quit (t1026 regression)', async () => {
    const { exe } = resolveUnpackedPaths();
    const scratch = mkdtempSync(join(tmpdir(), 'kiki-e2e-hung-quit-'));
    const hungHome = join(scratch, 'hung-home');
    const hungUserData = join(scratch, 'hung-userdata');
    const cacheDir = join(scratch, 'cache');
    const grandchildPidFile = join(scratch, 'grandchild.pid');
    const hungServerEntry = join(scratch, 'hung-server.mjs');
    mkdirSync(hungHome, { recursive: true });

    writeFileSync(
      hungServerEntry,
      [
        "import { spawn } from 'node:child_process';",
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { createServer } from 'node:http';",
        "import { join } from 'node:path';",
        'const home = process.env.KIKI_HOME;',
        'const token = "a".repeat(43);',
        'const serverId = "srv-hung-e2e";',
        'mkdirSync(join(home, "server", "instances"), { recursive: true });',
        'writeFileSync(join(home, "server.local-owner"), token, "utf8");',
        `const sub = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true });`,
        `writeFileSync(${JSON.stringify(grandchildPidFile)}, String(sub.pid), 'utf8');`,
        'const srv = createServer((req, res) => {',
        '  res.setHeader("Content-Type", "application/json");',
        '  if (req.url === "/api/healthz") { res.end(JSON.stringify({ ok: true })); return; }',
        '  if (req.url === "/api/meta") {',
        '    res.end(JSON.stringify({ code: 0, data: { server_id: serverId, current_space_id: "main", desktop_managed: true } }));',
        '    return;',
        '  }',
        '  if (req.url === "/api/desktop-lifecycle" && req.method === "GET") {',
        '    res.end(JSON.stringify({ code: 0, data: { server_id: serverId, home_id: "main", managed: true, draining: false, work_pending: [] } }));',
        '    return;',
        '  }',
        '  if (req.url === "/api/desktop-lifecycle" && req.method === "POST") {',
        '    res.end(JSON.stringify({ code: 0, data: { ok: true } }));',
        '    return;',
        '  }',
        '  res.end(JSON.stringify({ code: 0, data: { spaces: [], statuses: [] } }));',
        '});',
        'srv.listen(0, "127.0.0.1", () => {',
        '  const addr = srv.address();',
        '  writeFileSync(join(home, "server", "instances", "hung.json"), JSON.stringify({ pid: process.pid, port: addr.port, host: "127.0.0.1", server_id: serverId, started_at: Date.now(), heartbeat_at: Date.now() }), "utf8");',
        '});',
        'setInterval(() => {}, 60000);',
      ].join('\n'),
      'utf8',
    );

    let hungApp: ElectronApplication | undefined;
    const pidsToReap = new Set<number>();

    cleanupCallbacks.push(async () => {
      await hungApp?.close().catch(() => undefined);
      for (const pid of pidsToReap) {
        if (isPidAlive(pid)) {
          try {
            process.kill(pid);
          } catch {
            // Exited.
          }
        }
      }
      await delay(250);
      rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    });

    hungApp = await electron.launch({
      executablePath: exe,
      args: ['--no-proxy-server', '--no-release-redirect', '--home', hungHome],
      env: cleanGuiEnv({
        KIKI_HOME: hungHome,
        KIKI_DESKTOP_USER_DATA_DIR: hungUserData,
        KIKI_CACHE_DIR: cacheDir,
        KIKI_DESKTOP_SERVER_ENTRY: hungServerEntry,
      }),
    });
    const guiProc = hungApp.process();
    if (guiProc.pid) pidsToReap.add(guiProc.pid);

    const hungPage = await hungApp.firstWindow();
    await waitForLiveConnection(hungPage, 15_000);

    const receipts = readInstanceReceipts(hungHome);
    expect(receipts.length).toBe(1);
    const hungDaemonPid = receipts[0]!.pid;
    pidsToReap.add(hungDaemonPid);

    const grandchildPid = Number(readFileSync(grandchildPidFile, 'utf8').trim());
    expect(grandchildPid).toBeGreaterThan(0);
    pidsToReap.add(grandchildPid);
    expect(isPidAlive(hungDaemonPid)).toBe(true);
    expect(isPidAlive(grandchildPid)).toBe(true);

    // Block beforeunload in renderer too — app.exit(0) must still terminate cleanly!
    await hungPage.evaluate(() => {
      window.addEventListener('beforeunload', (e) => {
        e.preventDefault();
        e.returnValue = '';
      });
    });

    const exitPromise = new Promise<number | null>((resolveExit) => {
      guiProc.once('exit', (code) => resolveExit(code));
    });

    const quitStart = performance.now();
    await hungApp.evaluate(({ app }) => {
      app.quit();
    });

    // Window must hide immediately (< 1s) while background grace + tree-kill completes!
    await delay(250);
    const visibleDuringGrace = await hungApp
      .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible()))
      .catch(() => false);
    expect(visibleDuringGrace).toBe(false);

    const exitCode = await exitPromise;
    const quitElapsedMs = Math.round(performance.now() - quitStart);
    console.log(`[Layer 2] Hung-backend Quit completed in ${quitElapsedMs}ms with exitCode=${String(exitCode)}`);
    hungApp = undefined;

    expect(exitCode).toBe(0);
    expect(quitElapsedMs).toBeLessThan(6_500);
    expect(await waitForPidExit(hungDaemonPid, 1_500)).toBe(true);
    expect(await waitForPidExit(grandchildPid, 1_500)).toBe(true);
    expect(readInstanceReceipts(hungHome)).toEqual([]);
  });
});
