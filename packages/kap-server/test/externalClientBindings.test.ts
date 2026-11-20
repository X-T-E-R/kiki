import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentToolExecutorService,
  IAgentToolPolicyService,
  IAgentToolRegistryService,
  IAtomicDocumentStore,
  IBootstrapService,
  ISessionContext,
  ISessionIndex,
  ISessionManager,
  ISessionMetadata,
  IWorkAdmissionService,
  type Scope,
} from '@kiki/agent-core-v2';
import { IAgentScopeContext } from '@kiki/agent-core-v2/agent/scopeContext/scopeContext';
import { IAgentLoopService } from '@kiki/agent-core-v2/agent/loop/loop';
import { IAgentTaskService } from '@kiki/agent-core-v2/agent/task/task';
import { IMemoryStore } from '@kiki/agent-core-v2/app/memory/memoryStore';
import { IHistoryArchive } from '@kiki/agent-core-v2/agent/tools/history/historyTools';
import { IHistoryDirectory } from '@kiki/agent-core-v2/agent/tools/history/historyListTool';

const { canonicalAliases } = vi.hoisted(() => ({ canonicalAliases: new Map<string, string>() }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, realpath: async (path: string) => canonicalAliases.get(path) ?? original.realpath(path) };
});

import { ExternalClientHost } from '../src/externalClients/host';
import { connectionInputSchema, connectionSchema, sessionSchema } from '../src/externalClients/contracts';
import { startServer } from '../src/start';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

type FileDecision = { veto: { isError: boolean; output: string } };
interface FileCheckEvent {
  toolCall: { name: string };
  execution: { accesses: { kind: 'file'; path: string; operation: 'read' | 'write' | 'readwrite' | 'search' }[] };
  waitUntil(factory: () => Promise<FileDecision | undefined>): void;
}
let workspace: string;
let home: string;
let host: ExternalClientHost;
let create: ReturnType<typeof vi.fn<(input: { sessionId: string; workDir: string; mainAgentBinding: { driver: string } }) => Promise<unknown>>>;
let mode: { setMode: ReturnType<typeof vi.fn>; setModeCeiling: ReturnType<typeof vi.fn> };
let seeds: Map<unknown, unknown>;
let metadata: Record<string, unknown>;
let beforeExecute: Map<string, (event: FileCheckEvent) => void>;
let sessionDisposers: Map<string, () => void>;
let hookDisposals: ReturnType<typeof vi.fn>;
const artifactScope = join('sessions', 'session_example', 'agents', 'main', 'tool-results');

