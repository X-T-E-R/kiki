import { Service } from '#/_base/di/service';
import { ref, type LiveRef } from '#/_base/di/instantiation';
import { IHookRulesSession, ISessionHookWorkspace } from './hookRules';
import { matchesHook } from '../internal/rules';
import { IntervalTimer } from '#/_base/utils/timer';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IModelService } from '#/kosong/model/model';
import { effectiveModelConfig, resolveModelProviderId } from '#/kosong/model/modelAuth';
import { IProviderService } from '#/kosong/provider/provider';
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
import {
  type SessionCloseReason,
  type SessionCreateSource,
} from '#/workspace/sessionLifecycle/sessionLifecycle';

import { IExternalHooksRunnerService } from '../app/externalHooksRunner';
import { ISessionExternalHooksService } from './sessionExternalHooks';

type SessionStartHookSource = Exclude<SessionCreateSource, 'fork'>;

const HEARTBEAT_INTERVAL_MS = 60_000;

export class SessionExternalHooksService
  extends Service
  implements ISessionExternalHooksService
{
  declare readonly _serviceBrand: undefined;

  private sessionTitle: string | undefined;
  private readonly createdAt = Date.now();

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
  }

  private readonly heartbeat = this._register(new IntervalTimer({ unref: true }));

  private syncHeartbeat(): void {
    try {
      if (this.runner.hasHooksFor('SessionHeartbeat')) {
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
    await this.runner.trigger('SessionStart', {
      matcherValue: source,
      cwd: this.context.cwd,
      sessionId: this.context.sessionId,
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
      inputData: { ...this.sessionFacts(), reason },
    });
  }

  private tickHeartbeat(): void {
    try {
      if (!this.runner.hasHooksFor('SessionHeartbeat')) return;
      void this.runner.fireAndForgetTrigger('SessionHeartbeat', {
        cwd: this.context.cwd,
        sessionId: this.context.sessionId,
        inputData: {
          ...this.sessionFacts(),
          uptimeMs: Date.now() - this.createdAt,
        },
      });
    } catch {}
  }

  private async runSubagentStart(ctx: AgentTaskStartHookContext): Promise<void> {
    ctx.signal.throwIfAborted();
    await this.runner.trigger('SubagentStart', {
      matcherValue: ctx.agentName,
      signal: ctx.signal,
      cwd: this.context.cwd,
      sessionId: this.context.sessionId,
      inputData: {
        ...this.sessionFacts(),
        agentName: ctx.agentName,
        prompt: ctx.prompt,
      },
    });
    ctx.signal.throwIfAborted();
  }

  private notifySubagentStop(ctx: AgentTaskStopHookContext): void {
    void this.runner.fireAndForgetTrigger('SubagentStop', {
      matcherValue: ctx.agentName,
      cwd: this.context.cwd,
      sessionId: this.context.sessionId,
      inputData: {
        ...this.sessionFacts(),
        agentName: ctx.agentName,
        response: ctx.response,
      },
    });
  }
}
