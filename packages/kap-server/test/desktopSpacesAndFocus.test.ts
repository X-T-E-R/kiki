import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginFocusService, pluginFocusRoute, pluginFocusIsActionable } from '../src/services/pluginFocus/pluginFocusService';
import { PluginFocusPoller } from '../src/services/pluginFocus/pluginFocusPoller';
import { LocalSpacesService } from '../src/services/localSpaces/localSpacesService';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authedFetch } from './helpers/auth';
import { startServer, type RunningServer } from '../src/start';

describe('PluginFocusService', () => {
  it('encodes session routes exactly like the desktop contract', () => {
    expect(pluginFocusRoute('session a')).toBe('/s/session%20a');
    expect(pluginFocusRoute('a/b')).toBe('/s/a%2Fb');
    expect(pluginFocusRoute('')).toBeUndefined();
  });

  it('publishes, reads across homes, and acks only exact matches', () => {
    let now = 5_000;
    const service = new PluginFocusService({ now: () => now });
    const intent = service.publish('space-a', { id: 6, sessionId: 'session-a', at: 5_000 });
    expect(intent).toEqual({ homeId: 'space-a', route: '/s/session-a', requestId: 6 });
    expect(service.read()).toEqual(intent);
    expect(service.read('space-a')).toBeNull();
    expect(service.read('space-b')).toEqual(intent);
    expect(service.acknowledge('space-a', 5)).toBe(false);
    expect(service.acknowledge('space-b', 6)).toBe(false);
    expect(service.acknowledge('space-a', 6)).toBe(true);
    expect(service.read()).toBeNull();
  });

  it('suppresses consumed request ids per home without hiding newer or other-home requests', () => {
    const service = new PluginFocusService({ now: () => 6_000 });
    service.remember('space-a', 4);
    service.remember('space-a', 3);
    expect(service.seenRequestId('space-a')).toBe(4);
    service.publish('space-a', { id: 4, sessionId: 'session-a', at: 5_000 });
    expect(service.read()).toBeNull();
    service.publish('space-a', { id: 5, sessionId: 'session-a', at: 6_000 });
    expect(service.read('space-b')).toMatchObject({ requestId: 5 });
  });

  it('expires pending intents after the ttl window', () => {
    let now = 10_000;
    const service = new PluginFocusService({ now: () => now });
    service.publish('space-a', { id: 7, sessionId: 'session-a', at: 10_000 });
    expect(service.read('space-b')).not.toBeNull();
    now = 19_999;
    expect(service.read('space-b')).not.toBeNull();
    now = 20_000;
    expect(service.read('space-b')).toBeNull();
  });

  it('keeps the ttl actionability helper aligned with the desktop contract', () => {
    const request = { id: 4, sessionId: 'session-a', at: 5_000 };
    expect(pluginFocusIsActionable(request, 3, 14_999)).toBe(true);
    expect(pluginFocusIsActionable(request, 4, 14_999)).toBe(false);
    expect(pluginFocusIsActionable(request, 3, 15_000)).toBe(false);
  });

  it('replaces the pending intent when a newer home publishes', () => {
    const service = new PluginFocusService({ now: () => 2_000 });
    service.publish('space-a', { id: 1, sessionId: 'session-a', at: 1_000 });
    service.publish('space-b', { id: 1, sessionId: 'session-b', at: 2_000 });
    expect(service.read()).toMatchObject({ homeId: 'space-b', route: '/s/session-b' });
    expect(service.acknowledge('space-a', 1)).toBe(false);
    expect(service.read()).toMatchObject({ homeId: 'space-b' });
    expect(service.acknowledge('space-b', 1)).toBe(true);
  });
});

