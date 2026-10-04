import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { ISshConnectionGateService, SshConnectionGateService, sessionSshHostsKey, sshHostFingerprint } from '#/agent/ssh/sshConnectionGateService';
import type { BeforeResolveToolContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentContextInjectorService, type ContextInjectionProvider } from '#/agent/contextInjector/contextInjector';
import { AgentContextInjectorService } from '#/agent/contextInjector/contextInjectorService';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetadata } from '#/session/sessionMetadata/sessionMetadataService';
import { ISessionApprovalService } from '#/session/approval/approval';
import { ISshHostService } from '#/app/ssh/sshService';
import type { SshHostRecord } from '#/app/ssh/sshHosts';
import { parseTransientSshTarget, type ResolvedSshConfig } from '#/app/ssh/sshConfig';
import { ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { matchPermissionRule } from '#/agent/permissionRules/matchesRule';
import { toolApprovalRule } from '#/agent/tools/os/sshToolTarget';
import { registerLogServices } from '../../_base/log/stubs';
import { registerContextMemoryServices } from '../contextMemory/stubs';
import { runWillBeginStepHooks, stubLoopWithHooks } from '../loop/stubs';

const homes: string[] = [];
const containers: DisposableStore[] = [];
afterEach(async () => {
  for (const container of containers.splice(0)) container.dispose();
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map((home) => rm(home, { force: true, recursive: true })));
});

