import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDaemonNodeOptions,
  buildDaemonSpawnEnv,
  computeDaemonHeapMb,
  DaemonSupervisor,
  type SpawnedDaemonChild,
} from '#/main/daemonSupervisor';
import { RotatingLog } from '#/main/rotatingLog';
import { executeStopBackgroundSpace, executeTrayQuit } from '#/main/trayService';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kiki-desktop-daemon-'));
  tempDirs.push(dir);
  return dir;
}

class FakeDaemonChild extends EventEmitter implements SpawnedDaemonChild {
  readonly killedSignals: Array<NodeJS.Signals | number | undefined> = [];
  unrefCalled = false;

  constructor(readonly pid: number) {
    super();
  }

  unref(): void {
    this.unrefCalled = true;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killedSignals.push(signal);
    return true;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestUrlString(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('DaemonSupervisor', () => {
  it('computes heap sizing policy and injects ELECTRON_RUN_AS_NODE + KIKI_INJECTED_HEAP_OPTION without leaking redirect guard', () => {
    expect(computeDaemonHeapMb(16 * 1024 * 1024 * 1024)).toBe(8192);
    expect(computeDaemonHeapMb(64 * 1024 * 1024 * 1024)).toBe(16384);
    expect(buildDaemonNodeOptions('--max_old_space_size=4096', 64 * 1024 * 1024 * 1024)).toEqual({
      nodeOptions: '--max_old_space_size=4096',
      injectedHeapOption: '',
    });

    const env = buildDaemonSpawnEnv(
      {
        electronBinary: '/opt/kiki/kiki-desktop',
        serverEntry: '/opt/kiki/server-entry.mjs',
        homeDir: '/home/user/.kiki',
        oauthHomeDir: '/home/user/.kiki',
      },
      {
        KIKI_NO_RELEASE_REDIRECT: '1',
        NODE_OPTIONS: '--trace-warnings',
      },
      64 * 1024 * 1024 * 1024,
    );

    expect(env['ELECTRON_RUN_AS_NODE']).toBe('1');
    expect(env['KIKI_DESKTOP_BUNDLED']).toBe('1');
    expect(env['KIKI_NO_RELEASE_REDIRECT']).toBeUndefined();
    expect(env['NODE_OPTIONS']).toBe('--trace-warnings --max-old-space-size=16384');
    expect(env['KIKI_INJECTED_HEAP_OPTION']).toBe('--max-old-space-size=16384');
  });

  it('spawns detached ELECTRON_RUN_AS_NODE daemon, unrefs on ready, and survives window close (detachDesktop)', async () => {
    const home = makeTempHome();
    const child = new FakeDaemonChild(4242);
    let capturedOptions: { detached?: boolean; env?: NodeJS.ProcessEnv } | undefined;

    const supervisor = new DaemonSupervisor(
      {
        electronBinary: '/opt/kiki/kiki-desktop',
        serverEntry: '/opt/kiki/server-entry.mjs',
        homeDir: home,
      },
      {
        isPidAlive: (pid) => pid === 4242,
        spawnFn: (_cmd, _args, options) => {
          capturedOptions = { detached: options.detached, env: options.env };
          mkdirSync(join(home, 'server', 'instances'), { recursive: true });
          writeFileSync(join(home, 'server.local-owner'), 'owner-secret-token');
          writeFileSync(
            join(home, 'server', 'instances', '4242.json'),
            JSON.stringify({ pid: 4242, port: 19001, serverId: 'srv-1' }),
          );
          return child;
        },
        fetchFn: async (input) => {
          const url = requestUrlString(input);
          if (url.endsWith('/api/meta')) {
            return jsonResponse({
              code: 0,
              msg: 'ok',
              data: { server_id: 'srv-1', home_id: 'main', desktop_managed: true },
            });
          }
          return jsonResponse({ code: 1, msg: 'unexpected' }, 404);
        },
      },
    );

    const connection = await supervisor.discoverConnection();
    expect(connection).toEqual({
      config: { url: 'http://127.0.0.1:19001', token: 'owner-secret-token' },
      persist: false,
    });
    expect(capturedOptions?.detached).toBe(true);
    expect(capturedOptions?.env?.['ELECTRON_RUN_AS_NODE']).toBe('1');
    expect(child.unrefCalled).toBe(true);

    // Closing the desktop window or calling cancelStartup after readiness MUST NOT kill the daemon.
    supervisor.detachDesktop();
    await supervisor.cancelStartup();
    expect(child.killedSignals).toEqual([]);
  });

  it('kills ONLY the pre-ready child when cancelStartup() fires before readiness', async () => {
    const home = makeTempHome();
    const child = new FakeDaemonChild(5151);

    const supervisor = new DaemonSupervisor(
      {
        electronBinary: '/opt/kiki/kiki-desktop',
        serverEntry: '/opt/kiki/server-entry.mjs',
        homeDir: home,
      },
      {
        isPidAlive: () => true,
        spawnFn: () => child,
        fetchFn: async () => jsonResponse({ code: 1 }, 503),
        pollIntervalMs: 50,
      },
    );

    const pending = supervisor.discoverConnection();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await supervisor.cancelStartup();

    await expect(pending).rejects.toThrow(/cancelled/i);
    expect(child.killedSignals).toEqual(['SIGTERM']);
    expect(child.unrefCalled).toBe(false);
  });

  it('tray Quit confirms pending work, stops ONLY desktop-managed local daemons, and never kills external daemons', async () => {
    const home = makeTempHome();
    mkdirSync(join(home, 'server', 'instances'), { recursive: true });
    writeFileSync(join(home, 'server.local-owner'), 'tok');
    writeFileSync(join(home, 'server', 'instances', '777.json'), JSON.stringify({ pid: 777, port: 19002 }));

    const lifecyclePosts: Array<{ action: string; interrupt_work: boolean }> = [];
    let managed = true;
    let pendingWork = ['session-1'];

    const supervisor = new DaemonSupervisor(
      {
        electronBinary: '/opt/kiki/kiki-desktop',
        serverEntry: '/opt/kiki/server-entry.mjs',
        homeDir: home,
      },
      {
        isPidAlive: (pid) => pid === 777,
        fetchFn: async (input, init) => {
          const url = requestUrlString(input);
          if (url.endsWith('/api/meta')) {
            return jsonResponse({
              code: 0,
              msg: 'ok',
              data: { server_id: 'srv-managed', home_id: 'main', desktop_managed: managed },
            });
          }
          if (url.endsWith('/api/desktop-lifecycle') && (!init?.method || init.method === 'GET')) {
            return jsonResponse({
              code: 0,
              msg: 'ok',
              data: {
                server_id: 'srv-managed',
                home_id: 'main',
                managed,
                draining: false,
                work_pending: pendingWork,
              },
            });
          }
          if (url.endsWith('/api/desktop-lifecycle') && init?.method === 'POST') {
            const rawBody = typeof init.body === 'string' ? init.body : '';
            const body = JSON.parse(rawBody) as { action: string; interrupt_work: boolean };
            lifecyclePosts.push(body);
            return jsonResponse({ code: 0, msg: 'ok', data: { ok: true } });
          }
          return jsonResponse({ code: 1 }, 404);
        },
      },
    );

    // Non-spawning attach works for --tray-only
    const attached = await supervisor.attachIfRunning();
    expect(attached?.config.url).toBe('http://127.0.0.1:19002');

    // User cancels quit when pending work exists -> daemon stays running, app does not quit.
    let released = false;
    const cancelledQuit = await executeTrayQuit({
      stopManagedDaemon: (opts) => supervisor.stopManagedDaemon(opts),
      confirmInterruptPendingWork: async () => false,
      detachDesktop: () => {
        supervisor.detachDesktop();
      },
      releaseQuit: () => {
        released = true;
      },
    });
    expect(cancelledQuit.quit).toBe(false);
    expect(released).toBe(false);
    expect(lifecyclePosts).toEqual([]);

    // User confirms quit -> POST /api/desktop-lifecycle stops managed daemon.
    const confirmedQuit = await executeTrayQuit({
      stopManagedDaemon: (opts) => supervisor.stopManagedDaemon(opts),
      confirmInterruptPendingWork: async (work) => work.includes('session-1'),
      detachDesktop: () => {
        supervisor.detachDesktop();
      },
      releaseQuit: () => {
        released = true;
      },
    });
    expect(confirmedQuit.quit).toBe(true);
    expect(released).toBe(true);
    expect(lifecyclePosts).toEqual([
      { action: 'quit', server_id: 'srv-managed', consent: true, interrupt_work: true },
    ]);

    // External daemon (managed=false) is NEVER stopped by Tray Quit.
    managed = false;
    pendingWork = [];
    lifecyclePosts.length = 0;
    await supervisor.attachIfRunning();
    const externalStop = await supervisor.stopManagedDaemon({ action: 'quit', interruptWork: true });
    expect(externalStop).toEqual({ stopped: false, reason: 'external' });
    expect(lifecyclePosts).toEqual([]);
  });

  it('stops a background space via home-scoped stopManagedDaemonForHome after confirmation without detaching active window daemon', async () => {
    const activeHome = makeTempHome();
    const bgHome = makeTempHome();
    mkdirSync(join(activeHome, 'server', 'instances'), { recursive: true });
    mkdirSync(join(bgHome, 'server', 'instances'), { recursive: true });
    writeFileSync(join(activeHome, 'server.local-owner'), 'tok-active');
    writeFileSync(join(bgHome, 'server.local-owner'), 'tok-bg');
    writeFileSync(join(activeHome, 'server', 'instances', '101.json'), JSON.stringify({ pid: 101, port: 19101 }));
    writeFileSync(join(bgHome, 'server', 'instances', '202.json'), JSON.stringify({ pid: 202, port: 19202 }));

    const stoppedPorts: number[] = [];
    const supervisor = new DaemonSupervisor(
      {
        electronBinary: '/opt/kiki/kiki-desktop',
        serverEntry: '/opt/kiki/server-entry.mjs',
        homeDir: activeHome,
      },
      {
        isPidAlive: (pid) => pid === 101 || pid === 202,
        fetchFn: async (input, init) => {
          const url = new URL(requestUrlString(input));
          const port = Number(url.port);
          if (url.pathname === '/api/meta') {
            return jsonResponse({
              code: 0,
              msg: 'ok',
              data: { server_id: `srv-${port}`, home_id: port === 19101 ? 'main' : 'bg', desktop_managed: true },
            });
          }
          if (url.pathname === '/api/desktop-lifecycle' && (!init?.method || init.method === 'GET')) {
            return jsonResponse({
              code: 0,
              msg: 'ok',
              data: { server_id: `srv-${port}`, home_id: port === 19101 ? 'main' : 'bg', managed: true, draining: false, work_pending: [] },
            });
          }
          if (url.pathname === '/api/desktop-lifecycle' && init?.method === 'POST') {
            stoppedPorts.push(port);
            return jsonResponse({ code: 0, msg: 'ok', data: { ok: true } });
          }
          return jsonResponse({ code: 1 }, 404);
        },
      },
    );

    await supervisor.attachIfRunning();
    expect(supervisor.currentConnection?.url).toBe('http://127.0.0.1:19101');

    const cancelled = await executeStopBackgroundSpace({
      spaceName: 'Background',
      spacePath: bgHome,
      confirmStopSpace: async () => false,
      stopManagedDaemonForHome: (homeDir, opts) => supervisor.stopManagedDaemonForHome(homeDir, opts),
    });
    expect(cancelled).toEqual({ stopped: false, reason: 'cancelled' });
    expect(stoppedPorts).toEqual([]);

    const stopped = await executeStopBackgroundSpace({
      spaceName: 'Background',
      spacePath: bgHome,
      confirmStopSpace: async () => true,
      stopManagedDaemonForHome: (homeDir, opts) => supervisor.stopManagedDaemonForHome(homeDir, opts),
    });
    expect(stopped).toEqual({ stopped: true, reason: 'stopped' });
    expect(stoppedPorts).toEqual([19202]);
    // Active window's target home and attached connection remain completely untouched!
    expect(supervisor.activeHomeDir).toBe(activeHome);
    expect(supervisor.currentConnection?.url).toBe('http://127.0.0.1:19101');
  });

  it('delegates SSH, spaces, and plugin-focus calls to kap-server /api/desktop/* endpoints', async () => {
    const home = makeTempHome();
    mkdirSync(join(home, 'server', 'instances'), { recursive: true });
    writeFileSync(join(home, 'server.local-owner'), 'tok');
    writeFileSync(join(home, 'server', 'instances', '888.json'), JSON.stringify({ pid: 888, port: 19003 }));

    const calls: string[] = [];
    const supervisor = new DaemonSupervisor(
      {
        electronBinary: '/opt/kiki/kiki-desktop',
        serverEntry: '/opt/kiki/server-entry.mjs',
        homeDir: home,
      },
      {
        isPidAlive: (pid) => pid === 888,
        fetchFn: async (input, init) => {
          const url = new URL(requestUrlString(input));
          const method = init?.method ?? 'GET';
          calls.push(`${method} ${url.pathname}${url.search}`);
          if (url.pathname === '/api/meta') {
            return jsonResponse({ code: 0, msg: 'ok', data: { server_id: 's8', home_id: 'main', desktop_managed: true } });
          }
          if (url.pathname === '/api/desktop/ssh/profiles') {
            return jsonResponse({ code: 0, msg: 'ok', data: { profiles: [] } });
          }
          if (url.pathname === '/api/desktop/spaces') {
            return jsonResponse({ code: 0, msg: 'ok', data: { spaces: [], statuses: [] } });
          }
          if (url.pathname === '/api/desktop/plugin-focus') {
            return jsonResponse({
              code: 0,
              msg: 'ok',
              data: { focus: { homeId: 'main', route: '/plugins/brief', requestId: 42 } },
            });
          }
          if (url.pathname === '/api/desktop/plugin-focus/ack') {
            return jsonResponse({ code: 0, msg: 'ok', data: { cleared: true } });
          }
          if (url.pathname === '/api/desktop/plugin-focus/remember') {
            return jsonResponse({ code: 0, msg: 'ok', data: { remembered: true } });
          }
          return jsonResponse({ code: 1 }, 404);
        },
      },
    );

    expect(await supervisor.listSshProfiles()).toEqual([]);
    expect(await supervisor.listSpacesAndStatuses()).toEqual({ spaces: [], statuses: [] });
    expect(await supervisor.readPluginFocus('main')).toEqual({
      homeId: 'main',
      route: '/plugins/brief',
      requestId: 42,
    });
    await supervisor.ackPluginFocus('main', 42);
    await supervisor.rememberPluginFocus('main', 42);

    expect(calls).toContain('GET /api/desktop/ssh/profiles');
    expect(calls).toContain('GET /api/desktop/spaces');
    expect(calls).toContain('GET /api/desktop/plugin-focus?home_id=main');
    expect(calls).toContain('POST /api/desktop/plugin-focus/ack');
    expect(calls).toContain('POST /api/desktop/plugin-focus/remember');
  });

  it('rotates desktop-backend.log within disk budget and preserves UTF-8 boundaries on oversized lines', () => {
    const home = makeTempHome();
    const logPath = join(home, 'logs', 'desktop-backend.log');
    const log = new RotatingLog(logPath, 16, 2);
    for (let i = 0; i < 6; i += 1) {
      log.writeLine('123456789012345');
    }
    log.writeLine('测试'.repeat(40));
    log.close();

    for (const candidate of [logPath, `${logPath}.1`, `${logPath}.2`]) {
      expect(statSync(candidate).size).toBeLessThanOrEqual(16);
      expect(readFileSync(candidate, 'utf8')).not.toContain('\uFFFD');
    }
  });
});