describe('PluginFocusPoller', () => {
  it('publishes the newest actionable sibling navigation request and remembers unusable routes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-plugin-focus-poller-'));
    try {
      const child = join(root, 'child-space');
      await mkdir(child, { recursive: true });
      await writeFile(join(root, 'homes.json'), JSON.stringify([{ id: 'h-child', name: 'Child space', path: child }]));
      const focus = new PluginFocusService({ now: () => 50_000 });
      const navigation = JSON.stringify({ code: 0, data: { request: { id: 9, pluginId: 'kiki-office', sessionId: 'session-x', at: 49_500 } } });
      const fetchImpl: typeof fetch = async () => new Response(navigation, { status: 200, headers: { 'content-type': 'application/json' } });
      const poller = new PluginFocusPoller({
        focus,
        mainHomeDir: root,
        currentSpaceId: 'main',
        serverToken: () => 'test-token',
        fetchImpl,
        now: () => 50_000,
        listInstances: async (homeDir) => homeDir === child ? [{
          serverId: 'server-child', pid: 4321, host: '127.0.0.1', port: 9002,
          startedAt: 1_000, heartbeatAt: 2_000, workspaces: [],
        }] : [],
      });
      await poller.pollOnce();
      const intent = focus.read('main');
      expect(intent).toMatchObject({ route: '/s/session-x', requestId: 9 });
      await poller.stop();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('authenticates each sibling space using its own server.local-owner capability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-plugin-focus-sibling-token-'));
    try {
      const child = join(root, 'child-space');
      await mkdir(child, { recursive: true });
      await writeFile(join(root, 'server.local-owner'), 'main-owner-token');
      await writeFile(join(child, 'server.local-owner'), 'child-owner-token');
      await writeFile(join(root, 'homes.json'), JSON.stringify([{ id: 'h-child', name: 'Child space', path: child }]));
      const seenAuthHeaders: string[] = [];
      const navigation = JSON.stringify({ code: 0, data: { request: { id: 12, pluginId: 'kiki-office', sessionId: 'session-child', at: 49_800 } } });
      const fetchImpl: typeof fetch = async (_url, init) => {
        const headers = new Headers(init?.headers);
        const auth = headers.get('authorization') ?? '';
        seenAuthHeaders.push(auth);
        if (auth !== 'Bearer child-owner-token') {
          return new Response(JSON.stringify({ code: 40101 }), { status: 401 });
        }
        return new Response(navigation, { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const focus = new PluginFocusService({ now: () => 50_000 });
      const poller = new PluginFocusPoller({
        focus,
        mainHomeDir: root,
        currentSpaceId: 'main',
        fetchImpl,
        now: () => 50_000,
        listInstances: async (homeDir) => homeDir === child ? [{
          serverId: 'server-child', pid: 4321, host: '127.0.0.1', port: 9002,
          startedAt: 1_000, heartbeatAt: 2_000, workspaces: [],
        }] : [],
      });
      await poller.pollOnce();
      expect(seenAuthHeaders).toEqual(['Bearer child-owner-token']);
      expect(focus.read('main')).toMatchObject({ homeId: 'h-child', route: '/s/session-child', requestId: 12 });
      await poller.stop();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('aborts an in-flight probe immediately on stop instead of waiting out the timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-plugin-focus-stop-'));
    try {
      const child = join(root, 'child-space');
      await mkdir(child, { recursive: true });
      await writeFile(join(root, 'homes.json'), JSON.stringify([{ id: 'h-child', name: 'Child space', path: child }]));
      const focus = new PluginFocusService({ now: () => 50_000 });
      let probeStarted: (() => void) | undefined;
      const probeStartedPromise = new Promise<void>((resolve) => { probeStarted = resolve; });
      const hangingFetch: typeof fetch = async (_input, init) => {
        probeStarted?.();
        return new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          if (signal !== undefined && signal !== null) {
            if (signal.aborted) {
              reject(new DOMException('aborted', 'AbortError'));
              return;
            }
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
          }
        });
      };
      const poller = new PluginFocusPoller({
        focus,
        mainHomeDir: root,
        currentSpaceId: 'main',
        serverToken: () => 'test-token',
        fetchImpl: hangingFetch,
        now: () => 50_000,
        listInstances: async (homeDir) => homeDir === child ? [{
          serverId: 'server-child', pid: 4321, host: '127.0.0.1', port: 9002,
          startedAt: 1_000, heartbeatAt: 2_000, workspaces: [],
        }] : [],
      });
      const poll = poller.pollOnce();
      await probeStartedPromise;
      const started = Date.now();
      await poller.stop();
      expect(Date.now() - started).toBeLessThan(1_000);
      await poll;
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});

describe('LocalSpacesService', () => {
  it('lists the main space from the instance registry without process inspection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-desktop-spaces-'));
    try {
      const service = new LocalSpacesService({
        mainHomeDir: root,
        currentSpaceId: 'main',
        listInstances: async () => [{
          serverId: 'server-one', pid: 4321, host: '127.0.0.1', port: 9001,
          startedAt: 1_000, heartbeatAt: 2_000, workspaces: [],
        }],
      });
      const snapshot = await service.snapshot();
      expect(snapshot.spaces).toHaveLength(1);
      expect(snapshot.spaces[0]).toMatchObject({
        home_id: 'main', is_primary: true, running: true, pid: 4321, port: 9001,
      });
      expect(snapshot.statuses[0]).toMatchObject({ home_id: 'main', state: 'active', heartbeat_fresh: true });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('marks registered spaces offline when no live instance exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-desktop-spaces-offline-'));
    try {
      const child = join(root, 'child-space');
      await mkdir(child, { recursive: true });
      await writeFile(join(child, 'home.toml'), 'schema = 1\nid = "h-child"\nname = "Child space"\n');
      await writeFile(join(root, 'homes.json'), JSON.stringify([{ id: 'h-child', name: 'Child space', path: child }]));
      const service = new LocalSpacesService({
        mainHomeDir: root, currentSpaceId: 'main',
        listInstances: async () => [],
      });
      const snapshot = await service.snapshot();
      expect(snapshot.spaces).toHaveLength(2);
      const childSummary = snapshot.spaces.find((space) => space.home_id === 'h-child');
      expect(childSummary).toMatchObject({ running: false, name: 'Child space', registered: true });
      const childStatus = snapshot.statuses.find((status) => status.home_id === 'h-child');
      expect(childStatus).toMatchObject({ state: 'offline', heartbeat_fresh: false });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('probes running sibling spaces with their own server.local-owner for busy, needsYou, and desktop_managed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-desktop-spaces-sibling-probe-'));
    try {
      const child = join(root, 'child-space');
      await mkdir(child, { recursive: true });
      await writeFile(join(child, 'home.toml'), 'schema = 1\nid = "h-child"\nname = "Child space"\n');
      await writeFile(join(child, 'server.local-owner'), 'child-secret-token');
      await writeFile(join(root, 'homes.json'), JSON.stringify([{ id: 'h-child', name: 'Child space', path: child }]));
      const fetchImpl: typeof fetch = async (input, init) => {
        const url =
          input instanceof URL
            ? input
            : new URL(typeof input === 'string' ? input : input.url);
        const headers = new Headers(init?.headers);
        if (headers.get('authorization') !== 'Bearer child-secret-token') {
          return new Response(JSON.stringify({ code: 40101 }), { status: 401 });
        }
        if (url.pathname === '/api/desktop-lifecycle') {
          return new Response(JSON.stringify({ code: 0, data: { managed: false } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.pathname === '/api/sessions') {
          return new Response(JSON.stringify({
            code: 0,
            data: {
              items: [
                { id: 'sess-busy', busy: true, pending_interaction: 'none' },
                { id: 'sess-approval', busy: true, pending_interaction: 'approval' },
              ],
              ephemeral: [{ id: 'sess-question', busy: false, pending_interaction: 'question' }],
            },
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      };
      const service = new LocalSpacesService({
        mainHomeDir: root,
        currentSpaceId: 'main',
        desktopManaged: true,
        fetchImpl,
        listInstances: async (homeDir) => homeDir === child ? [{
          serverId: 'server-child', pid: 5678, host: '127.0.0.1', port: 9123,
          startedAt: 1_000, heartbeatAt: 2_000, workspaces: [],
        }] : [{
          serverId: 'server-main', pid: 1234, host: '127.0.0.1', port: 9100,
          startedAt: 1_000, heartbeatAt: 2_000, workspaces: [],
        }],
        readBusySessions: async (homeDir) => homeDir === root ? { busy: 0, needsYou: 0 } : undefined,
      });
      const snapshot = await service.snapshot();
      const childSummary = snapshot.spaces.find((space) => space.home_id === 'h-child');
      expect(childSummary).toMatchObject({ running: true, desktop_managed: false });
      const childStatus = snapshot.statuses.find((status) => status.home_id === 'h-child');
      expect(childStatus).toMatchObject({
        state: 'pending',
        busy_sessions: 1,
        needs_you_sessions: 2,
        needs_you_session_ids: ['sess-approval', 'sess-question'],
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});

describe('desktop spaces and plugin-focus REST routes', () => {
  it('serves spaces snapshot and the plugin focus lifecycle over the envelope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-desktop-spaces-routes-'));
    let server: RunningServer | undefined;
    try {
      server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: root, logLevel: 'silent' });
      const base = `http://127.0.0.1:${server.port}`;
      const spacesResponse = await authedFetch(server, base, '/api/desktop/spaces');
      const spaces = await spacesResponse.json() as {
        code: number;
        data: { spaces: { home_id: string; running: boolean }[]; statuses: { home_id: string; state: string }[] };
      };
      expect(spaces.code).toBe(0);
      expect(spaces.data.spaces.some((space) => space.home_id === 'main')).toBe(true);
      expect(spaces.data.spaces.find((space) => space.home_id === 'main')?.running).toBe(true);
      expect(spaces.data.statuses.find((status) => status.home_id === 'main')?.state).toBe('active');

      const focusRead = await authedFetch(server, base, '/api/desktop/plugin-focus?home_id=main');
      const focus = await focusRead.json() as { code: number; data: { focus: unknown } };
      expect(focus.code).toBe(0);
      expect(focus.data.focus).toBeNull();

      const ack = await authedFetch(server, base, '/api/desktop/plugin-focus/ack', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ home_id: 'main', request_id: 1 }),
      });
      expect(((await ack.json()) as { data: { cleared: boolean } }).data.cleared).toBe(false);

      const remember = await authedFetch(server, base, '/api/desktop/plugin-focus/remember', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ home_id: 'main', request_id: 4 }),
      });
      expect(((await remember.json()) as { data: { remembered: boolean } }).data.remembered).toBe(true);
    } finally {
      await server?.close();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 30_000);
});
