import { randomUUID } from 'node:crypto';

import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { ISshHostService } from '#/app/ssh/sshService';
import type { SshHostRecord } from '#/app/ssh/sshHosts';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import type { ResolvedSshConfig } from '#/app/ssh/sshConfig';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { resolveSshToolTarget } from '#/agent/tools/os/sshToolTarget';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { BeforeResolveToolContext } from '#/agent/toolExecutor/toolHooks';
import { ISessionApprovalService } from '#/session/approval/approval';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionStateService } from '#/session/state/sessionState';
import { defineState } from '#/state/state';

export const sessionSshHostsKey = defineState<Readonly<Record<string, string>>>('ssh.sessionHosts', () => ({}));
export function sshHostFingerprint(record: SshHostRecord, target: ResolvedSshConfig): string {
  return JSON.stringify({ record, target });
}
const SSH_TOOLS = new Set(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'ReadMediaFile']);
export const ISshConnectionGateService = createDecorator<SshConnectionGateService>('sshConnectionGateService');

export class SshConnectionGateService extends Disposable {
  private readonly pending = new Map<string, Promise<string | undefined>>();
  private membershipQueue: Promise<void> = Promise.resolve();
  readonly ready: Promise<void>;

  constructor(
    @IAgentToolExecutorService executor: IAgentToolExecutorService,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @IAgentPermissionModeService private readonly mode: IAgentPermissionModeService,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionStateService private readonly state: ISessionStateService,
    @ISessionApprovalService private readonly approvals: ISessionApprovalService,
    @ISshHostService private readonly hosts: ISshHostService,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
  ) {
    super();
    if (!state.has(sessionSshHostsKey)) state.contributeState(sessionSshHostsKey);
    this.ready = this.restoreMembership();
    void this.ready.catch(() => {});
    this._register(executor.registerBeforeResolveTool((context) => this.beforeResolve(context)));
    this._register(injector.register<Readonly<Record<string, string>>>('ssh_hosts', async ({ isNewTurn, lastDisclosure }) => {
      if (!isNewTurn || this.runtime.nativeSshEnabled?.() !== true) return undefined;
      await this.ready;
      const workspaceId = this.runtime.inspect().identity.workspaceId;
      const joined = state.get(sessionSshHostsKey);
      const current: Record<string, string> = {};
      const lines: Record<string, string> = {};
      for (const record of await this.hosts.list(workspaceId, this.session.sessionId)) {
        if (joined[record.id] === undefined) continue;
        try {
          const target = await this.hosts.resolveTarget(record.id, workspaceId);
          if (joined[record.id] !== sshHostFingerprint(record, target)) continue;
          current[record.id] = sshHostFingerprint(record, target);
          lines[record.id] = `host: ${JSON.stringify(record.id)} — ${record.name} — ${target.user}@${target.hostname}:${target.port}${record.roots ? `, roots: ${record.roots.join(', ')}` : ''}${record.description ? ` · ${record.description}` : ''}`;
        } catch {
          continue;
        }
      }
      const stale = Object.keys(joined).filter((id) => current[id] !== joined[id]);
      if (stale.length > 0 && this.scope.agentId === 'main') {
        await this.setSessionHosts((latest) => Object.fromEntries(Object.entries(latest)
          .filter(([id, fingerprint]) => !stale.includes(id) || fingerprint !== joined[id])));
      }
      const disclosure = Object.fromEntries(Object.entries(current).map(([id, fingerprint]) => [id, `${lines[id]}\n${fingerprint}`]));
      const previous = lastDisclosure ?? {};
      const removed = Object.keys(previous).filter((id) => disclosure[id] !== previous[id]);
      const added = Object.keys(disclosure).filter((id) => disclosure[id] !== previous[id]);
      if (removed.length === 0 && added.length === 0) return undefined;
      const content = [
        removed.length > 0 ? `<ssh_hosts_removed>\n${removed.join('\n')}\n</ssh_hosts_removed>` : '',
        added.length > 0 ? `<ssh_hosts_added>\n${added.map((id) => lines[id]).join('\n')}\n</ssh_hosts_added>` : '',
      ].filter(Boolean).join('\n');
      return { content, disclosure };
    }));
  }