beforeEach(async () => {
  canonicalAliases.clear();
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'kiki-client-binding-')));
  home = join(workspace, 'home');
  await mkdir(home);
  beforeExecute = new Map();
  sessionDisposers = new Map();
  hookDisposals = vi.fn();
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
  seeds = new Map();
  metadata = {};
  create = vi.fn<(input: { sessionId: string; workDir: string; mainAgentBinding: { driver: string } }) => Promise<unknown>>(async (input) => {
    const context = { workspaceId: 'wd_example', cwd: input.workDir };
    for (const listener of will) listener({ sessionId: input.sessionId, readSeed: () => context,
      contributeSeed: (id: unknown, value: unknown) => { seeds.set(id, value); },
      onSessionDispose: (dispose: () => void) => { sessionDisposers.set(input.sessionId, dispose); } });
    const executor = {
      registerBeforeResolveTool: vi.fn(() => ({ dispose: hookDisposals })),
      onBeforeExecuteTool: vi.fn((listener: (event: FileCheckEvent) => void) => {
        beforeExecute.set(input.sessionId, listener);
        return { dispose: hookDisposals };
      }),
    };
    const mainServices = new Map<unknown, unknown>([
      [IAgentPermissionModeService, mode],
      [IAgentToolExecutorService, executor],
      [IAgentScopeContext, { scope: () => artifactScope }],
      [IAgentToolPolicyService, { isToolActive: () => true }],
      [IAgentToolRegistryService, { list: () => [{ name: 'Read', description: 'Read a file', parameters: {}, source: 'builtin' }] }],
      [IAgentLoopService, { cancel: vi.fn() }],
      [IAgentTaskService, { stopAll: vi.fn(async () => undefined) }],
    ]);
    const main = { id: 'main', accessor: { get: (id: unknown) => mainServices.get(id) } };
    const sessionServices = new Map<unknown, unknown>([
      [ISessionContext, context],
      [IAgentLifecycleService, {
        get: (id: string) => id === 'main' ? main : undefined,
        create: async () => main,
        list: () => [main],
        onWillCreate: () => ({ dispose() {} }),
        onDidDispose: () => ({ dispose() {} }),
      }],
      [ISessionMetadata, { ready: Promise.resolve(), read: async () => metadata,
        update: async (next: Record<string, unknown>) => { metadata = { ...metadata, ...next }; }, setTitle: vi.fn() }],
    ]);
    const session = { id: input.sessionId, main, accessor: { get: (id: unknown) => sessionServices.get(id) } };
    sessions.set(input.sessionId, session);
    const pending: Promise<unknown>[] = [];
    for (const listener of did) listener({ sessionId: input.sessionId, handle: session, waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    await Promise.all(pending);
    return session;
  });
  const manager = { create, get: (id: string) => sessions.get(id),
    acquire: async (id: string) => {
      const handle = sessions.get(id);
      return handle === undefined ? undefined : { handle, dispose: async () => undefined };
    },
    onWillCreateSession: (listener: (event: unknown) => void) => { will.push(listener); return { dispose() {} }; },
    onDidCreateSession: (listener: (event: unknown) => void) => { did.push(listener); return { dispose() {} }; },
  };
  const archiveSearch = vi.fn(async () => ({ hits: [] }));
  const directoryList = vi.fn(async () => ({ items: [] }));
  const memoryGet = vi.fn(async () => ({ id: 'm1' }));
  const coreServices = new Map<unknown, unknown>([
    [IAtomicDocumentStore, documents],
    [IBootstrapService, { homeDir: home, scope: () => 'credentials' }],
    [ISessionManager, manager],
    [ISessionIndex, {
      get: async (sessionId: string) => sessionId === 'session_example'
        ? { id: sessionId, workspaceId: 'wd_example' }
        : sessionId === 'session_foreign'
          ? { id: sessionId, workspaceId: 'wd_other' }
          : undefined,
    }],
    [IHistoryArchive, { _serviceBrand: undefined, search: archiveSearch, readTurn: vi.fn(async () => ({})) }],
    [IHistoryDirectory, { _serviceBrand: undefined, list: directoryList }],
    [IMemoryStore, {
      _serviceBrand: undefined, onDidChange: () => ({ dispose() {} }),
      get: memoryGet, list: vi.fn(async () => []), inventory: vi.fn(async () => []),
      query: vi.fn(async () => ({ items: [] })), search: vi.fn(async () => []),
      put: vi.fn(async (input: unknown) => input), delete: vi.fn(async () => undefined),
      journal: vi.fn(async () => []), undo: vi.fn(async () => undefined),
      listPersonaEntries: vi.fn(async () => []), deletePersonaNamespaces: vi.fn(async () => undefined),
      importLorebook: vi.fn(async () => undefined),
    }],
    [IWorkAdmissionService, { run: <T>(_kind: string, fn: () => Promise<T>) => fn(), acquire: () => ({ run: <T>(fn: () => Promise<T>) => fn(), dispose() {} }) }],
  ]);
  const core = { accessor: { get: (id: unknown) => coreServices.get(id) } } as unknown as Scope;
  host = new ExternalClientHost(core);
  await host.initialize();
});

afterEach(async () => { await host.close(); await rm(workspace, { recursive: true, force: true }); });

