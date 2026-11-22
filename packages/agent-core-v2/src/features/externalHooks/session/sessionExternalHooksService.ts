import { dirname, isAbsolute, relative, resolve } from 'pathe';
import { z } from 'zod';

import { Service } from '#/_base/di/service';
import { ref, type LiveRef, type ServiceIdentifier } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IHookRulesSession, ISessionHookWorkspace } from './hookRules';
import { matchesHook } from '../internal/rules';
import { IntervalTimer } from '#/_base/utils/timer';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentRuntimeBindingService } from '#/agent/runtimeBinding/runtimeBinding';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSystemReminderService, wrapSystemReminder } from '#/agent/systemReminder/systemReminder';
import { IPluginService } from '#/app/plugin/plugin';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import type { SkillSource } from '#/app/skillCatalog/types';
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

import { IAgentExternalHooksService } from '../agent/agentExternalHooks';
import { HookResult } from '../agent/agentExternalHooksService';
import { IExternalHooksRunnerService } from '../app/externalHooksRunner';
import { HookDefSchema } from '../configSection';
import { agentHookDirectories } from '../internal/bindingContext';
import type { HookDef } from '../internal/types';
import { renderHookContextResult, type RenderedHookResult } from '../internal/userPrompt';
import { ISessionExternalHooksService, type SkillHookRegistration } from './sessionExternalHooks';

type SessionStartHookSource = Exclude<SessionCreateSource, 'fork'>;

const HEARTBEAT_INTERVAL_MS = 60_000;
const ACTIVE_SKILL_HOOKS_KEY = 'active_skill_hooks';

