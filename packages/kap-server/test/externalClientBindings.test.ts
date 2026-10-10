import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kiki/agent-core-v2', () => {
  const names = ['IBootstrapService', 'IAtomicDocumentStore', 'ISessionManager', 'ISessionMetadata',
    'IAgentLifecycleService', 'IAgentToolRegistryService', 'IAgentToolPolicyService',
    'IAgentToolExecutorService', 'IAgentPermissionModeService', 'ISessionContext', 'ISessionInteractionService'];
  return { ...Object.fromEntries(names.map(name => [name, name])), ensureMainAgent: async (session: { main: unknown }) => session.main };
});
vi.mock('@kiki/agent-core-v2/agent/task/task', () => ({ IAgentTaskService: 'IAgentTaskService' }));
vi.mock('@kiki/agent-core-v2/agent/scopeContext/scopeContext', () => ({ IAgentScopeContext: 'IAgentScopeContext' }));
vi.mock('@kiki/agent-core-v2/agent/loop/loop', () => ({ IAgentLoopService: 'IAgentLoopService' }));
vi.mock('@kiki/agent-core-v2/agent/execution/externalClientRecorder', () => ({ ExternalClientRecorder: class {} }));
vi.mock('../src/lib/sessionOperationLease', () => ({ withSessionOperation: vi.fn() }));
vi.mock('../src/externalClients/access', () => ({
  ExternalClientAccess: class {}, within: vi.fn(),
  externalClientSeeds: () => ['history', 'directory', 'memory'].map(id => ({ id, value: id })),
}));

import { ExternalClientHost } from '../src/externalClients/host';
import { connectionInputSchema, connectionSchema, sessionSchema } from '../src/externalClients/contracts';
import type { Scope } from '@kiki/agent-core-v2';

let workspace: string;
let host: ExternalClientHost;
let create: ReturnType<typeof vi.fn>;
let mode: { setMode: ReturnType<typeof vi.fn>; setModeCeiling: ReturnType<typeof vi.fn> };
let seeds: Record<string, unknown>;
let metadata: Record<string, unknown>;

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'kiki-client-binding-')));
  const docs = new Map<string, unknown>();
  const documents = {
    get: async (scope: string, key: string) => docs.get(`${scope}/${key}`),
    set: async (scope: string, key: string, value: unknown) => { docs.set(`${scope}/${key}`, value); },
    list: async (scope: string) => [...docs.keys()].filter(key => key.startsWith(`${scope}/`)).map(key => key.slice(scope.length + 1)),
  };
  const will: Array<(event: unknown) => void> = [];
  const did: Array<(event: unknown) => void> = [];
  const sessions = new Map<string, unknown>();
  mode = { setMode: vi.fn(), setModeCeiling: vi.fn() };
  seeds = {};
  metadata = {};
  create = vi.fn(async (input: { sessionId: string; workDir: string }) => {
    const context = { workspaceId: 'wd_example', cwd: input.workDir };
    for (const listener of will) listener({ sessionId: input.sessionId, readSeed: () => context,
      contributeSeed: (id: string, value: unknown) => { seeds[id] = value; } });
    const executor = { registerBeforeResolveTool: vi.fn(() => ({ dispose() {} })), onBeforeExecuteTool: vi.fn(() => ({ dispose() {} })) };
    const main = { accessor: { get: (id: string) => ({
      IAgentPermissionModeService: mode, IAgentToolExecutorService: executor,
      IAgentToolPolicyService: { isToolActive: () => true },
      IAgentToolRegistryService: { list: () => [{ name: 'Read', description: 'Read a file', parameters: {}, source: 'builtin' }] },
    } as Record<string, unknown>)[id] } };
    const session = { id: input.sessionId, main, accessor: { get: (id: string) => ({
      ISessionContext: context,
      IAgentLifecycleService: { list: () => [main], onWillCreate: () => ({ dispose() {} }) },
      ISessionMetadata: { ready: Promise.resolve(), read: async () => metadata,
        update: async (next: Record<string, unknown>) => { metadata = { ...metadata, ...next }; }, setTitle: vi.fn() },
    } as Record<string, unknown>)[id] } };
    sessions.set(input.sessionId, session);
    const pending: Promise<unknown>[] = [];
    for (const listener of did) listener({ sessionId: input.sessionId, handle: session, waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    await Promise.all(pending);
    return session;
  });
  const manager = { create, get: (id: string) => sessions.get(id),
    onWillCreateSession: (listener: (event: unknown) => void) => { will.push(listener); return { dispose() {} }; },
    onDidCreateSession: (listener: (event: unknown) => void) => { did.push(listener); return { dispose() {} }; },
  };
  const core = { accessor: { get: (id: string) => ({
    IAtomicDocumentStore: documents, IBootstrapService: { scope: () => 'credentials' }, ISessionManager: manager,
  } as Record<string, unknown>)[id] } } as unknown as Scope;
  host = new ExternalClientHost(core);
  await host.initialize();
});

