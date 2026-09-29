import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IAgentLifecycleService, IAgentRuntimeService, ISessionApprovalService, ISessionInteractionService,
  ISessionManager, ISessionStateService,
  ISshHostService, sessionSshHostsKey, type Scope,
} from '@kiki/agent-core-v2';
import { SessionStateService } from '@kiki/agent-core-v2/session/state/sessionStateService';
import { ErrorCode } from '@kiki/protocol';

import { registerSshRoutes } from '../src/routes/ssh';
import { startServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

type Route = (req: { id: string; params: { id: string; tail?: string }; body: unknown; query: { workspace_id?: string } }, reply: { send: (value: unknown) => void }) => Promise<void> | void;

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kiki-ssh-rest-'));
  vi.stubEnv('KIKI_HOME', home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('SSH management REST routes', () => {
  it('lists and edits a workspace host without establishing a connection', async () => {
    const routes = new Map<string, Route>();
    const app = Object.fromEntries(['get', 'put', 'post', 'delete'].map((verb) => [verb,
      (path: string, _options: unknown, handler: Route) => { routes.set(`${verb.toUpperCase()} ${path}`, handler); },
    ]));
    let record = { id: 'dev', name: 'Dev', source: 'kiki' as const, roots: ['/home/tester'] };
    const hosts = {
      list: vi.fn(async () => [record]),
      discover: vi.fn(async () => [record]),
      upsert: vi.fn(async (input: { id: string; name: string; roots: string[] }) => { record = { ...record, ...input }; }),
      remove: vi.fn(async () => undefined),
      setSyncSshConfig: vi.fn(async () => undefined),
      connectionApprovalEnabled: vi.fn(async () => false),
      setConnectionApproval: vi.fn(async () => undefined),
      writeBack: vi.fn(async () => undefined),
      status: vi.fn(() => ({ hostId: 'dev', state: 'idle', generation: 0 })),
      disconnect: vi.fn(async () => undefined),
      connect: vi.fn(async () => { throw new Error('unexpected network connection'); }),
    };
    const scope = { accessor: { get: (token: unknown) => {
      if (token === ISessionManager) return {};
      expect(token).toBe(ISshHostService);
      return hosts;
    } } } as unknown as Scope;
    registerSshRoutes(app as unknown as Parameters<typeof registerSshRoutes>[0], scope);
    const request = async (method: string, path: string, body?: unknown, id = 'dev', workspace_id?: string) => {
      let response: unknown;
      const handler = routes.get(`${method} ${path}`);
      if (handler === undefined) throw new Error(`Missing ${method} ${path}`);
      await handler({ id: 'req', params: { id, tail: id }, body, query: { workspace_id } }, { send: (value) => { response = value; } });
      return response as { code: number; data: unknown };
    };
    const updated = await request('PUT', '/ssh/hosts/:id', { name: 'Updated', roots: ['/home/tester'] }, 'dev', 'workspace-1');
    expect(updated.data).toMatchObject({ host: { name: 'Updated' } });
    expect(hosts.upsert).toHaveBeenCalledWith({ id: 'dev', name: 'Updated', roots: ['/home/tester'] }, 'workspace-1');
    expect((await request('GET', '/ssh/hosts')).data).toMatchObject({ hosts: [{ id: 'dev' }] });
    expect((await request('GET', '/ssh/hosts/:tail', undefined, 'dev:status')).data).toMatchObject({ state: 'idle', generation: 0 });
    expect((await request('GET', '/ssh/hosts/:tail', undefined, 'absent:status')).code).toBe(ErrorCode.SSH_HOST_NOT_FOUND);
    expect((await request('GET', '/ssh/hosts::discover')).data).toMatchObject({ hosts: [{ id: 'dev' }] });
    expect((await request('PUT', '/ssh/config-sync', { enabled: false })).data).toEqual({ enabled: false });
    expect(hosts.setSyncSshConfig).toHaveBeenCalledWith(false);
    expect((await request('GET', '/ssh/connection-approval')).data).toEqual({ enabled: false });
    expect((await request('PUT', '/ssh/connection-approval', { enabled: true })).data).toEqual({ enabled: true });
    expect(hosts.setConnectionApproval).toHaveBeenCalledWith(true);
    expect((await request('POST', '/ssh/hosts/:tail', undefined, 'dev:write-back')).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(hosts.writeBack).not.toHaveBeenCalled();
    expect((await request('POST', '/ssh/hosts/:tail', undefined, 'dev:disconnect')).data).toEqual({ disconnected: true });
    expect(hosts.disconnect).toHaveBeenCalledWith('dev', undefined);
    expect((await request('DELETE', '/ssh/hosts/:id')).data).toEqual({ removed: true });
    expect(hosts.remove).toHaveBeenCalledWith('dev', undefined);
    expect(hosts.connect).not.toHaveBeenCalled();
  });

  it('joins and removes only this session, rechecks config retargeting, and never connects', async () => {
    const routes = new Map<string, Route>();
    const routeOptions = new Map<string, { preHandler: Array<(req: unknown, reply: unknown, done: () => void) => void> }>();
    const app = Object.fromEntries(['get', 'put', 'post', 'delete'].map((verb) => [verb,
      (path: string, options: { preHandler: Array<(req: unknown, reply: unknown, done: () => void) => void> }, handler: Route) => {
        routes.set(`${verb.toUpperCase()} ${path}`, handler);
        routeOptions.set(`${verb.toUpperCase()} ${path}`, options);
      },
    ]));
    const state = new SessionStateService();
    state.contributeState(sessionSshHostsKey);
    const host = { id: 'dev', name: 'Dev', source: 'kiki' as const };
    const hosts = {
      list: vi.fn(async () => [host]),
      resolveTarget: vi.fn(async () => ({ hostname: 'dev.example.test', user: 'tester', port: 22, identityFiles: [], userKnownHostsFiles: [] })),
      status: vi.fn(() => ({ hostId: 'dev', state: 'idle', generation: 0 })),
      removeTransient: vi.fn(async () => undefined),
      connect: vi.fn(),
    };
    const release = vi.fn();
    const decideSsh = vi.fn();
    const agent = { accessor: { get: (token: unknown) => {
      expect(token).toBe(IAgentRuntimeService);
      return { inspect: () => ({ identity: { workspaceId: 'workspace' } }) };
    } } };
    const session = { accessor: { get: (token: unknown) => {
      if (token === IAgentLifecycleService) return { create: async () => agent };
      if (token === ISessionStateService) return state;
      if (token === ISessionApprovalService) return { decideSsh };
      if (token === ISessionInteractionService) return { listPending: () => [{ id: 'ssh-approval', payload: { ssh: { kind: 'login' } } }] };
      throw new Error('unexpected service');
    } } };
    const core = { accessor: { get: (token: unknown) => {
      if (token === ISshHostService) return hosts;
      if (token === ISessionManager) return { acquire: async () => ({ handle: session, dispose: release }) };
      throw new Error('unexpected service');
    } } } as unknown as Scope;
    registerSshRoutes(app as unknown as Parameters<typeof registerSshRoutes>[0], core);
    const request = async (method: string, host_id = 'dev') => {
      let response: unknown;
      const suffix = method === 'GET' ? '' : '/:host_id';
      const route = routes.get(`${method} /sessions/:session_id/ssh/hosts${suffix}`);
      if (route === undefined) throw new Error('Missing session SSH route');
      await route({ id: 'req', params: { session_id: 'session', host_id } as never, body: {}, query: {} },
        { send: (value) => { response = value; } });
      return response as { code: number; data: { hosts?: unknown[] } };
    };
    expect((await request('GET')).data.hosts).toEqual([]);
    expect((await request('PUT')).data).toMatchObject({ host });
    expect((await request('GET')).data.hosts).toMatchObject([{ host, status: { state: 'idle' } }]);
    expect(state.get(sessionSshHostsKey)['dev']).toContain('dev.example.test');
    await request('DELETE');
    const validateHostId = routeOptions.get('DELETE /sessions/:session_id/ssh/hosts/:host_id')!.preHandler[0]!;
    const accepted = vi.fn();
    validateHostId({ id: 'req', params: { session_id: 'session', host_id: 'tester@example.test:2202' } },
      { send: vi.fn() }, accepted);
    expect(accepted).toHaveBeenCalledOnce();
    await request('DELETE', 'tester@example.test:2202');
    expect(hosts.removeTransient).toHaveBeenCalledWith('tester@example.test:2202', 'workspace', 'session');
    expect((await request('GET')).data.hosts).toEqual([]);
    vi.mocked(hosts.resolveTarget).mockResolvedValueOnce({ hostname: 'dev.example.test', user: 'tester', port: 22, identityFiles: [], userKnownHostsFiles: [] });
    vi.mocked(hosts.resolveTarget).mockResolvedValueOnce({ hostname: 'redirect.example.test', user: 'tester', port: 22, identityFiles: [], userKnownHostsFiles: [] });
    expect((await request('PUT')).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(state.get(sessionSshHostsKey)).toEqual({});
    expect(hosts.connect).not.toHaveBeenCalled();
    let secretResponse: unknown;
    const submit = routes.get('POST /sessions/:session_id/ssh/approvals/:approval_id')!;
    const secret = 'TEST_ONLY_SECRET_51e84d';
    await submit({ id: 'req', params: { session_id: 'session', approval_id: 'ssh-approval' } as never,
      body: { decision: 'approved', credential: { password: secret, save: 'session' } }, query: {} },
    { send: (value) => { secretResponse = value; } });
    expect(JSON.stringify(secretResponse)).not.toContain(secret);
    expect(decideSsh).toHaveBeenCalledWith('ssh-approval', { decision: 'approved' }, { password: secret, save: 'session' });
    expect(release).toHaveBeenCalledTimes(8);
    state.dispose();
  });

  it('clears temporary hosts on close, eviction, and deletion', async () => {
    const listeners: { close?: (event: never) => void; evict?: (event: never) => void; delete?: (event: never) => void } = {};
    const hosts = { removeSessionTransients: vi.fn(async (_sessionId: string) => undefined) };
    const manager = {
      onWillCloseSession: (listener: (event: never) => void) => { listeners.close = listener; },
      onDidCloseSession: (listener: (event: never) => void) => { listeners.evict = listener; },
      onDidDeleteSession: (listener: (event: never) => void) => { listeners.delete = listener; },
    };
    const core = { accessor: { get: (token: unknown) => token === ISessionManager ? manager : hosts } } as unknown as Scope;
    const app = Object.fromEntries(['get', 'put', 'post', 'delete'].map((verb) => [verb, () => undefined]));
    registerSshRoutes(app as unknown as Parameters<typeof registerSshRoutes>[0], core);
    let cleanup: Promise<void> | undefined;
    listeners.close!({ sessionId: 'session-1', waitUntil: (promise: Promise<void>) => { cleanup = promise; } } as never);
    await cleanup;
    listeners.evict!({ sessionId: 'session-2', reason: 'evict' } as never);
    listeners.delete!({ sessionId: 'session-3' } as never);
    await vi.waitFor(() => expect(hosts.removeSessionTransients).toHaveBeenCalledTimes(3));
    expect(hosts.removeSessionTransients.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      'session-1', 'session-2', 'session-3',
    ]);
  });

  it('matches all SSH host actions through a real Fastify server', async () => {
    await mkdir(join(home, 'ssh'));
    await writeFile(join(home, 'ssh', 'hosts.toml'), 'sync_ssh_config = false\n[hosts.dev]\nname = "Dev"\nroots = ["/tmp"]\n');
    const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0,
      homeDir: home, logLevel: 'silent' });
    const base = `http://127.0.0.1:${server.port}`;
    const request = async (path: string, method = 'GET', body?: unknown) => {
      const response = await authedFetch(server, base, path, { method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ code: number; msg: string; data: Record<string, unknown> }>;
    };
    try {
      const listed = await request('/api/ssh/hosts');
      expect(listed.data['hosts']).toEqual([expect.objectContaining({ id: 'dev', source: 'kiki' })]);
      const status = await request('/api/ssh/hosts/dev:status');
      expect(status.code, status.msg).toBe(0);
      expect(status.data).toMatchObject({ hostId: 'dev', state: 'idle' });
      expect((await request('/api/ssh/hosts:discover')).code).toBe(0);
      expect((await authedFetch(server, base, '/api/ssh/hosts:other')).status).toBe(404);
      const disconnected = await request('/api/ssh/hosts/dev:disconnect', 'POST');
      expect(disconnected).toMatchObject({ code: 0, data: { disconnected: true } });
      const writeBack = await request('/api/ssh/hosts/dev:write-back', 'POST');
      expect(writeBack.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(writeBack.msg).toContain('explicit hostname and user');
      expect((await request('/api/ssh/hosts/dev:other', 'POST')).code).toBe(ErrorCode.VALIDATION_FAILED);
    } finally {
      await server.close();
    }
  });
});
