import { Service } from '#/_base/di/service';
import { ref, type LiveRef, type ServiceIdentifier } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IHookRulesSession, ISessionHookWorkspace } from './hookRules';
import { matchesHook } from '../internal/rules';
import { IntervalTimer } from '#/_base/utils/timer';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IModelService } from '#/kosong/model/model';
import { effectiveModelConfig, resolveModelProviderId } from '#/kosong/model/modelAuth';
import { IProviderService } from '#/kosong/provider/provider';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import {
  ISessionAgentProfileCatalog,
} from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import {
  type AgentTaskStartHookContext,
  type AgentTaskStopHookContext,
  ISessionSubagentService,
} from '#/session/subagent/subagent';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  type SessionCloseReason,
  type SessionCreateSource,
} from '#/workspace/sessionLifecycle/sessionLifecycle';

import { HookResult } from '../agent/agentExternalHooksService';
import { IExternalHooksRunnerService } from '../app/externalHooksRunner';
import type { HookDef } from '../internal/types';
import { renderHookContextResult, type RenderedHookResult } from '../internal/userPrompt';
import { ISessionExternalHooksService, type SkillHookRegistration } from './sessionExternalHooks';

type SessionStartHookSource = Exclude<SessionCreateSource, 'fork'>;

const HEARTBEAT_INTERVAL_MS = 60_000;