const PersistedSkillHookSchema = HookDefSchema.extend({
  pluginId: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const PersistedSkillHookEntrySchema = z.object({
  skillName: z.string().min(1),
  skillPath: z.string().min(1),
  skillDir: z.string().min(1),
  source: z.enum(['builtin', 'user', 'project', 'extra']),
  pluginId: z.string().min(1).optional(),
  hooks: z.array(PersistedSkillHookSchema),
});

const PersistedSkillHooksSchema = z.array(PersistedSkillHookEntrySchema);

interface ActiveSkillHookEntry {
  readonly skillName: string;
  readonly skillPath: string;
  readonly skillDir: string;
  readonly source: SkillSource;
  readonly pluginId?: string;
  readonly hooks: readonly HookDef[];
  readonly requiresWorkspaceTrust: boolean;
}

export class SessionExternalHooksService
  extends Service
  implements ISessionExternalHooksService
{
  declare readonly _serviceBrand: undefined;

  private sessionTitle: string | undefined;
  private readonly createdAt = Date.now();
  private readonly activeSkillHooks = new Map<string, ActiveSkillHookEntry>();
  private readonly workspaceContainmentCache = new Map<string, boolean>();
  private readonly evaluatedSubagentStops = new Set<string>();
  private readonly lifecycleSubscriptions = this._register(new DisposableStore());
  private readonly hydrationReady: Promise<void>;
  private persistQueue: Promise<void> = Promise.resolve();
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
    @ref(IPluginService) private readonly pluginsRef?: LiveRef<IPluginService>,
  ) {
    super();
    this.hydrationReady = this.metadata
      .read()
      .then((meta) => {
        this.sessionTitle = meta.title;
        this.hydratePersistedSkillHooks(meta.custom?.[ACTIVE_SKILL_HOOKS_KEY]);
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
    const skillDir = registration.skillDir ?? dirname(registration.skillPath);
    const pluginId = registration.pluginId;
    const hooks = pluginId === undefined
      ? registration.hooks
      : registration.hooks.map((hook) => ({ ...hook, pluginId }));
    const requiresWorkspaceTrust =
      registration.source === 'project' ||
      (registration.source === 'extra' && pluginId === undefined);
    this.activeSkillHooks.set(registration.skillPath, {
      skillName: registration.skillName,
      skillPath: registration.skillPath,
      skillDir,
      source: registration.source,
      pluginId,
      hooks,
      requiresWorkspaceTrust,
    });
    if (hooks.some((hook) => hook.event === 'SessionHeartbeat')) {
      this.syncHeartbeat();
    }
    this.persistQueue = this.persistQueue
      .then(() => this.persistActiveSkillHooks())
      .catch(() => undefined);
  }

  async getSkillHooks(): Promise<readonly HookDef[]> {
    await this.hydrationReady;
    if (this.activeSkillHooks.size === 0) return [];
    let workspaceTrusted: boolean | undefined;
    let enabledPluginIds: ReadonlySet<string> | undefined;
    let pluginsChecked = false;
    const hooks: HookDef[] = [];
    for (const entry of this.activeSkillHooks.values()) {
      if (entry.pluginId !== undefined) {
        if (!pluginsChecked) {
          pluginsChecked = true;
          const plugins = this.pluginsRef?.current;
          if (plugins?.pluginSkillRoots !== undefined && (plugins.hasLoadedSnapshot?.() ?? true)) {
            const roots = await plugins.pluginSkillRoots(this.context.workspaceId, this.context.sessionId);
            enabledPluginIds = new Set(
              roots
                .map((root) => root.plugin?.id)
                .filter((id): id is string => id !== undefined),
            );
          }
        }
        if (enabledPluginIds !== undefined && !enabledPluginIds.has(entry.pluginId)) {
          continue;
        }
      } else {
        const needsTrust = entry.requiresWorkspaceTrust || await this.isInsideWorkspaceRoot(entry.skillDir);
        if (needsTrust) {
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
      }
      hooks.push(...entry.hooks);
    }
    return hooks;
  }

  markSubagentStopEvaluated(agentId: string): void {
    this.evaluatedSubagentStops.add(agentId);
  }

  private hydratePersistedSkillHooks(raw: unknown): void {
    if (raw === undefined) return;
    const parsed = PersistedSkillHooksSchema.safeParse(raw);
    if (!parsed.success) return;
    let hasHeartbeat = false;
    for (const entry of parsed.data) {
      if (entry.hooks.length === 0 || this.activeSkillHooks.has(entry.skillPath)) continue;
      const hooks = entry.pluginId === undefined
        ? entry.hooks
        : entry.hooks.map((hook) => ({ ...hook, pluginId: entry.pluginId }));
      const requiresWorkspaceTrust =
        entry.source === 'project' ||
        (entry.source === 'extra' && entry.pluginId === undefined);
      this.activeSkillHooks.set(entry.skillPath, {
        skillName: entry.skillName,
        skillPath: entry.skillPath,
        skillDir: entry.skillDir,
        source: entry.source,
        pluginId: entry.pluginId,
        hooks,
        requiresWorkspaceTrust,
      });
      if (hooks.some((hook) => hook.event === 'SessionHeartbeat')) {
        hasHeartbeat = true;
      }
    }
    if (hasHeartbeat) {
      this.syncHeartbeat();
    }
  }

  private async persistActiveSkillHooks(): Promise<void> {
    await this.hydrationReady;
    if (this.metadata.update === undefined) return;
    const serialized = [...this.activeSkillHooks.values()].map((entry) => ({
      skillName: entry.skillName,
      skillPath: entry.skillPath,
      skillDir: entry.skillDir,
      source: entry.source,
      pluginId: entry.pluginId,
      hooks: entry.hooks,
    }));
    const current = await this.metadata.read();
    await this.metadata.update(
      {
        custom: {
          ...current.custom,
          [ACTIVE_SKILL_HOOKS_KEY]: serialized,
        },
      },
      { touchUpdatedAt: false },
    );
  }

  private async isInsideWorkspaceRoot(skillDir: string): Promise<boolean> {
    const workspace = this.workspaceRef.current;
    const workspaceRoot = workspace?.root ?? this.context.cwd;
    if (workspaceRoot === undefined || workspaceRoot.length === 0) return false;
    const cacheKey = `${workspaceRoot}\0${skillDir}`;
    const cached = this.workspaceContainmentCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const fs = workspace?.runtime.fs;
    const resolveCanonical = async (target: string): Promise<string> => {
      if (fs !== undefined) {
        try {
          return await fs.realpath(target);
        } catch {}
      }
      return resolve(target);
    };
    const [canonRoot, canonDir] = await Promise.all([
      resolveCanonical(workspaceRoot),
      resolveCanonical(skillDir),
    ]);
    const normalizedRoot = process.platform === 'win32' ? canonRoot.toLowerCase() : canonRoot;
    const normalizedDir = process.platform === 'win32' ? canonDir.toLowerCase() : canonDir;
    const rel = relative(normalizedRoot, normalizedDir);
    const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    this.workspaceContainmentCache.set(cacheKey, inside);
    return inside;
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
    const origin: PromptOrigin = { kind: 'injection', variant: `hook/${rendered.event}` };
    const reminder = optionalFromHandle(handle, IAgentSystemReminderService);
    if (reminder !== undefined) {
      reminder.appendSystemReminder(rendered.text, origin);
    } else {
      const context = optionalFromHandle(handle, IAgentContextMemoryService);
      if (context === undefined) return;
      const message: ContextMessage = {
        role: 'user',
        content: [{ type: 'text', text: wrapSystemReminder(rendered.text) }],
        toolCalls: [],
        origin,
      };
      context.appendObservable(message);
    }
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

  private subagentHookDirectories(child: IAgentScopeHandle | undefined) {
    return agentHookDirectories(
      this.context.cwd,
      child === undefined ? undefined : optionalFromHandle(child, IAgentRuntimeService),
      child === undefined ? undefined : optionalFromHandle(child, IAgentRuntimeBindingService),
    );
  }

  private async runSubagentStart(ctx: AgentTaskStartHookContext): Promise<void> {
    ctx.signal.throwIfAborted();
    const childHandle = ctx.agentId === undefined ? undefined : this.agentLifecycleRef?.current?.get(ctx.agentId);
    const childScope = childHandle === undefined ? undefined : optionalFromHandle(childHandle, IAgentScopeContext);
    const childProfile = childHandle === undefined ? undefined : optionalFromHandle(childHandle, IAgentProfileService)?.data?.();
    const agentId = ctx.agentId ?? childScope?.agentId;
    if (agentId !== undefined) {
      this.evaluatedSubagentStops.delete(agentId);
    }
    const parentAgentId = ctx.parentAgentId ?? childScope?.parentAgentId;
    const profileName = ctx.profileName ?? childProfile?.profileName ?? ctx.agentName;
    const routeId = ctx.routeId ?? childProfile?.routeId;
    const agentRole = ctx.agentRole ?? (parentAgentId !== undefined ? 'subagent' : undefined);
    const results = await this.runner.trigger('SubagentStart', {
      matcherValue: ctx.agentName,
      signal: ctx.signal,
      getDirectories: () => this.subagentHookDirectories(childHandle),
      sessionId: this.context.sessionId,
      additionalHooks: () => this.getSkillHooks(),
      inputData: {
        ...this.sessionFacts(),
        agentName: ctx.agentName,
        agentId,
        parentAgentId,
        agentRole,
        profileName,
        routeId,
        prompt: ctx.prompt,
      },
    });
    ctx.signal.throwIfAborted();
    const rendered = renderHookContextResult('SubagentStart', results);
    if (rendered !== undefined) {
      const origin: PromptOrigin = { kind: 'injection', variant: `hook/${rendered.event}` };
      if (ctx.appendReminder !== undefined) {
        ctx.appendReminder(rendered.text, origin);
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
    const child = ctx.agentId === undefined ? undefined : this.agentLifecycleRef?.current?.get(ctx.agentId);
    if (ctx.autonomousTurnId === undefined) {
      if (ctx.agentId !== undefined && this.evaluatedSubagentStops.delete(ctx.agentId)) return;
    } else if (child !== undefined && optionalFromHandle(child, IAgentExternalHooksService)?.consumeAutonomousStop(ctx.autonomousTurnId)) {
      return;
    }
    void this.runner.fireAndForgetTrigger('SubagentStop', {
      matcherValue: ctx.agentName,
      getDirectories: () => this.subagentHookDirectories(child),
      sessionId: this.context.sessionId,
      additionalHooks: () => this.getSkillHooks(),
      inputData: {
        ...this.sessionFacts(),
        agentId: ctx.agentId,
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