  setSessionHosts(update: (current: Readonly<Record<string, string>>) => Readonly<Record<string, string>>): Promise<void> {
    const run = this.membershipQueue.then(async () => {
      await this.ready;
      const current = this.state.get(sessionSshHostsKey);
      const next = update(current);
      if (Object.keys(next).length === Object.keys(current).length &&
          Object.keys(next).every((id) => next[id] === current[id])) return;
      await this.metadata.update({ sshHosts: next }, { touchUpdatedAt: false });
      this.state.set(sessionSshHostsKey, next);
    });
    this.membershipQueue = run.catch(() => {});
    return run;
  }

  private async restoreMembership(): Promise<void> {
    if (this.scope.agentId !== 'main') return;
    const stored = (await this.metadata.read()).sshHosts;
    if (stored === undefined) return;
    const workspaceId = this.runtime.inspect().identity.workspaceId;
    const current: Record<string, string> = {};
    const configured = await this.hosts.list(workspaceId, this.session.sessionId);
    for (const [id, fingerprint] of Object.entries(stored)) {
      let transient = false;
      try {
        let record = configured.find((entry) => entry.id === id);
        if (record === undefined && id.includes('@')) {
          await this.hosts.addTransient(id, workspaceId, this.session.sessionId);
          transient = true;
          record = (await this.hosts.list(workspaceId, this.session.sessionId)).find((entry) => entry.id === id);
        }
        if (record !== undefined && sshHostFingerprint(record, await this.hosts.resolveTarget(id, workspaceId)) === fingerprint) {
          current[id] = fingerprint;
        } else if (transient) await this.hosts.removeTransient(id, workspaceId, this.session.sessionId);
      } catch {
        if (transient) await this.hosts.removeTransient(id, workspaceId, this.session.sessionId);
      }
    }
    if (Object.keys(current).length !== Object.keys(stored).length) {
      await this.metadata.update({ sshHosts: current }, { touchUpdatedAt: false });
    }
    this.state.set(sessionSshHostsKey, current);
  }