export class SessionExternalHooksService
  extends Service
  implements ISessionExternalHooksService
{
  declare readonly _serviceBrand: undefined;

  private sessionTitle: string | undefined;
  private readonly createdAt = Date.now();
  private readonly activeSkillHooks = new Map<string, { readonly hooks: readonly HookDef[]; readonly requiresWorkspaceTrust: boolean }>();
  private readonly lifecycleSubscriptions = this._register(new DisposableStore());
  private pendingSessionStartHook: RenderedHookResult | undefined;

  constructor(
    @ISessionContext private readonly context: ISessionContext,
    @ISessionManager lifecycle: ISessionManager,
    @ISessionSubagentService subagents: ISessionSubagentService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionAgentProfileCatalog private readonly profiles: ISessionAgentProfileCatalog,
    @IModelService private readonly models: IModelService,
    @IExternalHooksRunnerService private readonly runner: IExternalHooksRunnerService,
    @ref(IHookRulesSession) private readonly hookRules: LiveRef<IHookRulesSession>,
    @ref(ISessionHookWorkspace) private readonly workspaceRef: LiveRef<ISessionHookWorkspace>,
    @ref(IProviderService) private readonly providerRef: LiveRef<IProviderService>,
    @ref(IAgentLifecycleService) private readonly agentLifecycleRef?: LiveRef<IAgentLifecycleService>,
  ) {
    super();
    void this.metadata
      .read()
      .then((meta) => {
        this.sessionTitle = meta.title;
      })
      .catch(() => undefined);
    this._register(
      this.metadata.onDidChangeMetadata((event) => {
        if (!event.changed.includes('title')) return;
        void this.metadata
          .read()
          .then((meta) => {
            this.sessionTitle = meta.title;
          })
          .catch(() => undefined);
      }),
    );
    const onDidCreate = lifecycle.onDidCreateSession;
    if (onDidCreate !== undefined) {
      this._register(
        onDidCreate((event) => {
          if (event.sessionId !== this.context.sessionId) return;
          if (event.source !== 'fork') {
            event.waitUntil(this.triggerSessionStart(event.source));
          }
        }),
      );
    }
    const onWillClose = lifecycle.onWillCloseSession;
    if (onWillClose !== undefined) {
      this._register(
        onWillClose((event) => {
          if (event.sessionId !== this.context.sessionId) return;
          event.waitUntil(this.triggerSessionEnd(event.reason));
        }),
      );
    }
    this._register(
      subagents.hooks.onWillStartAgentTask.register('externalHooks', async (ctx, next) => {
        await this.runSubagentStart(ctx);
        await next();
      }),
    );
    this._register(subagents.onDidStopAgentTask((ctx) => this.notifySubagentStop(ctx)));

    void this.runner.ready
      .then(() => this.syncHeartbeat())
      .catch(() => undefined);
    this._register(this.runner.onDidReload(() => this.syncHeartbeat()));
    this.bindAgentLifecycle();
    if (this.agentLifecycleRef !== undefined) {
      this._register(this.agentLifecycleRef.onDidChange(() => { this.bindAgentLifecycle(); }));
    }
  }

  private readonly heartbeat = this._register(new IntervalTimer({ unref: true }));

  registerSkillHooks(registration: SkillHookRegistration): void {
    if (registration.hooks.length === 0) return;
    const requiresWorkspaceTrust =
      registration.source === 'project' ||
      (registration.source === 'extra' && registration.pluginId === undefined);
    this.activeSkillHooks.set(registration.skillPath, {
      hooks: registration.hooks,
      requiresWorkspaceTrust,
    });
    if (registration.hooks.some((hook) => hook.event === 'SessionHeartbeat')) {
      this.syncHeartbeat();
    }
  }

  async getSkillHooks(): Promise<readonly HookDef[]> {
    if (this.activeSkillHooks.size === 0) return [];
    let workspaceTrusted: boolean | undefined;
    const hooks: HookDef[] = [];
    for (const entry of this.activeSkillHooks.values()) {
      if (entry.requiresWorkspaceTrust) {
        if (workspaceTrusted === undefined) {
          const workspace = this.workspaceRef.current;
          if (workspace === undefined) {
            workspaceTrusted = false;
          } else {
            await workspace.trust.ready;
            workspaceTrusted = workspace.trust.isTrusted();
          }
        }
        if (!workspaceTrusted) continue;
      }
      hooks.push(...entry.hooks);
    }
    return hooks;
  }

  private hasActiveSkillHooksFor(event: string): boolean {
    for (const entry of this.activeSkillHooks.values()) {
      if (entry.hooks.some((hook) => hook.event === event)) return true;
    }
    return false;
  }

  private bindAgentLifecycle(): void {
    void this.lifecycleSubscriptions.clear();
    const lifecycle = this.agentLifecycleRef?.current;
    if (lifecycle === undefined) return;
    if (this.pendingSessionStartHook !== undefined) {
      const main = lifecycle.get(MAIN_AGENT_ID);
      if (main !== undefined) {
        const pending = this.pendingSessionStartHook;
        this.pendingSessionStartHook = undefined;
        this.deliverContextToAgent(main, pending);
      }
    }
    this.lifecycleSubscriptions.add(
      lifecycle.onDidCreate((handle) => {
        if (handle.id !== MAIN_AGENT_ID || this.pendingSessionStartHook === undefined) return;
        const pending = this.pendingSessionStartHook;
        this.pendingSessionStartHook = undefined;
        this.deliverContextToAgent(handle, pending);
      }),
    );
  }

  private deliverContextToAgent(handle: IAgentScopeHandle, rendered: RenderedHookResult): void {
    const context = optionalFromHandle(handle, IAgentContextMemoryService);
    if (context === undefined) return;
    const message: ContextMessage = {
      role: 'user',
      content: [{ type: 'text', text: rendered.text }],
      toolCalls: [],
      origin: { kind: 'hook_result', event: rendered.event },
    };
    context.appendObservable(message);
    void optionalFromHandle(handle, IEventDispatcher)?.dispatch(
      new HookResult({ hookEvent: rendered.event, content: rendered.message }),
    );
  }

  private syncHeartbeat(): void {
    try {
      if (this.runner.hasHooksFor('SessionHeartbeat') || this.hasActiveSkillHooksFor('SessionHeartbeat')) {
        this.heartbeat.cancelAndSet(() => this.tickHeartbeat(), HEARTBEAT_INTERVAL_MS);
      } else {
        this.heartbeat.cancel();
      }
    } catch {}
  }

  private sessionFacts(): Record<string, unknown> {
    const workspace = this.workspaceRef.current;
    return {
      sessionTitle: this.sessionTitle,
      workspaceId: workspace?.runtime.identity.workspaceId ?? this.context.workspaceId,
      executionTarget: workspace?.runtime.identity.runtimeId,
    };
  }

  private defaultModelFacts(alias: string | undefined): {
    canonicalModelId?: string;
    remoteModelId?: string;
    providerId?: string;
    providerType?: string;
  } {
    if (alias === undefined) return {};
    const canonicalModelId = this.models.resolveId?.(alias) ?? alias;
    const record = this.models.get?.(canonicalModelId) ?? this.models.get?.(alias);
    const providerId = record === undefined ? undefined : resolveModelProviderId(record, this.providerRef.current?.getDefaultProvider?.());
    const providerType = (providerId === undefined ? undefined : this.providerRef.current?.get?.(providerId)?.type) ?? record?.protocol;
    const effective = record === undefined ? undefined : effectiveModelConfig(record, providerType);
    const remoteModelId = effective === undefined ? canonicalModelId : (effective.name ?? effective.model ?? canonicalModelId);
    return { canonicalModelId, remoteModelId, providerId, providerType };
  }

  private async triggerSessionStart(source: SessionStartHookSource): Promise<void> {
    const alias = this.models.getDefaultModel();
    const modelFacts = this.defaultModelFacts(alias);
    const profileName = await this.defaultProfileName();
    const workspace = this.workspaceRef.current;
    const rules = this.hookRules.current;
    if (rules !== undefined) {
      await rules.ready;
      const snapshot = rules.snapshot();
      const event = {
        schemaVersion: 2 as const, event: 'session.start' as const,
        eventId: `${this.context.sessionId}/start/${source}`, occurredAt: new Date().toISOString(),
        sessionId: this.context.sessionId, sessionTitle: this.sessionTitle, cwd: this.context.cwd,
        workspaceId: workspace?.runtime.identity.workspaceId ?? this.context.workspaceId,
        executionTarget: workspace?.runtime.identity.runtimeId,
        modelAlias: alias,
        reason: source === 'resume' ? 'resume' : 'new',
        modelId: modelFacts.canonicalModelId,
        remoteModelId: modelFacts.remoteModelId,
        providerId: modelFacts.providerId,
        providerType: modelFacts.providerType,
        profileId: profileName, profileName, configRevision: snapshot.revision,
        hookDepth: 0 as const, isReplay: false as const, allowedActions: ['observe'] as const,
      };
      for (const rule of snapshot.rules) {
        if (rule.rule.action.type === 'observe' && matchesHook(rule, event)) rules.observe(event, rule.id);
      }
    }
    const results = await this.runner.trigger('SessionStart', {
      matcherValue: source,
      cwd: this.context.cwd,
      sessionId: this.context.sessionId,
      additionalHooks: () => this.getSkillHooks(),
      inputData: {
        ...this.sessionFacts(),
        source,
        model: alias,
        modelAlias: alias,
        modelId: modelFacts.remoteModelId,
        providerId: modelFacts.providerId,
        providerType: modelFacts.providerType,
        profile: profileName,
        profileId: profileName,
        profileName,
      },
    });
    const rendered = renderHookContextResult('SessionStart', results);
    if (rendered !== undefined) {
      const main = this.agentLifecycleRef?.current?.get(MAIN_AGENT_ID);
      if (main !== undefined) {
        this.deliverContextToAgent(main, rendered);
      } else {
        this.pendingSessionStartHook = rendered;
      }
    }
  }

  private async defaultProfileName(): Promise<string | undefined> {
    try {
      await this.profiles.ready;
      return this.profiles.getDefault().name;
    } catch {
      return undefined;
    }
  }

  private async triggerSessionEnd(reason: SessionCloseReason): Promise<void> {
    await this.runner.trigger('SessionEnd', {
      matcherValue: reason,
      cwd: this.context.cwd,
      sessionId: this.context.sessionId,
      additionalHooks: () => this.getSkillHooks(),
      inputData: { ...this.sessionFacts(), reason },
    });
  }

  private tickHeartbeat(): void {
    try {
      if (!this.runner.hasHooksFor('SessionHeartbeat') && !this.hasActiveSkillHooksFor('SessionHeartbeat')) return;
      void this.runner.fireAndForgetTrigger('SessionHeartbeat', {
        cwd: this.context.cwd,
        sessionId: this.context.sessionId,
        additionalHooks: () => this.getSkillHooks(),
        inputData: {
          ...this.sessionFacts(),
          uptimeMs: Date.now() - this.createdAt,
        },
      });
    } catch {}
  }

  private async runSubagentStart(ctx: AgentTaskStartHookContext): Promise<void> {
    ctx.signal.throwIfAborted();
    const childHandle = ctx.agentId === undefined ? undefined : this.agentLifecycleRef?.current?.get(ctx.agentId);
    const childScope = childHandle === undefined ? undefined : optionalFromHandle(childHandle, IAgentScopeContext);
    const childProfile = childHandle === undefined ? undefined : optionalFromHandle(childHandle, IAgentProfileService)?.data?.();
    const agentId = ctx.agentId ?? childScope?.agentId;
    const parentAgentId = ctx.parentAgentId ?? childScope?.parentAgentId;
    const profileName = ctx.profileName ?? childProfile?.profileName ?? ctx.agentName;
    const agentRole = ctx.agentRole ?? (parentAgentId !== undefined ? 'subagent' : undefined);
    const results = await this.runner.trigger('SubagentStart', {
      matcherValue: ctx.agentName,
      signal: ctx.signal,
      cwd: this.context.cwd,
      sessionId: this.context.sessionId,
      additionalHooks: () => this.getSkillHooks(),
      inputData: {
        ...this.sessionFacts(),
        agentName: ctx.agentName,
        agentId,
        parentAgentId,
        agentRole,
        profileName,
        prompt: ctx.prompt,
      },
    });
    ctx.signal.throwIfAborted();
    const rendered = renderHookContextResult('SubagentStart', results);
    if (rendered !== undefined) {
      if (ctx.appendContext !== undefined) {
        ctx.appendContext({
          role: 'user',
          content: [{ type: 'text', text: rendered.text }],
          toolCalls: [],
          origin: { kind: 'hook_result', event: rendered.event },
        });
        if (childHandle !== undefined) {
          void optionalFromHandle(childHandle, IEventDispatcher)?.dispatch(
            new HookResult({ hookEvent: rendered.event, content: rendered.message }),
          );
        }
      } else if (childHandle !== undefined) {
        this.deliverContextToAgent(childHandle, rendered);
      }
    }
  }

  private notifySubagentStop(ctx: AgentTaskStopHookContext): void {
    void this.runner.fireAndForgetTrigger('SubagentStop', {
      matcherValue: ctx.agentName,
      cwd: this.context.cwd,
      sessionId: this.context.sessionId,
      additionalHooks: () => this.getSkillHooks(),
      inputData: {
        ...this.sessionFacts(),
        agentName: ctx.agentName,
        response: ctx.response,
      },
    });
  }
}

function optionalFromHandle<T>(handle: IAgentScopeHandle, id: ServiceIdentifier<T>): T | undefined {
  try {
    return handle.accessor.get(id);
  } catch {
    return undefined;
  }
}