async function fixture(options: {
  mode?: 'auto' | 'yolo'; agentId?: string; decision?: 'approved' | 'rejected';
  home?: string; records?: readonly SshHostRecord[]; target?: ResolvedSshConfig;
} = {}) {
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'kiki-ssh-approval-'));
  if (options.home === undefined) homes.push(home);
  vi.stubEnv('KIKI_HOME', home);
  let gate: ((context: BeforeResolveToolContext) => Promise<string | undefined>) | undefined;
  const executor = {
    registerBeforeResolveTool: (handler: typeof gate) => { gate = handler; return { dispose: () => { gate = undefined; } }; },
  } as IAgentToolExecutorService;
  const runtime = {
    nativeSshEnabled: () => true,
    approveSshTarget: vi.fn(),
    inspect: () => ({ identity: { runtimeId: 'local', workspaceId: 'workspace' } }),
  } as unknown as IAgentRuntimeService;
  const approvals = { request: vi.fn(async () => ({ decision: options.decision ?? 'approved' })),
    takeSshCredential: vi.fn(() => undefined), clearSshCredential: vi.fn() } as unknown as ISessionApprovalService;
  const records: SshHostRecord[] = [...options.records ?? [
    { id: 'dev', name: 'Development', source: 'kiki' as const },
    { id: 'synced', name: 'Synced', source: 'ssh-config' as const },
    { id: 'hidden', name: 'Hidden', source: 'kiki' as const, agentAccess: 'hidden' as const },
  ]];
  const hosts = {
    list: vi.fn(async () => records),
    resolveTarget: vi.fn(async () => options.target ?? {
      hostname: 'dev.example.test', user: 'tester', port: 22, identityFiles: [],
      userKnownHostsFiles: [], proxyJump: undefined,
    }),
    connectionApprovalEnabled: vi.fn(async () => true),
    status: vi.fn(() => ({ hostId: 'dev', state: 'ready' as const, generation: 1 })),
    addTransient: vi.fn(async (id: string) => {
      const parsed = parseTransientSshTarget(id);
      if (parsed === undefined) throw new Error('Invalid transient test target');
      records.push({ id, name: id, source: 'session', hostname: parsed.hostname, user: parsed.user, port: parsed.port });
    }),
    removeTransient: vi.fn(async (id: string) => {
      const index = records.findIndex((record) => record.id === id && record.source === 'session');
      if (index >= 0) records.splice(index, 1);
    }),
  } as unknown as ISshHostService;
  const disposables = new DisposableStore();
  containers.push(disposables);
  const loop = stubLoopWithHooks();
  const ix = createServices(disposables, {
    base: [registerContextMemoryServices, registerLogServices], strict: true,
    additionalServices: (reg) => {
      reg.defineInstance(IFileSystemStorageService, new FileStorageService(home, 0o700, 0o600));
      reg.define(IAtomicDocumentStore, JsonAtomicDocumentStore);
      reg.define(ISessionStateService, SessionStateService);
      reg.definePartialInstance(ISessionContext, { sessionId: 'session', workspaceId: 'workspace', cwd: '/workspace', metaScope: 'sessions/session' });
      reg.definePartialInstance(ISessionIndexMirror, { record: () => {} });
      reg.define(ISessionMetadata, SessionMetadata);
      reg.defineInstance(IAgentToolExecutorService, executor);
      reg.defineInstance(IAgentRuntimeService, runtime);
      reg.definePartialInstance(IAgentPermissionModeService, { mode: options.mode ?? 'auto' });
      reg.definePartialInstance(IAgentScopeContext, { agentId: options.agentId ?? 'main' });
      reg.defineInstance(ISessionApprovalService, approvals);
      reg.defineInstance(ISshHostService, hosts);
      reg.defineInstance(IAgentLoopService, loop);
      reg.define(IAgentSystemReminderService, AgentSystemReminderService);
      reg.define(IAgentContextInjectorService, AgentContextInjectorService);
      reg.define(ISshConnectionGateService, SshConnectionGateService);
    },
  });
  const injector = ix.get(IAgentContextInjectorService);
  let announcement: ContextInjectionProvider<Readonly<Record<string, string>>> | undefined;
  const register = injector.register.bind(injector);
  vi.spyOn(injector, 'register').mockImplementation((name, provider) => {
    if (name === 'ssh_hosts') announcement = provider as typeof announcement;
    return register(name, provider);
  });
  const service = ix.get(ISshConnectionGateService);
  await service.ready;
  const state = ix.get(ISessionStateService);
  const context = ix.get(IAgentContextMemoryService);
  const metadata = ix.get(ISessionMetadata);
  const documents = ix.get(IAtomicDocumentStore);
  const call = (host: string, signal = new AbortController().signal) => {
    if (gate === undefined) throw new Error('gate not installed');
    return gate({
      tool: { name: 'Read' }, toolCall: { id: 'tool-call', name: 'Read' },
      args: { host, path: '/home/tester/file' }, signal,
      turnId: 1, toolCalls: [],
    } as unknown as BeforeResolveToolContext);
  };
  const announce = (previous?: Readonly<Record<string, string>>, isNewTurn = true) => {
    if (announcement === undefined) throw new Error('SSH announcement provider missing');
    return announcement({ lastDisclosure: previous, isNewTurn, injectedPositions: [], lastInjectedAt: null });
  };
  const step = (firstStepOfTurn = true) => runWillBeginStepHooks(loop, firstStepOfTurn);
  return { home, service, state, approvals, hosts, runtime, call, announce, step, context, metadata, documents,
    dispose: () => disposables.dispose() };
}

function userMessage(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'user' } };
}

function sshInjections(context: IAgentContextMemoryService): readonly ContextMessage[] {
  return context.get().filter((message) => message.origin?.kind === 'injection' && message.origin.variant === 'ssh_hosts');
}

function textOf(message: ContextMessage): string {
  return message.content.map((part) => part.type === 'text' ? part.text : '').join('');
}