  private async beforeResolve(context: BeforeResolveToolContext): Promise<string | undefined> {
    if (!SSH_TOOLS.has(context.tool.name) || this.runtime.nativeSshEnabled?.() !== true) return undefined;
    const args = context.args as { host?: string; path?: string };
    let target;
    try {
      target = resolveSshToolTarget(args.host, args.path);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    const runtimeId = target.host === undefined ? this.runtime.inspect().identity.runtimeId : target.host;
    const host = runtimeId.startsWith('ssh:') ? runtimeId.slice(4) : runtimeId === 'local' ? undefined : target.host;
    if (host === undefined) return undefined;
    await this.ready;
    const workspaceId = this.runtime.inspect().identity.workspaceId;
    let snapshot;
    let createdTransient = false;
    try {
      if (host.includes('@') && this.scope.agentId === 'main' &&
          !(await this.hosts.list(workspaceId, this.session.sessionId)).some((entry) => entry.id === host)) {
        await this.hosts.addTransient(host, workspaceId, this.session.sessionId);
        createdTransient = true;
      }
      snapshot = await this.snapshot(host, workspaceId);
    } catch (error) {
      return `Could not resolve SSH host "${host}": ${error instanceof Error ? error.message : String(error)}`;
    }
    if (snapshot === undefined) return `SSH host "${host}" is not available in the configured host list.`;
    const alreadyJoined = this.state.get(sessionSshHostsKey)[host] === snapshot.fingerprint;
    const existing = this.pending.get(host);
    if (existing !== undefined) return existing;
    const pending = this.approveHost(host, workspaceId, snapshot, context, alreadyJoined);
    this.pending.set(host, pending);
    try {
      const error = await pending;
      if (error !== undefined && createdTransient) await this.hosts.removeTransient(host, workspaceId, this.session.sessionId);
      return error;
    } catch (error) {
      if (createdTransient) await this.hosts.removeTransient(host, workspaceId, this.session.sessionId);
      throw error;
    } finally {
      if (this.pending.get(host) === pending) this.pending.delete(host);
    }
  }

  private async snapshot(host: string, workspaceId: string): Promise<{ record: SshHostRecord; fingerprint: string } | undefined> {
    const record = (await this.hosts.list(workspaceId, this.session.sessionId)).find((entry) => entry.id === host);
    if (record === undefined) return undefined;
    const target = await this.hosts.resolveTarget(host, workspaceId);
    const fingerprint = sshHostFingerprint(record, target);
    if (record.agentAccess === 'hidden' && this.state.get(sessionSshHostsKey)[host] !== fingerprint) return undefined;
    return { record, fingerprint };
  }

  private async approveHost(
    host: string, workspaceId: string, snapshot: { record: SshHostRecord; fingerprint: string },
    context: BeforeResolveToolContext, alreadyJoined: boolean,
  ): Promise<string | undefined> {
    if (!alreadyJoined && this.scope.agentId !== 'main') {
      return `SSH host "${host}" has not been added to this session; a subagent cannot connect it.`;
    }
    const target = await this.hosts.resolveTarget(host, workspaceId);
    let credential;
    const disconnected = alreadyJoined && ['idle', 'failed', 'disconnected'].includes(this.hosts.status(host, workspaceId).state);
    if ((!alreadyJoined || disconnected) && this.mode.mode !== 'yolo' && await this.hosts.connectionApprovalEnabled()) {
      const id = `approval_${randomUUID()}`;
      try {
        const result = await this.approvals.request({
          id,
          ssh: { kind: 'login', hostname: target.hostname, user: target.user, port: target.port,
            proxyJump: target.proxyJump, proxyCommand: target.proxyCommand },
          sessionId: this.session.sessionId,
          agentId: this.scope.agentId,
          turnId: context.turnId,
          toolCallId: context.toolCall.id,
          toolName: context.toolCall.name,
          action: `Connect SSH host ${snapshot.record.name} (${host})`,
          display: { kind: 'generic', summary: `Connect SSH host ${snapshot.record.name} (${host})`, detail: {
            host, hostname: target.hostname, user: target.user, port: target.port,
            proxyJump: target.proxyJump, proxyCommand: target.proxyCommand,
          } },
        });
        context.signal.throwIfAborted();
        if (result.decision !== 'approved') return `Connection to SSH host "${host}" was not approved.`;
        credential = this.approvals.takeSshCredential(id);
      } finally {
        this.approvals.clearSshCredential(id);
      }
    }
    context.signal.throwIfAborted();
    let current;
    try {
      current = await this.snapshot(host, workspaceId);
    } catch {
      return `SSH host "${host}" changed during connection approval. Retry the tool call.`;
    }
    if (current?.fingerprint !== snapshot.fingerprint) {
      return `SSH host "${host}" changed during connection approval. Retry the tool call.`;
    }
    const requestSsh = async (kind: 'host_key' | 'login', detail: {
      algorithm?: string; fingerprint?: string; prompts?: readonly { prompt: string; echo: boolean }[];
    }) => {
      context.signal.throwIfAborted();
      if (this.scope.agentId !== 'main') return { approved: false, credential: undefined };
      const id = `approval_${randomUUID()}`;
      try {
        const response = await this.approvals.request({
          id, sessionId: this.session.sessionId, agentId: this.scope.agentId,
          turnId: context.turnId, toolCallId: context.toolCall.id, toolName: context.toolCall.name,
          action: kind === 'host_key' ? `Trust SSH host key ${host}` : `SSH authentication for ${host}`,
          ssh: { kind, hostname: target.hostname, user: target.user, port: target.port,
            proxyJump: target.proxyJump, proxyCommand: target.proxyCommand, ...detail },
          display: { kind: 'generic', summary: kind === 'host_key' ? `Trust SSH host key ${host}` : `SSH authentication for ${host}`,
            detail: { host, hostname: target.hostname, algorithm: detail.algorithm,
              fingerprint: detail.fingerprint, prompts: detail.prompts } },
        });
        context.signal.throwIfAborted();
        return { approved: response.decision === 'approved', credential: this.approvals.takeSshCredential(id) };
      } finally {
        this.approvals.clearSshCredential(id);
      }
    };
    const trustUnknown = async (key: { hostname: string; port: number; algorithm: string; fingerprint: string }) => {
      if (key.hostname !== target.hostname || key.port !== target.port) return false;
      return (await requestSsh('host_key', { algorithm: key.algorithm, fingerprint: key.fingerprint })).approved;
    };
    const keyboardInteractive = async (prompts: readonly { prompt: string; echo: boolean }[]) => {
      const answer = await requestSsh('login', { prompts });
      return answer.approved ? answer.credential?.answers ?? [] : [];
    };
    context.signal.throwIfAborted();
    await this.setSessionHosts((joined) => ({ ...joined, [host]: snapshot.fingerprint }));
    context.signal.throwIfAborted();
    this.runtime.approveSshTarget?.(host, snapshot.fingerprint, trustUnknown, credential, keyboardInteractive);
    return undefined;
  }
}

registerScopedService(LifecycleScope.Agent, ISshConnectionGateService, SshConnectionGateService, ScopeActivation.OnScopeCreated, 'ssh');
