// @vitest-environment jsdom

/**
 * Real end-to-end Multi-Space, Left Sidebar, SpaceSwitchSheet, and In-Place
 * Place Routing integration tests (ESC-20261122-004).
 *
 * ZERO `vi.mock('../state/connection')`! Mounts the REAL `ConnectionProvider`,
 * REAL `NavScopeBoundary`, REAL `App` (`PlaceClientsProvider`, `Sidebar`,
 * `SpaceScopeControl`, `SpaceSwitchSheet`, `PlaceClientProvider`,
 * `SpaceViewState`, and `SessionRouteView`) against a real HTTP fetch router
 * serving Local Home A and brokered Remote Peers B & C via
 * `POST /api/remote-connections/<id>/call`.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONNECTION_PROTOCOL, type MetaResponse, type RemoteConnection, type Session } from '@kiki/protocol';
import {
  readLayoutPreferences,
  resetLayoutPreferencesForTests,
  writeDesktopPrefs,
  writeLayoutPreferences,
} from '@kiki/session-core/settings';
import { activeSpace, configureSpaceStorage } from '@kiki/session-core/storage';

import { App } from '../App';
import { composerInput } from '../components/composerInputTestUtils';
import { NavScopeBoundary } from '../components/NavScopeBoundary';
import { HostProvider } from '../host';
import { I18nProvider } from '../i18n';
import { ConnectionProvider } from './connection';

const LOCAL_ENDPOINT = 'http://local.example.test';
const LOCAL_TOKEN = 'local-test-token';
const LOCAL_HOME_ID = 'home-local-A';
const MAC_CONN_ID = '11111111-1111-4111-8111-111111111111';
const MAC_HOME_ID = 'home-mac-B';
const GPU_CONN_ID = '22222222-2222-4222-8222-222222222222';
const GPU_HOME_ID = 'home-gpu-C';
const SELF_CONN_ID = '33333333-3333-4333-8333-333333333333';

function makeSession(overrides: Partial<Session> & { id: string; title: string; workspace_id: string }): Session {
  const now = new Date().toISOString();
  return {
    id: overrides.id,
    title: overrides.title,
    workspace_id: overrides.workspace_id,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    own_updated_at: overrides.own_updated_at ?? now,
    metadata: overrides.metadata ?? { cwd: `/work/${overrides.workspace_id}` },
    archived: overrides.archived ?? false,
    busy: overrides.busy ?? false,
    executing: overrides.executing ?? overrides.busy ?? false,
    main_turn_active: overrides.main_turn_active ?? overrides.busy ?? false,
    pending_interaction: overrides.pending_interaction ?? 'none',
    last_seq: overrides.last_seq ?? 3,
    last_turn_reason: overrides.last_turn_reason ?? 'completed',
    agent_config: overrides.agent_config ?? {
      model: 'axon/test-model',
      thinking_effort: 'medium',
      permission_mode: 'manual',
      plan_mode: false,
    },
    ephemeral: overrides.ephemeral ?? false,
  } as Session;
}

const LOCAL_SESSIONS: readonly Session[] = [
  makeSession({ id: 'session-L1', title: 'Local Blender MMD Pipeline', workspace_id: 'ws-creator', busy: true }),
  makeSession({ id: 'session-L2', title: 'Local Nia Director Cut', workspace_id: 'ws-nia', busy: true }),
  makeSession({ id: 'session-L3', title: 'Local EasyAgent Triage', workspace_id: 'ws-easy', busy: false }),
];

const MAC_SESSIONS: readonly Session[] = [
  makeSession({ id: 'session-R1', title: 'Mac Swift Metal Shader', workspace_id: 'ws-mac-metal', busy: true }),
  makeSession({ id: 'session-R2', title: 'Mac Xcode Signing Fix', workspace_id: 'ws-mac-ios', busy: false }),
];

const GPU_SESSIONS: readonly Session[] = [
  makeSession({ id: 'session-G1', title: 'Dorm 3090 Ada Mesh Audit', workspace_id: 'ws-gpu-render', busy: true }),
];

const LOCAL_WORKSPACES = [
  { id: 'ws-creator', name: 'Creator', root: 'E:/Creator', pinned: false },
  { id: 'ws-nia', name: 'nia', root: 'E:/nia', pinned: false },
  { id: 'ws-easy', name: 'EasyAgent', root: 'C:/Programs/AI/EasyAgent', pinned: false },
];

const MAC_WORKSPACES = [
  { id: 'ws-mac-metal', name: 'MetalLab', root: '/Users/alice/MetalLab', pinned: false },
  { id: 'ws-mac-ios', name: 'XcodeApp', root: '/Users/alice/XcodeApp', pinned: false },
];

const GPU_WORKSPACES = [
  { id: 'ws-gpu-render', name: 'RenderRig', root: 'D:/RenderRig', pinned: false },
];

const REMOTE_CONNECTIONS: readonly RemoteConnection[] = [
  {
    id: MAC_CONN_ID,
    label: 'MacBook Air',
    endpoint: 'https://mac.example.test:58627',
    target: { homeId: MAC_HOME_ID, hostId: 'host-mac', protocol: CONNECTION_PROTOCOL },
    credentialRef: MAC_CONN_ID,
    enabled: true,
    purposes: ['gui'],
    backgroundSummary: true,
    state: 'online',
    activeLeases: 0,
    rttMs: 38,
    summary: {
      value: { online: true, busy_sessions: 1, needs_you_sessions: 0, revision: 'r1', as_of: Date.now(), platform: 'darwin' },
      lastSeen: Date.now(),
      stale: false,
    },
  },
  {
    id: GPU_CONN_ID,
    label: 'Dorm 3090',
    endpoint: 'https://gpu.example.test:58627',
    target: { homeId: GPU_HOME_ID, hostId: 'host-gpu', protocol: CONNECTION_PROTOCOL },
    credentialRef: GPU_CONN_ID,
    enabled: true,
    purposes: ['gui'],
    backgroundSummary: true,
    state: 'online',
    activeLeases: 0,
    rttMs: 10,
    summary: {
      value: { online: true, busy_sessions: 1, needs_you_sessions: 0, revision: 'r1', as_of: Date.now(), platform: 'win32' },
      lastSeen: Date.now(),
      stale: false,
    },
  },
  // Self-loop record whose target.homeId equals LOCAL_HOME_ID — MUST be discarded!
  {
    id: SELF_CONN_ID,
    label: 'Self Loopback Ghost',
    endpoint: LOCAL_ENDPOINT,
    target: { homeId: LOCAL_HOME_ID, hostId: 'host-self', protocol: CONNECTION_PROTOCOL },
    credentialRef: SELF_CONN_ID,
    enabled: true,
    purposes: ['gui'],
    backgroundSummary: true,
    state: 'online',
    activeLeases: 0,
    rttMs: 1,
  },
];

function makeMeta(homeId: string, serverId: string): MetaResponse {
  return {
    server_id: serverId,
    server_home_id: homeId,
    server_instance_id: `${serverId}-inst`,
    current_space_id: 'main',
    version: '0.6.0-test',
    started_at: new Date().toISOString(),
    capabilities: { terminal: false },
  } as unknown as MetaResponse;
}

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: 0, msg: 'ok', data, request_id: 'req-test' }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function notFound(msg = 'session_not_found'): Response {
  return new Response(JSON.stringify({ code: 40401, msg, data: null, request_id: 'req-test' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = MockWebSocket.CONNECTING;
  url: string;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  private listeners = new Map<string, Set<EventListener>>();

  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      const ev = new Event('open');
      this.onopen?.(ev);
      for (const fn of this.listeners.get('open') ?? []) fn(ev);
    });
  }

  addEventListener(type: string, listener: EventListener): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(): void {}

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }
}

interface RecordedBrokerPrompt {
  readonly connectionId: string;
  readonly sessionId: string;
  readonly body: Record<string, unknown>;
}

function createFakeServer() {
  const recordedBrokerPrompts: RecordedBrokerPrompt[] = [];
  const recordedBrokerCalls: Array<{ connectionId: string; operation: string; params?: Record<string, string>; body?: unknown }> = [];
  const recordedLocalCalls: Array<{ method: string; path: string; body?: unknown }> = [];

  const handleProcedure = (proc: { service?: string; method?: string } | undefined): unknown => {
    const m = proc?.method ?? '';
    if (m === 'listModels') return { items: [{ id: 'axon/test-model', provider_id: 'axon', remote_id: 'test-model', display_name: 'Test Model', max_context_size: 128000, support_efforts: ['medium'], default_effort: 'medium' }] };
    if (m === 'listProviders') return { items: [{ id: 'axon', type: 'openai', configured: true }] };
    if (m === 'listPlugins') return { plugins: [] };
    if (m === 'listMethods') return { methods: [] };
    if (m === 'listModelSwitches') return { items: [] };
    if (m === 'listMcpSessionCapabilities') return { servers: [] };
    if (m === 'read') return { panels: [] };
    return {};
  };

  const handleDomainApi = (
    domain: 'local' | 'mac' | 'gpu',
    operationOrPath: string,
    method: string,
    body: unknown,
    params?: Record<string, string>,
  ): Response => {
    const sessions = domain === 'local' ? LOCAL_SESSIONS : domain === 'mac' ? MAC_SESSIONS : GPU_SESSIONS;
    const workspaces = domain === 'local' ? LOCAL_WORKSPACES : domain === 'mac' ? MAC_WORKSPACES : GPU_WORKSPACES;
    const meta = domain === 'local'
      ? makeMeta(LOCAL_HOME_ID, 'srv-local')
      : domain === 'mac'
        ? makeMeta(MAC_HOME_ID, 'srv-mac')
        : makeMeta(GPU_HOME_ID, 'srv-gpu');

    if (operationOrPath === 'meta' || operationOrPath === '/api/meta') return envelope(meta);
    if (operationOrPath === 'sessions' || operationOrPath === '/api/sessions') {
      return envelope({ items: sessions, has_more: false });
    }
    if (operationOrPath === 'ephemeralSessions' || operationOrPath === '/api/sessions/ephemeral') {
      return envelope({ items: [], has_more: false });
    }
    if (operationOrPath === 'workspaces' || operationOrPath === '/api/workspaces/catalog' || operationOrPath === '/api/workspaces') {
      return envelope({ items: workspaces });
    }
    if (operationOrPath === 'rooms' || operationOrPath === 'roomItems' || operationOrPath === '/api/rooms/items' || operationOrPath === '/api/rooms' || operationOrPath === 'bots' || operationOrPath === '/api/bots') {
      return envelope([]);
    }
    if (operationOrPath === 'session') {
      const hit = sessions.find((s) => s.id === params?.['sessionId']);
      return hit !== undefined ? envelope(hit) : notFound();
    }
    if (operationOrPath === 'prompt') {
      const sid = params?.['sessionId'] ?? '';
      const payload = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
      if (domain !== 'local') {
        recordedBrokerPrompts.push({
          connectionId: domain === 'mac' ? MAC_CONN_ID : GPU_CONN_ID,
          sessionId: sid,
          body: payload,
        });
      }
      return envelope({
        prompt_id: (payload['prompt_id'] as string | undefined) ?? 'prompt-durable-1',
        user_message_id: 'msg-r1-durable-1',
        status: 'queued',
        admission: payload['admission'] === 'durable' ? 'admitted' : undefined,
        content: Array.isArray(payload['content']) ? payload['content'] : [{ type: 'text', text: '' }],
        created_at: new Date().toISOString(),
      });
    }
    if (operationOrPath === 'snapshot') {
      const sid = params?.['sessionId'] ?? '';
      const hit = sessions.find((s) => s.id === sid);
      return envelope({
        as_of_seq: 3,
        epoch: 'epoch-1',
        session: hit ?? makeSession({ id: sid, title: sid, workspace_id: workspaces[0]!.id }),
        messages: { items: [], has_more: false },
        in_flight_turn: null,
        subagents: [],
        pending_approvals: [],
        pending_questions: [],
      });
    }
    if (operationOrPath === 'transcript') {
      const sid = params?.['sessionId'] ?? '';
      return envelope({
        agent_id: 'main',
        session_id: sid,
        items: [],
        has_more: false,
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
        agents: [{ agentId: 'main', type: 'main' }],
        pending_interactions: [],
        seq: 3,
        cursor: { seq: 3, epoch: 'epoch-1' },
        coverage: { kind: 'full', hasMoreOlder: false },
        transcript_coverage_version: 2,
      });
    }
    if (operationOrPath === 'config' || operationOrPath === '/api/config') {
      return envelope({ default_model: 'axon/test-model', providers: {}, models: {} });
    }
    if (operationOrPath === 'models' || operationOrPath === '/api/models') {
      return envelope({ items: [{ alias: 'axon/test-model', id: 'test-model', provider: 'axon', label: 'Test Model', capabilities: ['thinking'] }] });
    }
    if (operationOrPath === 'providers' || operationOrPath === '/api/providers') {
      return envelope({ items: [] });
    }
    if (operationOrPath === 'profiles' || operationOrPath === '/api/profiles' || operationOrPath === 'agentProfiles' || operationOrPath === '/api/agent-profiles') {
      return envelope({ items: [] });
    }
    if (operationOrPath === 'personas' || operationOrPath === '/api/personas') {
      return envelope([]);
    }
    if (operationOrPath === 'plugins' || operationOrPath === 'pluginUsage' || operationOrPath === '/api/plugins' || operationOrPath === '/api/plugins/ui' || operationOrPath.includes('plugin')) {
      return envelope({ plugins: [], items: [], panels: [], slots: [], capsules: [] });
    }
    if (operationOrPath === 'skills' || operationOrPath === '/api/skills') {
      return envelope({ items: [] });
    }
    if (operationOrPath === 'appearancePacks' || operationOrPath === '/api/appearance/packs') {
      return envelope({ items: [] });
    }
    if (operationOrPath === 'skins' || operationOrPath === '/api/skins') {
      return envelope({ items: [] });
    }
    if (operationOrPath === 'workPresets' || operationOrPath === '/api/work-presets') {
      return envelope({ enabled: false, items: [] });
    }
    if (operationOrPath === 'prompts') {
      return envelope({ active: null, queued: [] });
    }
    if (operationOrPath === 'approvals' || operationOrPath === 'questions' || operationOrPath === 'taskList' || operationOrPath === 'agentTaskList' || operationOrPath === 'subagents' || operationOrPath === 'terminals' || operationOrPath === 'userMessages' || operationOrPath === 'agentHooks' || operationOrPath === 'tools' || operationOrPath === '/api/tools' || operationOrPath === 'auth' || operationOrPath === '/api/auth' || operationOrPath === 'worktrees' || operationOrPath === '/api/worktrees') {
      return envelope({ items: [] });
    }
    if (operationOrPath === 'optionalCapabilities') {
      return envelope({ items: [] });
    }
    if (operationOrPath === 'goal') {
      return envelope(null);
    }
    if (operationOrPath === 'context' || operationOrPath === 'metrics') {
      return envelope({});
    }
    if (operationOrPath === 'procedure' || operationOrPath === '/api/klient/call') {
      const payload = (body && typeof body === 'object' ? body : {}) as { procedure?: { service?: string; method?: string } };
      return envelope(handleProcedure(payload.procedure));
    }
    if (operationOrPath === 'procedureBatch' || operationOrPath === '/api/klient/batch') {
      const payload = (body && typeof body === 'object' ? body : {}) as { calls?: Array<{ id: string; procedure?: { service?: string; method?: string } }> };
      return envelope({
        results: (payload.calls ?? []).map((call) => ({ id: call.id, ok: true, result: handleProcedure(call.procedure) })),
      });
    }
    if (operationOrPath.startsWith('/api/sessions/')) {
      const rest = operationOrPath.slice('/api/sessions/'.length).split('/').filter(Boolean);
      const sid = decodeURIComponent(rest[0] ?? '');
      if (rest.length === 1 && method === 'GET') {
        const hit = sessions.find((s) => s.id === sid);
        return hit !== undefined ? envelope(hit) : notFound();
      }
      const sub = rest[1];
      if (sub === 'prompts') {
        return envelope({ active: null, queued: [] });
      }
      if (sub === 'tasks' || sub === 'approvals' || sub === 'questions' || sub === 'subagents' || sub === 'terminals' || sub === 'agents' || sub === 'messages') {
        return envelope({ items: [] });
      }
      if (sub === 'snapshot') {
        const hit = sessions.find((s) => s.id === sid);
        return envelope({
          session: hit ?? makeSession({ id: sid, title: sid, workspace_id: workspaces[0]!.id }),
          agents: [{ id: 'main', label: 'Main', status: 'idle', is_main: true }],
          last_seq: 3,
          stream_epoch: 'epoch-1',
          turns: [],
          tasks: [],
          todos: [],
          approvals: [],
          questions: [],
          prompts: [],
          transcript: { items: [], has_more: false, head_seq: 3, epoch: 'epoch-1' },
        });
      }
    }
    return envelope({ items: [] });
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl, LOCAL_ENDPOINT);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const pathname = url.pathname;

    // Local control-plane endpoints
    if (pathname === '/api/remote-connections' && method === 'GET') {
      return envelope(REMOTE_CONNECTIONS);
    }
    if (pathname === '/api/remote-connections/handshake' && method === 'GET') {
      return envelope({ targetLabel: 'Workstation Win11', homeId: LOCAL_HOME_ID });
    }
    if (pathname === '/api/homes' && method === 'GET') {
      return envelope({
        items: [
          { id: 'main', name: 'Main space', path: 'C:/Users/example/.kiki', primary: true },
          { id: 'h-nia', name: 'Nia Whisper Tavern', color: '#945439', path: 'C:/Users/example/.kiki-spaces/nia', primary: false },
        ],
      });
    }
    if (/^\/api\/homes\/[^/]+\/settings$/.test(pathname) && method === 'GET') {
      return envelope({
        space_id: 'main',
        items: [],
        preferences: { theme: 'light', locale: 'zh', skin: 'default' },
      });
    }
    if (/^\/api\/homes\/[^/]+\/settings\/import-preferences$/.test(pathname) && method === 'POST') {
      return envelope({
        imported: false,
        conflict: false,
        detail: { space_id: 'main', items: [], preferences: { theme: 'light', locale: 'zh', skin: 'default' } },
      });
    }
    if (pathname === '/api/plugin-navigation') {
      return envelope({ request: undefined });
    }
    if (pathname === '/api/auth/web-access/status') {
      return envelope({ authenticated: false });
    }

    // Brokered remote call: POST /api/remote-connections/<connectionId>/call
    const brokerMatch = /^\/api\/remote-connections\/([^/]+)\/call$/.exec(pathname);
    if (brokerMatch !== null && method === 'POST') {
      const connId = decodeURIComponent(brokerMatch[1]!);
      const payload = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { operation: string; params?: Record<string, string>; body?: unknown }
        : { operation: '' };
      const domain = connId === MAC_CONN_ID ? 'mac' : connId === GPU_CONN_ID ? 'gpu' : null;
      if (domain === null) return notFound('connection_not_found');
      recordedBrokerCalls.push({ connectionId: connId, operation: payload.operation, params: payload.params, body: payload.body });
      return handleDomainApi(domain, payload.operation, 'POST', payload.body, payload.params);
    }

    const parsedBody = typeof init?.body === 'string' ? (() => { try { return JSON.parse(init.body) as unknown; } catch { return undefined; } })() : undefined;
    recordedLocalCalls.push({ method, path: pathname, body: parsedBody });
    return handleDomainApi('local', pathname, method, parsedBody);
  };

  return { fetchImpl, recordedBrokerPrompts, recordedBrokerCalls, recordedLocalCalls };
}

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
let root: Root | undefined;
let container: HTMLDivElement | undefined;
let router: ReturnType<typeof createMemoryRouter> | undefined;
let originalFetch: typeof fetch;
let originalWebSocket: typeof WebSocket;

async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
  }
}

beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
  originalFetch = globalThis.fetch;
  originalWebSocket = globalThis.WebSocket;
  vi.stubGlobal('__KIKI_PROXY_TARGET__', 'http://127.0.0.1:58627');
  vi.stubGlobal('navigator', { language: 'zh-CN', onLine: true });
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('min-width: 1360px') || query.includes('min-width: 768px'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })),
  });
});

afterAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = false;
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  vi.unstubAllGlobals();
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetLayoutPreferencesForTests();
  configureSpaceStorage(null);
  writeDesktopPrefs({ windowMode: 'windows' });
  writeLayoutPreferences({ spaceScope: 'all', sidebarMode: 'inbox' });
  localStorage.setItem('kiki.connection', JSON.stringify({ url: LOCAL_ENDPOINT, token: LOCAL_TOKEN }));
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  router?.dispose();
  router = undefined;
  container?.remove();
  container = undefined;
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  configureSpaceStorage(null);
});

describe('Real ConnectionProvider + App multi-space & in-place place routing (zero connection mock)', () => {
  it('never duplicates local sessions under paired remote computers, keeps SpaceSwitchSheet clean, routes R1 to /p/<id>/s/R1 in-place, and submits durable prompts on first try', async () => {
    const server = createFakeServer();
    globalThis.fetch = server.fetchImpl;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    router = createMemoryRouter(
      [{ path: '*', element: <NavScopeBoundary><App /></NavScopeBoundary> }],
      { initialEntries: ['/new'] },
    );

    await act(async () => {
      root!.render(
        <HostProvider>
          <I18nProvider>
            <ConnectionProvider>
              <RouterProvider router={router!} />
            </ConnectionProvider>
          </I18nProvider>
        </HostProvider>,
      );
    });
    await settle(12);

    // 1. Verify Inbox (`待办` -> `工作中`) shows Local L1, L2 + Mac R1 + Dorm 3090 G1 with ZERO duplicates!
    const workingRows = [...document.querySelectorAll<HTMLElement>('[data-inbox-bucket="working"]')];
    const workingIds = workingRows.map((el) => `${el.dataset['inboxSpace']}::${el.dataset['inboxRow']}`);
    expect(workingIds).toEqual(expect.arrayContaining([
      'main::session-L1',
      'main::session-L2',
      `remote:${MAC_CONN_ID}::session-R1`,
      `remote:${GPU_CONN_ID}::session-G1`,
    ]));
    // Zero local sessions duplicated under MacBook Air or Dorm 3090, and zero self-loop ghost!
    expect(workingIds.filter((id) => id.includes('session-L1'))).toHaveLength(1);
    expect(workingIds.filter((id) => id.includes('session-L2'))).toHaveLength(1);
    expect(workingIds.some((id) => id.includes(SELF_CONN_ID))).toBe(false);

    // Verify clean row metadata in `工作中`: no redundant `运行中`, no `主空间` on local rows, remote computer label on remote rows!
    const localL1Row = document.querySelector<HTMLElement>('[data-inbox-row="session-L1"]')!;
    expect(localL1Row.querySelector('[data-inbox-meta]')?.textContent).not.toContain('运行中');
    expect(localL1Row.querySelector('[data-inbox-space-label]')).toBeNull();
    const macR1Row = document.querySelector<HTMLElement>('[data-inbox-row="session-R1"]')!;
    expect(macR1Row.querySelector('[data-inbox-meta]')?.textContent).not.toContain('运行中');
    expect(macR1Row.querySelector('[data-inbox-space-label]')?.textContent).toBe('MacBook Air');

    // 2. Open SpaceSwitchSheet and verify subtraction-first DOM invariants.
    const switcher = document.querySelector<HTMLButtonElement>('[data-space-switcher]')!;
    expect(switcher.querySelector('[data-space-scope-pill="all"]')?.textContent).toContain('所有电脑');
    await act(async () => { switcher.click(); });
    await settle(4);
    const menu = document.querySelector<HTMLElement>('[data-space-switcher-menu]')!;
    expect(menu).not.toBeNull();
    expect(menu.textContent).not.toContain('另一个空间');
    expect(menu.textContent).not.toContain('在新窗口打开');
    expect(menu.textContent).not.toContain('⌃⌥');
    expect(menu.textContent).not.toContain('Self Loopback Ghost');
    expect(menu.querySelector(`[data-space-remote-item="${MAC_CONN_ID}"]`)?.textContent).toBe('MacBook Air');
    expect(menu.querySelector(`[data-space-remote-item="${GPU_CONN_ID}"]`)?.textContent).toBe('Dorm 3090');

    // 3. Switch spaceScope to MacBook Air (0ms view filter) and verify L1..L3 NEVER appear under MacBook Air!
    await act(async () => {
      menu.querySelector<HTMLButtonElement>(`[data-space-remote-item="${MAC_CONN_ID}"]`)!.click();
    });
    await settle(4);
    expect(readLayoutPreferences().spaceScope).toBe(`remote:${MAC_CONN_ID}`);
    // Root window connection stayed local — activeSpace() was NEVER mutated to `remote:...`!
    expect(activeSpace()).toBeNull();
    const macOnlyRows = [...document.querySelectorAll<HTMLElement>('[data-inbox-row]')].map((el) => el.dataset['inboxRow']);
    expect(macOnlyRows).toContain('session-R1');
    expect(macOnlyRows).not.toContain('session-L1');
    expect(macOnlyRows).not.toContain('session-L2');
    expect(macOnlyRows).not.toContain('session-G1');

    // Switch to This computer -> only local sessions appear, zero Mac sessions!
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switcher]')!.click(); });
    await settle(2);
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-computer-local]')!.click(); });
    await settle(4);
    const localOnlyRows = [...document.querySelectorAll<HTMLElement>('[data-inbox-row]')].map((el) => el.dataset['inboxRow']);
    expect(localOnlyRows).toContain('session-L1');
    expect(localOnlyRows).not.toContain('session-R1');

    // B1 regression: switch to `会话` while scoped to This computer (`local:main`) ->
    // running count pill MUST reflect the 2 local running sessions (L1, L2), not drop to 0!
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-sidebar-mode="sessions"]')!.click();
    });
    await settle(4);
    const localRunningPill = document.querySelector<HTMLButtonElement>('[data-status-shortcut="running"]');
    expect(localRunningPill).not.toBeNull();
    expect(localRunningPill!.textContent?.trim()).toBe('2');

    // Return to All computers -> unified multi-computer Sessions list + running count = 4 (L1, L2, R1, G1)!
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-switcher]')!.click(); });
    await settle(2);
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-space-scope-all]')!.click(); });
    await settle(4);
    const allRunningPill = document.querySelector<HTMLButtonElement>('[data-status-shortcut="running"]');
    expect(allRunningPill?.textContent?.trim()).toBe('4');
    const sessionRowIds = [...document.querySelectorAll<HTMLElement>('[data-session-row]')].map((el) => el.dataset['sessionRow']);
    expect(sessionRowIds).toEqual(expect.arrayContaining(['session-L1', 'session-L2', 'session-L3', 'session-R1', 'session-R2', 'session-G1']));

    // B2 regression: /new HeroSpaceChip filters self-loop peers and routes in-place to /p/<id>/new (never mutating root connection)!
    const heroSpaceBtn = document.querySelector<HTMLButtonElement>('[data-hero-target-space]');
    expect(heroSpaceBtn).not.toBeNull();
    await act(async () => { heroSpaceBtn!.click(); });
    await settle(4);
    const heroMenu = document.querySelector<HTMLElement>('[data-hero-space-menu]');
    expect(heroMenu).not.toBeNull();
    expect(heroMenu!.textContent).not.toContain('Self Loopback Ghost');
    await act(async () => {
      heroMenu!.querySelector<HTMLButtonElement>(`[data-hero-space-option="remote:${MAC_CONN_ID}"]`)!.click();
    });
    await settle(8);
    expect(router!.state.location.pathname).toBe(`/p/${MAC_CONN_ID}/new`);
    expect(activeSpace()).toBeNull();
    // On /p/<MAC_CONN_ID>/new inside PlaceClientProvider, HeroSpaceChip MUST still
    // label itself "MacBook Air" (not "主空间") and still filter out Self Loopback Ghost!
    const remoteHeroSpaceBtn = document.querySelector<HTMLButtonElement>('[data-hero-target-space]');
    expect(remoteHeroSpaceBtn).not.toBeNull();
    expect(remoteHeroSpaceBtn!.textContent).toContain('MacBook Air');
    await act(async () => { remoteHeroSpaceBtn!.click(); });
    await settle(4);
    const remoteHeroMenu = document.querySelector<HTMLElement>('[data-hero-space-menu]');
    expect(remoteHeroMenu).not.toBeNull();
    expect(remoteHeroMenu!.textContent).toContain('MacBook Air');
    expect(remoteHeroMenu!.textContent).not.toContain('Self Loopback Ghost');
    // Switch back to local /new via HeroSpaceChip without legacy scope handoff.
    await act(async () => {
      remoteHeroMenu!.querySelector<HTMLButtonElement>('[data-hero-space-option="local:main"]')!.click();
    });
    await settle(6);
    expect(router!.state.location.pathname).toBe('/new');
    expect(activeSpace()).toBeNull();

    // B3 regression: remote session row context menu keeps remote-safe actions (pin/rename/private/copy-link/archive)
    // and suppresses local-only actions (branch/fork/more/open-folder/join-room) so no remote ID misroutes locally!
    const r1RowEl = document.querySelector<HTMLElement>('[data-session-row="session-R1"]');
    expect(r1RowEl).not.toBeNull();
    await act(async () => {
      r1RowEl!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 80 }));
    });
    await settle(4);
    const r1Menu = document.querySelector<HTMLElement>('[data-session-menu]');
    expect(r1Menu).not.toBeNull();
    expect(r1Menu!.querySelector('[data-menu-item="pin"]')).not.toBeNull();
    expect(r1Menu!.querySelector('[data-menu-item="rename"]')).not.toBeNull();
    expect(r1Menu!.querySelector('[data-menu-item="private"]')).not.toBeNull();
    expect(r1Menu!.querySelector('[data-menu-item="copy-link"]')).not.toBeNull();
    expect(r1Menu!.querySelector('[data-menu-item="archive"]')).not.toBeNull();
    expect(r1Menu!.querySelector('[data-menu-item="branch"]')).toBeNull();
    expect(r1Menu!.querySelector('[data-menu-item="fork"]')).toBeNull();
    expect(r1Menu!.querySelector('[data-menu-item="more"]')).toBeNull();
    expect(r1Menu!.querySelector('[data-menu-item="open-folder"]')).toBeNull();
    expect(r1Menu!.querySelector('[data-menu-item="join-room"]')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle(2);

    // 4. Click Mac session R1 -> opens `/p/<MAC_CONN_ID>/s/session-R1` in-place via PlaceClientProvider!
    const r1Button = document.querySelector<HTMLButtonElement>('[data-session-row="session-R1"] button')!;
    await act(async () => { r1Button.click(); });
    await settle(10);

    expect(router!.state.location.pathname).toBe(`/p/${MAC_CONN_ID}/s/session-R1`);
    // Active highlight in unified Sessions tab matches `/p/<MAC_CONN_ID>/s/session-R1`!
    expect(document.querySelector('[data-session-row="session-R1"] button')?.getAttribute('aria-current')).toBe('page');
    // Root local storage was NEVER polluted with `remote:<id>`!
    expect(activeSpace()).toBeNull();

    // 5. Submit a prompt in remote session R1 -> MUST send `admission: 'durable'` on the FIRST try!
    const input = composerInput(container!);
    await act(async () => {
      input.focus();
      input.value = 'Check Metal shader compile status';
    });
    await settle(6);
    const sendBtn = document.querySelector<HTMLButtonElement>('button[data-send-ready]');
    expect(sendBtn).not.toBeNull();
    expect(sendBtn!.disabled).toBe(false);
    await act(async () => { sendBtn!.click(); });
    await settle(10);

    expect(server.recordedBrokerPrompts).toHaveLength(1);
    const firstPrompt = server.recordedBrokerPrompts[0]!;
    expect(firstPrompt.connectionId).toBe(MAC_CONN_ID);
    expect(firstPrompt.sessionId).toBe('session-R1');
    expect(firstPrompt.body['admission']).toBe('durable');
  }, 30_000);
});
