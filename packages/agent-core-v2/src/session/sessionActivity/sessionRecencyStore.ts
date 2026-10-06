import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventService } from '#/app/event/event';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ISessionIndex, ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import { buildSessionSummary } from '#/app/sessionIndex/sessionIndexSource';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionMetadata, type SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { encodeSessionMeta, normalizeSessionMeta } from '#/session/sessionMetadata/sessionMetadataService';
import { SessionMetaUpdated } from '#/session/sessionMetadata/sessionMetaEvents';
import { legacySessionMetaScopeOf, sessionScopeOf, workspacePersistenceScope } from '#/workspace/sessionLifecycle/internal/addressing';
import { activityParentId, ISessionRecencyStore } from './sessionRecency';

export class SessionRecencyStore implements ISessionRecencyStore {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionManager private readonly manager: ISessionManager,
    @ISessionIndex private readonly index: ISessionIndex,
    @ISessionIndexMirror private readonly mirror: ISessionIndexMirror,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IEventService private readonly events: IEventService,
  ) {}

  async propagate(parentId: string, at: number, visited: ReadonlySet<string>): Promise<void> {
    if (visited.has(parentId)) return;
    const nextVisited = new Set(visited).add(parentId);
    const nextParent = await this.manager.withLifecycleSerialization(parentId, async () => {
      const handle = this.manager.get(parentId);
      if (handle !== undefined) {
        if (this.manager.isEphemeral(parentId)) return undefined;
        const metadata = handle.accessor.get(ISessionMetadata);
        const current = await metadata.read();
        if (at > (current.activityUpdatedAt ?? 0)) {
          await metadata.update({ activityUpdatedAt: at }, { touchUpdatedAt: false });
          this.publish(parentId);
        }
        return activityParentId(parentId, current.custom);
      }
      const summary = await this.index.get(parentId);
      if (summary === undefined) return undefined;
      const scope = sessionScopeOf(workspacePersistenceScope(this.bootstrap.scope('sessions'), summary.workspaceId), parentId);
      let raw = await this.docs.get<SessionMeta>(scope, 'state.json');
      const legacyScope = legacySessionMetaScopeOf(scope);
      if (raw === undefined) raw = await this.docs.get<SessionMeta>(legacyScope, 'state.json');
      if (raw === undefined) return undefined;
      const current = normalizeSessionMeta(raw, parentId);
      if (at > (current.activityUpdatedAt ?? 0)) {
        const next = { ...current, activityUpdatedAt: at };
        await this.docs.set(scope, 'state.json', encodeSessionMeta(next));
        this.mirror.record(buildSessionSummary({
          ...next, id: parentId, workspaceId: summary.workspaceId, cwd: next.cwd ?? summary.cwd,
        }));
        this.publish(parentId);
      }
      return activityParentId(parentId, current.custom);
    });
    if (nextParent !== undefined) await this.propagate(nextParent, at, nextVisited);
  }

  private publish(sessionId: string): void {
    this.events.publish(new SessionMetaUpdated({ payload: { sessionId, agentId: 'main', patch: {} } }));
  }
}

registerScopedService(LifecycleScope.App, ISessionRecencyStore, SessionRecencyStore, ScopeActivation.OnDemand, 'sessionRecencyStore');
