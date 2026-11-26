import { EventEmitter } from 'node:events';
import { closeSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import {
  openDetachedBackendLogFd,
  readBackendLogTail,
} from '#/main/rotatingLog';
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
    let capturedArgs: readonly string[] | undefined;
    let capturedOptions: { detached?: boolean; env?: NodeJS.ProcessEnv } | undefined;

    const supervisor = new DaemonSupervisor(
      {
        electronBinary: '/opt/kiki/kiki-desktop',
        serverEntry: '/opt/kiki/server-entry.mjs',
        homeDir: home,
      },
      {
        isPidAlive: (pid) => pid === 4242,
        spawnFn: (_cmd, args, options) => {
          capturedArgs = args;
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
    expect(capturedArgs?.[0]).toMatch(/^--max-old-space-size=\d+$/);
    expect(capturedArgs?.[1]).toBe('/opt/kiki/server-entry.mjs');
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
        shutdownGraceMs: 10,
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
        shutdownGraceMs: 10,
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
              data: { focus: { homeId: 'main', route: '/s/session-brief', requestId: 42 } },
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
      route: '/s/session-brief',
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

  it('rotates desktop-backend.log via openDetachedBackendLogFd and decodes UTF-8 tails via TextDecoder', async () => {
    const home = makeTempHome();
    const first = openDetachedBackendLogFd(home, 32, 2);
    closeSync(first.fd);
    writeFileSync(first.path, `${'x'.repeat(40)}\n`);

    const second = openDetachedBackendLogFd(home, 32, 2);
    closeSync(second.fd);
    expect(statSync(`${first.path}.1`).size).toBeGreaterThanOrEqual(40);

    const multiLine = ['alpha-1', '测试中文日志-2', 'FATAL_BOOT_ERR-3'].join('\n');
    writeFileSync(first.path, `${'p'.repeat(200)}\n${multiLine}\n`, 'utf8');
    const tail = await readBackendLogTail(home, 2, 64);
    expect(tail).toEqual(['测试中文日志-2', 'FATAL_BOOT_ERR-3']);
    expect(tail.join('\n')).not.toContain('\uFFFD');
  });

  it('emits connection.tsx-compatible stage payloads, serializes concurrent ensure.lock, and isolates sibling restartSpace', async () => {
    const activeHome = makeTempHome();
    const siblingHome = makeTempHome();
    let spawnCount = 0;
    const stages: unknown[] = [];

    const supervisor = new DaemonSupervisor(
      {
        electronBinary: '/opt/kiki/kiki-desktop',
        serverEntry: '/opt/kiki/server-entry.mjs',
        homeDir: activeHome,
      },
      {
        isPidAlive: (pid) => pid === 3101 || pid === 3202,
        spawnFn: (_cmd, _args, opts) => {
          spawnCount += 1;
          const targetHome = opts.env?.['KIKI_HOME'] ?? activeHome;
          const pid = targetHome === activeHome ? 3101 : 3202;
          const port = targetHome === activeHome ? 29101 : 29202;
          mkdirSync(join(targetHome, 'server', 'instances'), { recursive: true });
          writeFileSync(join(targetHome, 'server.local-owner'), `tok-${port}`);
          writeFileSync(
            join(targetHome, 'server', 'instances', `${pid}.json`),
            JSON.stringify({ pid, port, serverId: `srv-${port}` }),
          );
          return new FakeDaemonChild(pid);
        },
        fetchFn: async (input, init) => {
          const url = new URL(requestUrlString(input));
          const port = Number(url.port);
          if (url.pathname === '/api/meta') {
            return jsonResponse({
              code: 0,
              msg: 'ok',
              data: {
                server_id: `srv-${port}`,
                home_id: port === 29101 ? 'main' : 'sibling',
                desktop_managed: true,
              },
            });
          }
          if (url.pathname === '/api/desktop-lifecycle' && (!init?.method || init.method === 'GET')) {
            return jsonResponse({
              code: 0,
              msg: 'ok',
              data: {
                server_id: `srv-${port}`,
                home_id: port === 29101 ? 'main' : 'sibling',
                managed: true,
                draining: false,
                work_pending: [],
              },
            });
          }
          if (url.pathname === '/api/desktop-lifecycle' && init?.method === 'POST') {
            return jsonResponse({ code: 0, msg: 'ok', data: { ok: true } });
          }
          return jsonResponse({ code: 1 }, 404);
        },
      },
    );

    supervisor.onBackendStage((payload) => stages.push(payload));
    const [c1, c2] = await Promise.all([supervisor.discoverConnection(), supervisor.discoverConnection()]);
    expect(c1.config.url).toBe('http://127.0.0.1:29101');
    expect(c2.config.url).toBe('http://127.0.0.1:29101');
    expect(spawnCount).toBe(1);
    expect(stages).toContain('waiting');
    expect(stages).toContainEqual({
      stage: 'ready',
      connection: { url: 'http://127.0.0.1:29101', token: 'tok-29101' },
      homeId: 'main',
    });

    const siblingConn = await supervisor.restartSpace(siblingHome);
    expect(siblingConn.config.url).toBe('http://127.0.0.1:29202');
    expect(supervisor.activeHomeDir).toBe(activeHome);
    expect(supervisor.currentConnection?.url).toBe('http://127.0.0.1:29101');
  });

  it('includes stderrTail and logPath in failed stage and discoverConnectionEnvelope on startup crash', async () => {
    const home = makeTempHome();
    mkdirSync(join(home, 'logs'), { recursive: true });
    writeFileSync(join(home, 'logs', 'desktop-backend.log'), 'BOOT_LINE_1\nBOOT_CRASH_REASON\n', 'utf8');

    const stages: unknown[] = [];
    const supervisor = new DaemonSupervisor(
      {
        electronBinary: '/opt/kiki/kiki-desktop',
        serverEntry: '/opt/kiki/server-entry.mjs',
        homeDir: home,
      },
      {
        isPidAlive: () => false,
        openLogFd: (h) => ({ path: join(h, 'logs', 'desktop-backend.log'), fd: -1 }),
        closeFd: () => undefined,
        spawnFn: () => {
          const failing = new FakeDaemonChild(9090);
          queueMicrotask(() => {
            failing.emit('exit', 1, null);
          });
          return failing;
        },
        fetchFn: async () => jsonResponse({ code: 1 }, 503),
        pollIntervalMs: 10,
      },
    );
    supervisor.onBackendStage((p) => stages.push(p));

    const envelope = await supervisor.discoverConnectionEnvelope();
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.failure.message).toContain('BOOT_CRASH_REASON');
      expect(envelope.failure.stderrTail).toContain('BOOT_CRASH_REASON');
      expect(envelope.failure.logPath).toContain('desktop-backend.log');
    }
    expect(
      stages.some(
        (s) =>
          typeof s === 'object' &&
          s !== null &&
          'stage' in s &&
          (s as { stage: string }).stage === 'failed',
      ),
    ).toBe(true);
  });

  it('aborts an in-flight discoveryFlight when setTargetHome switches spaces so the new space never inherits the old flight', async () => {
    const homeA = makeTempHome();
    const homeB = makeTempHome();
    mkdirSync(join(homeB, 'server', 'instances'), { recursive: true });
    writeFileSync(join(homeB, 'server.local-owner'), 'token-b');
    writeFileSync(
      join(homeB, 'server', 'instances', 'srv-b.json'),
      JSON.stringify({ server_id: 'srv-b', pid: 7777, port: 42002 }),
    );

    const supervisor = new DaemonSupervisor(
      {
        electronBinary: '/opt/kiki/kiki-desktop',
        serverEntry: '/opt/kiki/server-entry.mjs',
        homeDir: homeA,
      },
      {
        isPidAlive: (pid) => pid === 7777 || pid === 6666,
        openLogFd: (h) => ({ path: join(h, 'logs', 'desktop-backend.log'), fd: -1 }),
        closeFd: () => undefined,
        spawnFn: () => new FakeDaemonChild(6666),
        fetchFn: async (input) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (url === 'http://127.0.0.1:42002/api/meta') {
            return jsonResponse({
              code: 0,
              data: { server_id: 'srv-b', server_home_id: 'space-b', desktop_managed: true },
            });
          }
          if (url === 'http://127.0.0.1:42002/api/remote-connections/handshake') {
            return jsonResponse({
              code: 0,
              data: { server_id: 'srv-b', server_home_id: 'space-b' },
            });
          }
          return jsonResponse({ code: 1 }, 503);
        },
        pollIntervalMs: 50,
      },
    );

    const staleFlight = supervisor.discoverConnection();
    const staleRejected = expect(staleFlight).rejects.toThrow(/newer space switch/i);
    supervisor.setTargetHome(homeB);
    const nextConn = await supervisor.discoverConnection();
    expect(nextConn.config.url).toBe('http://127.0.0.1:42002');
    await staleRejected;
  });

  it('force-kills hung managed daemons across all tracked spaces on Quit, hides UI immediately, and blocks health recovery', async () => {
    const mainHome = makeTempHome();
    const childHome = makeTempHome();
    mkdirSync(join(mainHome, 'server', 'instances'), { recursive: true });
    mkdirSync(join(childHome, 'server', 'instances'), { recursive: true });
    writeFileSync(join(mainHome, 'server.local-owner'), 'tok-main');
    writeFileSync(join(childHome, 'server.local-owner'), 'tok-child');
    writeFileSync(
      join(mainHome, 'server', 'instances', 'm.json'),
      JSON.stringify({ server_id: 'srv-main', pid: 5101, port: 51001, started_at: 1000 }),
    );
    writeFileSync(
      join(childHome, 'server', 'instances', 'c.json'),
      JSON.stringify({ server_id: 'srv-child', pid: 5202, port: 52002, started_at: 2000 }),
    );

    const alivePids = new Set<number>([5101, 5202]);
    const treeKilledPids: number[] = [];
    const events: string[] = [];
    const lifecycleGetCounts = new Map<number, number>();

    const supervisor = new DaemonSupervisor(
      {
        electronBinary: '/opt/kiki/kiki-desktop',
        serverEntry: '/opt/kiki/server-entry.mjs',
        homeDir: mainHome,
      },
      {
        isPidAlive: (pid) => alivePids.has(pid),
        forceKillPidTree: async (pid) => {
          treeKilledPids.push(pid);
          alivePids.delete(pid);
          events.push(`tree-kill:${pid}`);
        },
        pollIntervalMs: 10,
        quitProbeTimeoutMs: 50,
        shutdownGraceMs: 30,
        fetchFn: async (input, init) => {
          const url = new URL(requestUrlString(input));
          const port = Number(url.port);
          if (url.pathname === '/api/meta') {
            return jsonResponse({
              code: 0,
              data: {
                server_id: port === 51001 ? 'srv-main' : 'srv-child',
                home_id: port === 51001 ? 'main' : 'child',
                desktop_managed: true,
              },
            });
          }
          if (url.pathname === '/api/desktop-lifecycle' && (!init?.method || init.method === 'GET')) {
            lifecycleGetCounts.set(port, (lifecycleGetCounts.get(port) ?? 0) + 1);
            return jsonResponse({
              code: 0,
              data: {
                server_id: port === 51001 ? 'srv-main' : 'srv-child',
                home_id: port === 51001 ? 'main' : 'child',
                managed: true,
                draining: false,
                work_pending: [],
              },
            });
          }
          if (url.pathname === '/api/desktop-lifecycle' && init?.method === 'POST') {
            events.push(`post:${port}`);
            // Simulate t1026: kap-server replies 200 ok BEFORE setImmediate(onShutdown), then hangs forever!
            return jsonResponse({ code: 0, data: { ok: true } });
          }
          return jsonResponse({ code: 1 }, 404);
        },
      },
    );

    await supervisor.discoverConnection();
    supervisor.setTargetHome(childHome, childHome);
    await supervisor.discoverConnection();

    await executeTrayQuit({
      collectPendingWork: () => supervisor.collectManagedQuitPendingWork(),
      beginImmediateQuitUi: () => {
        events.push('hide-windows-immediately');
        supervisor.markShuttingDown();
      },
      stopManagedDaemon: ({ interruptWork }) =>
        supervisor.shutdownAllManagedDaemons({ interruptWork }),
      confirmInterruptPendingWork: async () => true,
      detachDesktop: () => supervisor.detachDesktop(),
      releaseQuit: () => {
        events.push('app-exit-0');
      },
    });

    // Window hides BEFORE waiting on daemon shutdown, GET /api/desktop-lifecycle runs ONLY ONCE per space (zero duplicate round-trip), both hung PIDs are tree-killed, and stale instance records are cleaned!
    expect(events[0]).toBe('hide-windows-immediately');
    expect(events.at(-1)).toBe('app-exit-0');
    expect(lifecycleGetCounts.get(51001)).toBe(1);
    expect(lifecycleGetCounts.get(52002)).toBe(1);
    expect(treeKilledPids.toSorted()).toEqual([5101, 5202]);
    expect(supervisor.isShuttingDown).toBe(true);
    await supervisor.checkHealthAndRecoverIfNeeded();
    await expect(supervisor.discoverConnection()).rejects.toThrow(/shutting down/i);
  });
});
