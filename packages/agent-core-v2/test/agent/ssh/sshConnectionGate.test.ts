import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SshConnectionGateService, sessionSshHostsKey } from '#/agent/ssh/sshConnectionGateService';
import type { BeforeResolveToolContext } from '#/agent/toolExecutor/toolHooks';
import type { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { IAgentContextInjectorService, ContextInjectionProvider } from '#/agent/contextInjector/contextInjector';
import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ISessionApprovalService } from '#/session/approval/approval';
import type { ISshHostService } from '#/app/ssh/sshService';
import { SessionStateService } from '#/session/state/sessionStateService';
import { matchPermissionRule } from '#/agent/permissionRules/matchesRule';
import { toolApprovalRule } from '#/agent/tools/os/sshToolTarget';

const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map((home) => rm(home, { force: true, recursive: true })));
});

async function fixture(options: { mode?: 'auto' | 'yolo'; agentId?: string; decision?: 'approved' | 'rejected' } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'kiki-ssh-approval-'));
  homes.push(home);
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
  const hosts = {
    list: vi.fn(async () => ([
      { id: 'dev', name: 'Development', source: 'kiki' },
      { id: 'synced', name: 'Synced', source: 'ssh-config' },
      { id: 'hidden', name: 'Hidden', source: 'kiki', agentAccess: 'hidden' },
    ])),
    resolveTarget: vi.fn(async () => ({
      hostname: 'dev.example.test', user: 'tester', port: 22, identityFiles: [],
      userKnownHostsFiles: [], proxyJump: undefined,
    })),
    connectionApprovalEnabled: vi.fn(async () => true),
    status: vi.fn(() => ({ hostId: 'dev', state: 'ready' as const, generation: 1 })),
    addTransient: vi.fn(async () => undefined),
    removeTransient: vi.fn(async () => undefined),
  } as unknown as ISshHostService;
  const state = new SessionStateService();
  let announcement: ContextInjectionProvider<Readonly<Record<string, string>>> | undefined;
  const injector = { register: (_name: string, provider: typeof announcement) => {
    announcement = provider;
    return { dispose: () => { announcement = undefined; } };
  } } as IAgentContextInjectorService;
  const service = new SshConnectionGateService(executor, runtime,
    { mode: options.mode ?? 'auto' } as IAgentPermissionModeService,
    { agentId: options.agentId ?? 'main' } as IAgentScopeContext,
    { sessionId: 'session' } as ISessionContext, state, approvals, hosts, injector);
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
  return { service, state, approvals, hosts, runtime, call, announce };
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
    f.service.dispose(); f.state.dispose();
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
    f.service.dispose(); f.state.dispose();
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
    f.service.dispose(); f.state.dispose();
  });

  it('lists a synced alias without joining it until approval or yolo selection', async () => {
    const f = await fixture({ decision: 'rejected' });
    expect(await f.announce()).toBeUndefined();
    expect(await f.call('synced')).toContain('not approved');
    expect(f.state.get(sessionSshHostsKey)).toEqual({});
    expect(f.runtime.approveSshTarget).not.toHaveBeenCalled();
    f.service.dispose(); f.state.dispose();
    const yolo = await fixture({ mode: 'yolo' });
    expect(await yolo.call('synced')).toBeUndefined();
    expect(yolo.state.get(sessionSshHostsKey)['synced']).toBeDefined();
    expect(yolo.approvals.request).not.toHaveBeenCalled();
    yolo.service.dispose(); yolo.state.dispose();
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
    f.service.dispose(); f.state.dispose();
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
    f.service.dispose(); f.state.dispose();
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
    f.service.dispose(); f.state.dispose();
  });

  it('allows yolo without connection approval, but requires main-session approval for subagents', async () => {
    const f = await fixture({ mode: 'yolo' });
    expect(await f.call('dev')).toBeUndefined();
    expect(f.approvals.request).not.toHaveBeenCalled();
    const approved = f.state.get(sessionSshHostsKey)['dev'];
    f.service.dispose(); f.state.dispose();
    const sub = await fixture({ agentId: 'subagent' });
    expect(await sub.call('dev')).toContain('subagent cannot connect');
    expect(sub.approvals.request).not.toHaveBeenCalled();
    sub.state.set(sessionSshHostsKey, { dev: approved! });
    expect(await sub.call('dev')).toBeUndefined();
    sub.service.dispose(); sub.state.dispose();
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
    f.service.dispose(); f.state.dispose();
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
    f.service.dispose(); f.state.dispose();
    const sub = await fixture({ agentId: 'subagent' });
    vi.mocked(sub.hosts.connectionApprovalEnabled).mockResolvedValue(false);
    expect(await sub.call('dev')).toContain('subagent cannot connect');
    sub.service.dispose(); sub.state.dispose();
  });

  it('announces only usable joined hosts once per new turn and emits incremental removals', async () => {
    const f = await fixture();
    expect(await f.announce()).toBeUndefined();
    expect(await f.call('dev')).toBeUndefined();
    expect(await f.announce(undefined, false)).toBeUndefined();
    const added = await f.announce() as { content: string; disclosure: Readonly<Record<string, string>> };
    expect(added.content).toContain('<ssh_hosts_added>\nDevelopment — tester@dev.example.test:22');
    expect(added.content).not.toContain('Hidden');
    expect(await f.announce(added.disclosure)).toBeUndefined();
    f.state.set(sessionSshHostsKey, {});
    const removed = await f.announce(added.disclosure) as { content: string; disclosure: Readonly<Record<string, string>> };
    expect(removed.content).toBe('<ssh_hosts_removed>\ndev\n</ssh_hosts_removed>');
    expect(removed.disclosure).toEqual({});
    f.service.dispose(); f.state.dispose();
  });
});
