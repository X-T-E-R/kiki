import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { canonicalAliases } = vi.hoisted(() => ({ canonicalAliases: new Map<string, string>() }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, realpath: async (path: string) => canonicalAliases.get(path) ?? original.realpath(path) };
});
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
vi.mock('@kiki/agent-core-v2/app/memory/memoryStore', () => ({ IMemoryStore: 'IMemoryStore' }));
vi.mock('@kiki/agent-core-v2/agent/tools/history/historyTools', () => ({ IHistoryArchive: 'IHistoryArchive' }));
vi.mock('@kiki/agent-core-v2/agent/tools/history/historyListTool', () => ({ IHistoryDirectory: 'IHistoryDirectory' }));
vi.mock('../src/lib/sessionOperationLease', () => ({ withSessionOperation: vi.fn() }));
vi.mock('../src/externalClients/access', async importOriginal => ({
  ...await importOriginal<typeof import('../src/externalClients/access')>(),
  ExternalClientAccess: class {},
  externalClientSeeds: () => ['history', 'directory', 'memory'].map(id => ({ id, value: id })),
}));

import { ExternalClientHost } from '../src/externalClients/host';
import { connectionInputSchema, connectionSchema, sessionSchema } from '../src/externalClients/contracts';
import type { Scope } from '@kiki/agent-core-v2';

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
let seeds: Record<string, unknown>;
let metadata: Record<string, unknown>;
let beforeExecute: Map<string, (event: FileCheckEvent) => void>;
const artifactScope = join('sessions', 'session_example', 'agents', 'main', 'tool-results');

beforeEach(async () => {
  canonicalAliases.clear();
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'kiki-client-binding-')));
  home = join(workspace, 'home');
  await mkdir(home);
  beforeExecute = new Map();
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
  create = vi.fn<(input: { sessionId: string; workDir: string; mainAgentBinding: { driver: string } }) => Promise<unknown>>(async (input) => {
    const context = { workspaceId: 'wd_example', cwd: input.workDir };
    for (const listener of will) listener({ sessionId: input.sessionId, readSeed: () => context,
      contributeSeed: (id: string, value: unknown) => { seeds[id] = value; } });
    const executor = {
      registerBeforeResolveTool: vi.fn(() => ({ dispose() {} })),
      onBeforeExecuteTool: vi.fn((listener: (event: FileCheckEvent) => void) => {
        beforeExecute.set(input.sessionId, listener);
        return { dispose() {} };
      }),
    };
    const main = { accessor: { get: (id: string) => ({
      IAgentPermissionModeService: mode, IAgentToolExecutorService: executor,
      IAgentScopeContext: { scope: () => artifactScope },
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
    IAtomicDocumentStore: documents, IBootstrapService: { homeDir: home, scope: () => 'credentials' }, ISessionManager: manager,
  } as Record<string, unknown>)[id] } } as unknown as Scope;
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
});
