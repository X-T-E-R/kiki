import { Disposable, DisposableStore } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService, type IAgentScopeHandle } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { ILogService } from '#/_base/log/log';
import { IEventBus } from '#/app/event/eventBus';
import { IEventService } from '#/app/event/event';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { trackSessionMetadataWork } from '#/session/sessionMetadata/sessionMetadataService';
import { SessionMetaUpdated } from '#/session/sessionMetadata/sessionMetaEvents';
import { createDecorator } from '#/_base/di/instantiation';
import { activityParentId, ISessionRecencyStore } from './sessionRecency';

export interface ISessionRecencyService { readonly _serviceBrand: undefined }
export const ISessionRecencyService = createDecorator<ISessionRecencyService>('sessionRecency');

export class SessionRecencyService extends Disposable implements ISessionRecencyService {
  declare readonly _serviceBrand: undefined;
  private readonly subscriptions = new Map<string, DisposableStore>();

  constructor(
    @IAgentLifecycleService agents: IAgentLifecycleService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionContext private readonly context: ISessionContext,
    @ISessionRecencyStore private readonly recency: ISessionRecencyStore,
    @IEventService private readonly events: IEventService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    for (const handle of agents.list()) this.attach(handle);
    this._register(agents.onDidCreate((handle) => this.attach(handle)));
    this._register(agents.onDidDispose((id) => {
      this.subscriptions.get(id)?.dispose();
      this.subscriptions.delete(id);
    }));
    this._register({ dispose: () => {
      for (const subscription of this.subscriptions.values()) subscription.dispose();
      this.subscriptions.clear();
    } });
  }

  private attach(handle: IAgentScopeHandle): void {
    if (this.subscriptions.has(handle.id)) return;
    const bus = handle.accessor.get(IEventBus);
    const subscriptions = new DisposableStore();
    this.subscriptions.set(handle.id, subscriptions);
    subscriptions.add(bus.subscribe(TurnStarted, () => this.record(Date.now())));
    subscriptions.add(bus.subscribe(TurnEnded, () => this.record(Date.now())));
  }

  private record(at: number): void {
    if (this.context.ephemeral === true) return;
    const work = this.metadata.update({ activityUpdatedAt: at }, { touchUpdatedAt: false }).then(async () => {
      this.events.publish(new SessionMetaUpdated({ payload: { sessionId: this.context.sessionId, agentId: 'main', patch: {} } }));
      const meta = await this.metadata.read();
      const parent = activityParentId(this.context.sessionId, meta.custom);
      if (parent !== undefined) await this.recency.propagate(parent, at, new Set([this.context.sessionId]));
    }).catch((error: unknown) => {
      this.log.warn('session activity recency write failed', { sessionId: this.context.sessionId, error: String(error) });
    });
    trackSessionMetadataWork(work);
  }
}

registerScopedService(LifecycleScope.Session, ISessionRecencyService, SessionRecencyService, ScopeActivation.OnScopeCreated, 'sessionRecency');