afterEach(async () => { await host.close(); await rm(workspace, { recursive: true, force: true }); });

describe('external client access and session binding', () => {
  it('creates access without workspace or catalog sessions and retains legacy records', async () => {
    expect(connectionInputSchema.parse({ name: 'Example client' })).toEqual({ name: 'Example client' });
    expect(connectionInputSchema.safeParse({ name: 'Example client', workspace: '' }).success).toBe(false);
    const { connection } = await host.createConnection({ name: 'Example client', tools: ['Read'] });
    expect(connection.workspace).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(connectionSchema.parse(connection)).toMatchObject({ name: 'Example client' });
    expect(connectionSchema.parse({ ...connection, workspace })).toMatchObject({ workspace });
    const grant = (await host.resolveGrant(connection.id))!;
    expect((await host.catalog(grant)).map(tool => tool.name)).toEqual(['kiki_session', 'kiki_operation', 'kiki_save_text']);
    await expect(host.call(grant, 'kiki_session', { action: 'new', workspace: '/', _kiki: { idempotency_key: 'new' } }, { requestId: 'request_example' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'session_required' });
    expect(create).not.toHaveBeenCalled();
  });

  it('attaches the owner-selected scope and canonical identity, then catalogs its real tools', async () => {
    const { connection } = await host.createConnection({ name: 'Example client', mode: 'yolo', tools: ['Read'] });
    const changed = vi.fn();
    const subscription = host.onCatalogChanged(changed);
    await host.prepareOwnerSession(connection.id, 'session_example', workspace, 'review', undefined, 'profiles/example.md');
    await create({ sessionId: 'session_example', workDir: workspace, mainAgentBinding: { driver: 'external' } });
    expect(changed).toHaveBeenCalledWith(connection.id);
    subscription.dispose();
    expect(seeds).toEqual({ history: 'history', directory: 'directory', memory: 'memory' });
    const [record] = await host.store.sessions(connection.id);
    expect(sessionSchema.parse(record)).toMatchObject({ workspace, permissionMode: 'review', profileFile: 'profiles/example.md', workspaceId: 'wd_example' });
    expect(record?.sessionRef).toMatch(/^ext_[A-Za-z0-9_-]+$/);
    expect(metadata).toMatchObject({ custom: { externalClient: { driver: 'external', connectionId: connection.id, clientName: 'Example client', sessionRef: record?.sessionRef } } });
    const grant = (await host.resolveGrant(connection.id))!;
    expect((await host.catalog(grant)).map(tool => tool.name)).toContain('Read');
    expect(create).toHaveBeenCalledTimes(1);
    const cloned = await host.call(grant, 'kiki_session', { action: 'new', session_ref: record!.sessionRef, _kiki: { idempotency_key: 'clone' } }, { requestId: 'request_example' }, new AbortController().signal);
    expect(cloned.structuredContent).toMatchObject({ workspace, permissionMode: 'review', profileFile: 'profiles/example.md' });
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ workDir: workspace,
      mainAgentBinding: { driver: 'external', profile: undefined, execution: { executor: 'native', profile_file: 'profiles/example.md' } } }));
    expect(mode.setMode).toHaveBeenCalledWith('review');
    expect(mode.setModeCeiling).toHaveBeenCalledWith('yolo');
  });
});