describe('SSH connection gate before tool resolution', () => {
  it('keeps a bare Bash allow in a remote workspace separate from host:local', () => {
    const remote = { identity: { runtimeId: 'ssh:dev' } } as unknown as import('#/runtime/runtime').Runtime;
    const implicit = toolApprovalRule('Bash', 'ls', remote);
    const explicit = toolApprovalRule('Bash', 'ls', remote, 'local');
    expect(implicit).toBe('Bash@dev(ls)');
    expect(explicit).toBe('Bash@local(ls)');
    const rule = { decision: 'allow' as const, scope: 'user' as const, pattern: 'Bash' };
    expect(matchPermissionRule({ rule, toolName: 'Bash', execution: { approvalRule: explicit } })).toBeUndefined();
    expect(matchPermissionRule({ rule: { ...rule, pattern: 'Bash@local' }, toolName: 'Bash',
      execution: { approvalRule: explicit } })).toBeDefined();
    expect(matchPermissionRule({ rule: { ...rule, pattern: 'Bash@dev' }, toolName: 'Bash',
      execution: { approvalRule: implicit } })).toBeDefined();
  });

  it('rejects an unapproved host before adding it to the session', async () => {
    const f = await fixture({ decision: 'rejected' });
    expect(await f.call('dev')).toContain('not approved');
    expect(f.state.get(sessionSshHostsKey)).toEqual({});
    expect(f.runtime.approveSshTarget).not.toHaveBeenCalled();
    expect(f.approvals.request).toHaveBeenCalledTimes(1);
    f.dispose();
  });

  it('clears approved credentials when the connection attempt aborts before consumption', async () => {
    const f = await fixture();
    const controller = new AbortController();
    vi.mocked(f.approvals.request).mockImplementationOnce(async () => {
      controller.abort();
      return { decision: 'approved' };
    });
    await expect(f.call('dev', controller.signal)).rejects.toThrow();
    const id = vi.mocked(f.approvals.request).mock.calls[0]![0].id!;
    expect(f.approvals.takeSshCredential).not.toHaveBeenCalled();
    expect(f.approvals.clearSshCredential).toHaveBeenCalledWith(id);
    expect(f.runtime.approveSshTarget).not.toHaveBeenCalled();
    f.dispose();
  });

  it('approves a known host once per session, but never admits unknown or hidden hosts', async () => {
    const f = await fixture();
    expect(await f.call('dev')).toBeUndefined();
    expect(await f.call('dev')).toBeUndefined();
    expect(f.state.get(sessionSshHostsKey)['dev']).toContain('Development');
    expect(f.runtime.approveSshTarget).toHaveBeenCalledWith('dev', f.state.get(sessionSshHostsKey)['dev'],
      expect.any(Function), undefined, expect.any(Function));
    expect(f.approvals.request).toHaveBeenCalledTimes(1);
    expect(await f.call('unknown')).toContain('not available');
    expect(await f.call('hidden')).toContain('not available');
    vi.mocked(f.hosts.list).mockResolvedValue([{ id: 'dev', name: 'Retargeted', source: 'kiki' }]);
    expect(await f.call('dev')).toBeUndefined();
    expect(f.approvals.request).toHaveBeenCalledTimes(2);
    f.dispose();
  });

  it('lists a synced alias without joining it until approval or yolo selection', async () => {
    const f = await fixture({ decision: 'rejected' });
    expect(await f.announce()).toBeUndefined();
    expect(await f.call('synced')).toContain('not approved');
    expect(f.state.get(sessionSshHostsKey)).toEqual({});
    expect(f.runtime.approveSshTarget).not.toHaveBeenCalled();
    f.dispose();
    const yolo = await fixture({ mode: 'yolo' });
    expect(await yolo.call('synced')).toBeUndefined();
    expect(yolo.state.get(sessionSshHostsKey)['synced']).toBeDefined();
    expect(yolo.approvals.request).not.toHaveBeenCalled();
    yolo.dispose();
  });

  it('prompts again after a session-only credential disconnects', async () => {
    const f = await fixture();
    vi.mocked(f.approvals.takeSshCredential).mockReturnValueOnce({ password: 'first-secret', save: 'session' });
    expect(await f.call('dev')).toBeUndefined();
    expect(f.approvals.request).toHaveBeenCalledTimes(1);
    vi.mocked(f.hosts.status).mockReturnValue({ hostId: 'dev', state: 'disconnected', generation: 2 });
    vi.mocked(f.approvals.takeSshCredential).mockReturnValueOnce({ password: 'second-secret', save: 'session' });
    expect(await f.call('dev')).toBeUndefined();
    expect(f.approvals.request).toHaveBeenCalledTimes(2);
    expect(f.runtime.approveSshTarget).toHaveBeenLastCalledWith('dev', f.state.get(sessionSshHostsKey)['dev'],
      expect.any(Function), { password: 'second-secret', save: 'session' }, expect.any(Function));
    f.dispose();
  });

  it('re-approves when ssh -G changes the destination or jump despite an unchanged host record', async () => {
    const f = await fixture();
    expect(await f.call('dev')).toBeUndefined();
    const original = f.state.get(sessionSshHostsKey)['dev'];
    for (const change of [
      { hostname: 'redirect.example.test' }, { port: 2222 }, { user: 'other' }, { proxyJump: 'bastion' },
    ]) {
      vi.mocked(f.hosts.resolveTarget).mockResolvedValue({
        hostname: 'dev.example.test', user: 'tester', port: 22,
        identityFiles: [], userKnownHostsFiles: [], ...change,
      });
      expect(await f.call('dev')).toBeUndefined();
    }
    expect(f.approvals.request).toHaveBeenCalledTimes(5);
    expect(f.state.get(sessionSshHostsKey)['dev']).not.toBe(original);
    f.dispose();
  });

  it('rejects a target redirected while an approval is pending', async () => {
    const f = await fixture();
    vi.mocked(f.approvals.request).mockImplementationOnce(async () => {
      vi.mocked(f.hosts.resolveTarget).mockResolvedValue({
        hostname: 'redirect.example.test', user: 'tester', port: 22,
        identityFiles: [], userKnownHostsFiles: [],
      });
      return { decision: 'approved' };
    });
    expect(await f.call('dev')).toContain('changed during connection approval');
    expect(f.state.get(sessionSshHostsKey)).toEqual({});
    f.dispose();
  });

  it('allows yolo without connection approval, but requires main-session approval for subagents', async () => {
    const f = await fixture({ mode: 'yolo' });
    expect(await f.call('dev')).toBeUndefined();
    expect(f.approvals.request).not.toHaveBeenCalled();
    const approved = f.state.get(sessionSshHostsKey)['dev'];
    f.dispose();
    const sub = await fixture({ agentId: 'subagent' });
    expect(await sub.call('dev')).toContain('subagent cannot connect');
    expect(sub.approvals.request).not.toHaveBeenCalled();
    sub.state.set(sessionSshHostsKey, { dev: approved! });
    expect(await sub.call('dev')).toBeUndefined();
    sub.dispose();
  });

  it('separates login, unknown-key confirmation, and each keyboard-interactive challenge', async () => {
    const f = await fixture();
    expect(await f.call('dev')).toBeUndefined();
    const approval = vi.mocked(f.runtime.approveSshTarget!).mock.lastCall!;
    const trust = approval[2] as (key: { hostname: string; port: number; algorithm: string; fingerprint: string }) => Promise<boolean>;
    const keyboard = approval[4] as (prompts: readonly { prompt: string; echo: boolean }[]) => Promise<readonly string[]>;
    expect(await trust({ hostname: 'dev.example.test', port: 22, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:example' })).toBe(true);
    expect(f.approvals.request).toHaveBeenLastCalledWith(expect.objectContaining({
      ssh: expect.objectContaining({ kind: 'host_key', algorithm: 'ssh-ed25519', fingerprint: 'SHA256:example' }),
    }));
    vi.mocked(f.approvals.takeSshCredential).mockReturnValueOnce({ answers: ['pasted-code'] });
    expect(await keyboard([{ prompt: 'Verification code:', echo: false }])).toEqual(['pasted-code']);
    expect(f.approvals.request).toHaveBeenLastCalledWith(expect.objectContaining({
      ssh: expect.objectContaining({ kind: 'login', prompts: [{ prompt: 'Verification code:', echo: false }] }),
    }));
    expect(f.approvals.request).toHaveBeenCalledTimes(3);
    f.dispose();
  });

  it('global connection approval off skips the prompt but still checks target fingerprint and subagent membership', async () => {
    const f = await fixture();
    vi.mocked(f.hosts.connectionApprovalEnabled).mockResolvedValue(false);
    expect(await f.call('dev')).toBeUndefined();
    expect(f.approvals.request).not.toHaveBeenCalled();
    vi.mocked(f.hosts.resolveTarget).mockResolvedValue({
      hostname: 'redirect.example.test', user: 'tester', port: 22, identityFiles: [], userKnownHostsFiles: [],
    });
    expect(await f.call('dev')).toBeUndefined();
    expect(f.state.get(sessionSshHostsKey)['dev']).toContain('redirect.example.test');
    f.dispose();
    const sub = await fixture({ agentId: 'subagent' });
    vi.mocked(sub.hosts.connectionApprovalEnabled).mockResolvedValue(false);
    expect(await sub.call('dev')).toContain('subagent cannot connect');
    sub.dispose();
  });

  it('announces only usable joined hosts once per new turn and emits incremental removals', async () => {
    const f = await fixture();
    expect(await f.announce()).toBeUndefined();
    expect(await f.call('dev')).toBeUndefined();
    expect(await f.announce(undefined, false)).toBeUndefined();
    const added = await f.announce() as { content: string; disclosure: Readonly<Record<string, string>> };
    expect(added.content).toBe('<ssh_hosts_added>\nhost: "dev" — Development — tester@dev.example.test:22\n</ssh_hosts_added>');
    expect(added.content).not.toContain('Hidden');
    expect(await f.announce(added.disclosure)).toBeUndefined();
    await f.service.setSessionHosts(() => ({}));
    const removed = await f.announce(added.disclosure) as { content: string; disclosure: Readonly<Record<string, string>> };
    expect(removed.content).toBe('<ssh_hosts_removed>\ndev\n</ssh_hosts_removed>');
    expect(removed.disclosure).toEqual({});
    f.dispose();
  });
});


describe('persistent SSH membership and context consumers', () => {
  it('discloses the callable id separately from display name and destination facts', async () => {
    const f = await fixture({ records: [{ id: 'ssh-host-42', name: 'Development', source: 'kiki',
      roots: ['/srv/project'], description: 'Build workspace' }],
    target: { hostname: 'build.example.test', user: 'builder', port: 2202, identityFiles: [], userKnownHostsFiles: [] } });
    expect(await f.call('ssh-host-42')).toBeUndefined();
    await f.step();
    expect(textOf(sshInjections(f.context)[0]!)).toContain(
      'host: "ssh-host-42" — Development — builder@build.example.test:2202, roots: /srv/project · Build workspace');
    expect(f.runtime.approveSshTarget).toHaveBeenCalledWith('ssh-host-42', f.state.get(sessionSshHostsKey)['ssh-host-42'],
      expect.any(Function), undefined, expect.any(Function));
  });

  it('keeps the host in context for a second plain-text prompt without refs or duplicate reminders', async () => {
    const f = await fixture();
    expect(await f.call('dev')).toBeUndefined();
    f.context.append(userMessage('Inspect the project on the joined host.'));
    await f.step();
    const initial = sshInjections(f.context)[0]!;
    expect(textOf(initial)).toContain('host: "dev" — Development — tester@dev.example.test:22');
    const followUp = userMessage('Now read the next file.');
    f.context.append(followUp);
    await f.step();
    expect(sshInjections(f.context)).toEqual([initial]);
    expect(f.context.get().at(-1)).toBe(followUp);
    expect(followUp.content).toEqual([{ type: 'text', text: 'Now read the next file.' }]);
    expect(await f.call('dev')).toBeUndefined();
    expect(f.approvals.request).toHaveBeenCalledTimes(1);
    expect(f.runtime.approveSshTarget).toHaveBeenLastCalledWith('dev', f.state.get(sessionSshHostsKey)['dev'],
      expect.any(Function), undefined, expect.any(Function));
  });

  it('re-discloses current membership after real compaction shaping rearms a non-first step', async () => {
    const f = await fixture();
    expect(await f.call('dev')).toBeUndefined();
    f.context.append(userMessage('Inspect the project.'));
    await f.step();
    f.context.applyCompaction({ summary: 'Inspection continues.', compactedCount: f.context.get().length, tokensBefore: 500 });
    expect(sshInjections(f.context)).toEqual([]);
    await f.step(false);
    expect(sshInjections(f.context)).toHaveLength(1);
    expect(textOf(sshInjections(f.context)[0]!)).toContain('host: "dev" — Development — tester@dev.example.test:22');
    await f.step(false);
    expect(sshInjections(f.context)).toHaveLength(1);
    expect(f.approvals.request).toHaveBeenCalledTimes(1);
  });

  it('loads membership from state.json into fresh services and preserves historical disclosure without reusing socket approval', async () => {
    const first = await fixture();
    expect(await first.call('dev')).toBeUndefined();
    first.context.append(userMessage('Inspect the project.'));
    await first.step();
    const saved = first.state.get(sessionSshHostsKey);
    expect((await first.documents.get<{ sshHosts: unknown }>('sessions/session', 'state.json'))?.sshHosts).toEqual(saved);
    const history = JSON.parse(JSON.stringify(first.context.get())) as ContextMessage[];
    first.dispose();
    const resumed = await fixture({ home: first.home });
    expect(resumed.state.get(sessionSshHostsKey)).toEqual(saved);
    expect(resumed.runtime.approveSshTarget).not.toHaveBeenCalled();
    expect(resumed.approvals.request).not.toHaveBeenCalled();
    resumed.context.append(...history, userMessage('Continue with the next file.'));
    await resumed.step();
    expect(sshInjections(resumed.context)).toHaveLength(1);
    expect(textOf(sshInjections(resumed.context)[0]!)).toContain('host: "dev"');
    vi.mocked(resumed.hosts.status).mockReturnValue({ hostId: 'dev', state: 'idle', generation: 0 });
    expect(await resumed.call('dev')).toBeUndefined();
    expect(resumed.approvals.request).toHaveBeenCalledTimes(1);
    expect(resumed.runtime.approveSshTarget).toHaveBeenCalledWith('dev', saved['dev'],
      expect.any(Function), undefined, expect.any(Function));
  });

  it('makes restored membership visible when historical injections are absent', async () => {
    const first = await fixture();
    expect(await first.call('dev')).toBeUndefined();
    first.dispose();
    const resumed = await fixture({ home: first.home });
    resumed.context.append(userMessage('Continue on the joined host.'));
    await resumed.step();
    expect(textOf(sshInjections(resumed.context)[0]!)).toContain('host: "dev" — Development — tester@dev.example.test:22');
    expect(resumed.approvals.request).not.toHaveBeenCalled();
  });

  it('persists explicit removal and removes a restored historical id on the next turn', async () => {
    const first = await fixture();
    expect(await first.call('dev')).toBeUndefined();
    await first.step();
    const history = JSON.parse(JSON.stringify(first.context.get())) as ContextMessage[];
    await first.service.setSessionHosts(() => ({}));
    first.dispose();
    const resumed = await fixture({ home: first.home, decision: 'rejected' });
    expect(resumed.state.get(sessionSshHostsKey)).toEqual({});
    resumed.context.append(...history, userMessage('Continue.'));
    await resumed.step();
    expect(textOf(sshInjections(resumed.context).at(-1)!)).toContain('<ssh_hosts_removed>\ndev\n</ssh_hosts_removed>');
    expect(await resumed.call('dev')).toContain('not approved');
    expect(resumed.runtime.approveSshTarget).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'deleted record', records: [] },
    { label: 'changed record', records: [{ id: 'dev', name: 'Retargeted', source: 'kiki' as const }] },
    { label: 'changed destination', target: { hostname: 'redirect.example.test', user: 'tester', port: 22, identityFiles: [], userKnownHostsFiles: [] } },
  ])('invalidates $label on cold reconstruction before disclosure or tool connection', async (change) => {
    const first = await fixture();
    expect(await first.call('dev')).toBeUndefined();
    await first.step();
    const history = JSON.parse(JSON.stringify(first.context.get())) as ContextMessage[];
    first.dispose();
    const resumed = await fixture({ home: first.home, decision: 'rejected', records: change.records, target: change.target });
    expect(resumed.state.get(sessionSshHostsKey)).toEqual({});
    expect((await resumed.documents.get<{ sshHosts: unknown }>('sessions/session', 'state.json'))?.sshHosts).toEqual({});
    resumed.context.append(...history, userMessage('Continue.'));
    await resumed.step();
    expect(textOf(sshInjections(resumed.context).at(-1)!)).toContain('<ssh_hosts_removed>\ndev\n</ssh_hosts_removed>');
    expect(await resumed.call('dev')).toContain(change.records?.length === 0 ? 'not available' : 'not approved');
    expect(resumed.runtime.approveSshTarget).not.toHaveBeenCalled();
  });

  it('removes invalid live fingerprints and announces new target facts only after renewed approval', async () => {
    const f = await fixture();
    expect(await f.call('dev')).toBeUndefined();
    await f.step();
    vi.mocked(f.hosts.resolveTarget).mockResolvedValue({ hostname: 'redirect.example.test', user: 'other', port: 2202,
      identityFiles: [], userKnownHostsFiles: [] });
    await f.step();
    expect(textOf(sshInjections(f.context).at(-1)!)).toContain('<ssh_hosts_removed>\ndev\n</ssh_hosts_removed>');
    expect(f.state.get(sessionSshHostsKey)).toEqual({});
    expect((await f.metadata.read()).sshHosts).toEqual({});
    expect(await f.call('dev')).toBeUndefined();
    await f.step();
    expect(textOf(sshInjections(f.context).at(-1)!)).toContain('host: "dev" — Development — other@redirect.example.test:2202');
    expect(f.approvals.request).toHaveBeenCalledTimes(2);
  });

  it('serializes independent host joins without losing either membership', async () => {
    const f = await fixture();
    expect(await Promise.all([f.call('dev'), f.call('synced')])).toEqual([undefined, undefined]);
    expect(Object.keys(f.state.get(sessionSshHostsKey)).sort()).toEqual(['dev', 'synced']);
    expect((await f.documents.get<{ sshHosts: unknown }>('sessions/session', 'state.json'))?.sshHosts).toEqual(f.state.get(sessionSshHostsKey));
  });

  it('does not publish joined state or runtime approval when atomic persistence fails', async () => {
    const f = await fixture();
    vi.spyOn(f.documents, 'set').mockRejectedValueOnce(new Error('TEST_ONLY_WRITE_FAILURE'));
    await expect(f.call('dev')).rejects.toThrow('TEST_ONLY_WRITE_FAILURE');
    expect(f.state.get(sessionSshHostsKey)).toEqual({});
    expect(f.runtime.approveSshTarget).not.toHaveBeenCalled();
    expect((await f.documents.get<{ sshHosts?: unknown }>('sessions/session', 'state.json'))?.sshHosts).toBeUndefined();
    expect(await f.call('dev')).toBeUndefined();
    expect(f.state.get(sessionSshHostsKey)['dev']).toBeDefined();
  });
});


describe('SSH disclosure upgrades', () => {
  it.each([
    { label: 'legacy addition', content: '<ssh_hosts_added>\nDevelopment — tester@dev.example.test:22\n</ssh_hosts_added>' },
    { label: 'latest removal with a surviving legacy id', content: '<ssh_hosts_removed>\nsynced\n</ssh_hosts_removed>' },
  ])('re-discloses callable ids once for $label without rewriting history', async ({ content }) => {
    const f = await fixture();
    expect(await f.call('dev')).toBeUndefined();
    const previous: ContextMessage = { role: 'user', content: [{ type: 'text', text: content }], toolCalls: [],
      origin: { kind: 'injection', variant: 'ssh_hosts', disclosure: f.state.get(sessionSshHostsKey) } };
    f.context.append(previous, userMessage('Continue.'));
    await f.step();
    const upgraded = sshInjections(f.context).at(-1)!;
    expect(upgraded).not.toBe(previous);
    expect(textOf(upgraded)).toContain('host: "dev" — Development — tester@dev.example.test:22');
    expect(textOf(previous)).toBe(content);
    const count = f.context.get().length;
    await f.step();
    expect(f.context.get()).toHaveLength(count);
    expect(f.state.get(sessionSshHostsKey)['dev']).not.toContain('host: "dev"');
  });

  it('upgrades only the legacy id in a mixed old/new disclosure and then resumes deltas', async () => {
    const f = await fixture();
    expect(await Promise.all([f.call('dev'), f.call('synced')])).toEqual([undefined, undefined]);
    const rendered = await f.announce() as { content: string; disclosure: Readonly<Record<string, string>> };
    f.context.append({ role: 'user', content: [{ type: 'text', text: '<ssh_hosts_added>\nhost: "synced" — Synced — tester@dev.example.test:22\n</ssh_hosts_added>' }],
      toolCalls: [], origin: { kind: 'injection', variant: 'ssh_hosts', disclosure: {
        dev: f.state.get(sessionSshHostsKey)['dev'], synced: rendered.disclosure['synced'],
      } } });
    await f.step();
    const upgraded = textOf(sshInjections(f.context).at(-1)!);
    expect(upgraded).toContain('host: "dev"');
    expect(upgraded).not.toContain('host: "synced"');
    const count = f.context.get().length;
    await f.step();
    expect(f.context.get()).toHaveLength(count);
    await f.service.setSessionHosts((current) => ({ synced: current['synced']! }));
    await f.step();
    expect(textOf(sshInjections(f.context).at(-1)!)).toContain('<ssh_hosts_removed>\ndev\n</ssh_hosts_removed>');
  });
});


describe('restored SSH membership boundaries', () => {
  it('restores a hidden host only when the user had explicitly joined its exact fingerprint', async () => {
    const first = await fixture();
    const record = (await first.hosts.list('workspace', 'session')).find((entry) => entry.id === 'hidden')!;
    const fingerprint = sshHostFingerprint(record, await first.hosts.resolveTarget('hidden', 'workspace'));
    await first.service.setSessionHosts(() => ({ hidden: fingerprint }));
    first.dispose();
    const resumed = await fixture({ home: first.home });
    expect(resumed.state.get(sessionSshHostsKey)).toEqual({ hidden: fingerprint });
    await resumed.step();
    expect(textOf(sshInjections(resumed.context)[0]!)).toContain('host: "hidden" — Hidden');
    expect(resumed.runtime.approveSshTarget).not.toHaveBeenCalled();
  });

  it('recreates a session-only target through the existing host service and fingerprint-checks it before disclosure', async () => {
    const id = 'tester@dev.example.test:22';
    const first = await fixture();
    expect(await first.call(id)).toBeUndefined();
    const saved = first.state.get(sessionSshHostsKey);
    first.dispose();
    const resumed = await fixture({ home: first.home });
    expect(resumed.hosts.addTransient).toHaveBeenCalledWith(id, 'workspace', 'session');
    expect(resumed.state.get(sessionSshHostsKey)).toEqual(saved);
    await resumed.step();
    expect(textOf(sshInjections(resumed.context)[0]!)).toContain(`host: "${id}"`);
    expect(resumed.runtime.approveSshTarget).not.toHaveBeenCalled();
  });
});