async function bindWorkspace(root: string, sessionId = 'session_example'): Promise<void> {
  const { connection } = await host.createConnection({ name: 'Example client', tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'] });
  await host.prepareOwnerSession(connection.id, sessionId, root, 'manual');
  await create({ sessionId, workDir: root, mainAgentBinding: { driver: 'external' } });
}
async function fileDecision(name: string, path: string, operation: 'read' | 'write' | 'readwrite' | 'search' = 'read', sessionId = 'session_example') {
  const listener = beforeExecute.get(sessionId);
  if (listener === undefined) throw new Error('Missing bound execution hook');
  const pending: Promise<FileDecision | undefined>[] = [];
  listener({ toolCall: { name }, execution: { accesses: [{ kind: 'file', path, operation }] },
    waitUntil: factory => { pending.push(factory()); } });
  expect(pending).toHaveLength(1);
  return (await Promise.all(pending))[0];
}

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
    expect([...seeds.keys()]).toEqual([IHistoryArchive, IHistoryDirectory, IMemoryStore]);
    const wrappedArchive = seeds.get(IHistoryArchive) as { search: (query: { workspaceId?: string; sessionId?: string; peer?: boolean }) => Promise<unknown> };
    await expect(wrappedArchive.search({ workspaceId: 'wd_example', sessionId: 'session_example' })).resolves.toEqual({ hits: [] });
    await expect(wrappedArchive.search({ workspaceId: 'wd_other', sessionId: 'session_foreign' })).rejects.toMatchObject({ code: 'history_unavailable' });
    await expect(wrappedArchive.search({ workspaceId: 'wd_example', sessionId: 'session_example', peer: true })).rejects.toMatchObject({ code: 'history_unavailable' });
    const wrappedMemory = seeds.get(IMemoryStore) as { get: (scope: { kind: string; workspaceId?: string }, id: string) => Promise<unknown>; deletePersonaNamespaces: () => Promise<unknown> };
    await expect(wrappedMemory.get({ kind: 'global' }, 'm1')).resolves.toBeUndefined();
    await expect(wrappedMemory.deletePersonaNamespaces()).rejects.toMatchObject({ code: 'memory_unavailable' });
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

  it('keeps an explicit manual choice when it equals the old connection mode, and follows only an unset mode', async () => {
    const { connection } = await host.createConnection({ name: 'Example client', mode: 'manual', workspace, tools: ['Read'] });
    await host.prepareOwnerSession(connection.id, 'session_explicit', workspace, 'manual');
    await create({ sessionId: 'session_explicit', workDir: workspace, mainAgentBinding: { driver: 'external' } });
    const grant = (await host.resolveGrant(connection.id))!;
    const inherited = await host.call(grant, 'kiki_session', { action: 'new', _kiki: { idempotency_key: 'inherit' } }, { requestId: 'request_inherit' }, new AbortController().signal);
    expect(inherited.structuredContent?.['permissionMode']).toBeUndefined();
    expect(mode.setMode).toHaveBeenCalledWith('manual');
    expect(mode.setModeCeiling).toHaveBeenCalledWith('manual');
    await host.patchConnection(connection.id, { mode: 'yolo' });
    const records = await host.store.sessions(connection.id);
    const explicit = records.find((record) => record.sessionId === 'session_explicit');
    const followed = records.find((record) => record.sessionId !== 'session_explicit');
    expect(explicit?.permissionMode).toBe('manual');
    expect(followed?.permissionMode).toBeUndefined();
    mode.setMode.mockClear();
    const inheritedAgain = await host.call(grant, 'kiki_session', { action: 'new', session_ref: followed!.sessionRef, _kiki: { idempotency_key: 'inherit-again' } }, { requestId: 'request_inherit_again' }, new AbortController().signal);
    expect(inheritedAgain.structuredContent?.['permissionMode']).toBeUndefined();
    expect(mode.setMode).toHaveBeenCalledWith('yolo');
    mode.setMode.mockClear();
    const kept = await host.call(grant, 'kiki_session', { action: 'new', session_ref: explicit!.sessionRef, _kiki: { idempotency_key: 'keep-manual' } }, { requestId: 'request_keep_manual' }, new AbortController().signal);
    expect(kept.structuredContent).toMatchObject({ permissionMode: 'manual' });
    expect(mode.setMode).toHaveBeenCalledWith('manual');
    expect(mode.setMode).not.toHaveBeenCalledWith('yolo');
  });

  it.each(['workspaces', 'bots', 'worktrees'])('allows bound managed %s roots without opening the rest of home', async folder => {
    const root = join(home, folder, 'example');
    await mkdir(root, { recursive: true });
    const file = join(root, 'example.txt');
    await writeFile(file, 'Synthetic workspace content');
    await bindWorkspace(root);
    for (const name of ['Read', 'Write', 'Edit', 'Glob', 'Grep']) {
      const search = name === 'Glob' || name === 'Grep';
      const path = search ? root : file;
      const operation = search ? 'search' : name === 'Edit' ? 'readwrite' : name === 'Write' ? 'write' : 'read';
      expect(await fileDecision(name, path, operation)).toBeUndefined();
    }
    expect(await fileDecision('Write', join(root, 'new', 'example.txt'), 'write')).toBeUndefined();
    const denied = { veto: { isError: true, output: 'File access is outside the shared workspace.' } };
    const credentials = join(home, 'credentials', 'example.txt');
    const otherWorkspace = join(home, folder, 'example-other', 'example.txt');
    await mkdir(join(home, 'credentials'));
    await mkdir(join(home, folder, 'example-other'));
    await writeFile(credentials, 'Synthetic credential placeholder');
    await writeFile(otherWorkspace, 'Synthetic other workspace');
    for (const path of [credentials, otherWorkspace, join(root, '..', 'example-other', 'example.txt')]) {
      expect(await fileDecision('Read', path)).toEqual(denied);
    }
    const alias = join(root, 'synthetic-link');
    canonicalAliases.set(alias, join(home, 'credentials'));
    expect(await fileDecision('Read', join(alias, 'example.txt'))).toEqual(denied);
    expect(await fileDecision('Write', join(alias, 'new.txt'), 'write')).toEqual(denied);
    for (const name of ['Glob', 'Grep']) {
      expect(await fileDecision(name, home)).toMatchObject({ veto: { isError: true } });
      expect(await fileDecision(name, workspace)).toMatchObject({ veto: { isError: true } });
    }
  });

  it('keeps home private when the binding equals or encompasses home, including canonical aliases', async () => {
    const file = join(home, 'example.txt');
    await writeFile(file, 'Synthetic private-home content');
    const alias = join(home, 'synthetic-home-link');
    canonicalAliases.set(alias, home);
    for (const [index, root] of [home, workspace, alias].entries()) {
      const sessionId = `session_home_${index}`;
      await bindWorkspace(root, sessionId);
      expect(await fileDecision('Read', file, 'read', sessionId)).toMatchObject({ veto: { isError: true } });
      expect(await fileDecision('Write', file, 'write', sessionId)).toMatchObject({ veto: { isError: true } });
    }
    expect(await fileDecision('Read', join(workspace, 'outside-home.txt'), 'read', 'session_home_1')).toBeUndefined();
  });

  it('releases bound execution hooks with the session scope', async () => {
    await bindWorkspace(workspace);
    expect(hookDisposals).not.toHaveBeenCalled();
    sessionDisposers.get('session_example')?.();
    expect(hookDisposals).toHaveBeenCalledTimes(2);
  });

  it('retains the bound agent tool-result read exception without allowing writes', async () => {
    const root = join(home, 'workspaces', 'example');
    const artifacts = join(home, artifactScope);
    await mkdir(root, { recursive: true });
    await mkdir(artifacts, { recursive: true });
    const file = join(artifacts, 'example.txt');
    await writeFile(file, 'Synthetic tool result');
    await bindWorkspace(root);
    expect(await fileDecision('Read', file)).toBeUndefined();
    expect(await fileDecision('Write', file, 'write')).toMatchObject({ veto: { isError: true } });
  });

  it('drives ExternalClientHost createConnection, prepareOwnerSession, live session binding, and stopSession against real startServer DI', async () => {
    const realHome = await mkdtemp(join(tmpdir(), 'kiki-real-ext-client-'));
    const realCwd = join(realHome, 'workspace');
    await mkdir(realCwd, { recursive: true });
    await writeFile(join(realHome, 'config.toml'), '[search]\nenabled = false\n[cron]\nmanualTick = true\n');
    const server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: realHome,
      logLevel: 'silent',
    });
    const realHost = new ExternalClientHost(server.core);
    try {
      await realHost.initialize();
      const { connection } = await realHost.createConnection({
        name: 'Real DI Client',
        tools: ['Read', 'Write'],
      });
      const base = `http://127.0.0.1:${server.port}`;
      const sessionId = 'session_real_ext_binding';
      await realHost.prepareOwnerSession(connection.id, sessionId, realCwd, 'manual');
      await server.core.accessor.get(ISessionManager).create({
        sessionId,
        workDir: realCwd,
        mainAgentBinding: { driver: 'external' } as never,
      });
      const stopped = await realHost.stopSession(sessionId);
      expect(stopped.session.sessionId).toBe(sessionId);
      const revoked = await realHost.revoke(connection.id);
      expect(revoked.connection.status).toBe('revoked');
      const res = await fetch(`${base}/api/healthz`);
      expect(res.status).toBe(200);
    } finally {
      await realHost.close();
      await server.close();
      await rm(realHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30_000);
});
