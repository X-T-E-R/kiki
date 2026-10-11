import { Service } from '#/_base/di/service';
import { createDecorator } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IPluginUsageService, type PluginUsageOverride, type PluginUsageSnapshot } from '#/app/pluginUsage/pluginUsage';
import { IPluginService } from '#/app/plugin/plugin';
import { currentPluginId } from '#/app/plugin/renamedPlugins';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { Error2, ErrorCodes } from '#/errors';

export interface ISessionPluginUsageService {
  readonly _serviceBrand: undefined;
  read(): Promise<PluginUsageSnapshot>;
  set(pluginId: string, override: PluginUsageOverride): Promise<PluginUsageSnapshot>;
}
export const ISessionPluginUsageService = createDecorator<ISessionPluginUsageService>('sessionPluginUsageService');

export class SessionPluginUsageService extends Service implements ISessionPluginUsageService {
  declare readonly _serviceBrand: undefined;
  private writes: Promise<unknown> = Promise.resolve();
  private application?: PluginUsageSnapshot;
  constructor(
    @ISessionContext private readonly session: ISessionContext,
    @IPluginUsageService private readonly usage: IPluginUsageService,
    @IPluginService private readonly plugins: IPluginService,
    @IAtomicDocumentStore private readonly store: IAtomicDocumentStore,
  ) { super(); }
  async read(): Promise<PluginUsageSnapshot> {
    const stored = await this.usage.readSession(this.session.workspaceId, this.session.sessionId);
    return this.application?.revision === stored.revision ? this.application : stored;
  }
  set(pluginId: string, override: PluginUsageOverride): Promise<PluginUsageSnapshot> {
    const write = this.writes.catch(() => undefined).then(async () => {
      if (!this.usage.enabled()) throw new Error2(ErrorCodes.NOT_IMPLEMENTED, 'Session plugin selection is not enabled');
      const id = currentPluginId(pluginId.toLowerCase());
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Invalid plugin id');
      const info = override === 'inherit' ? undefined : await this.plugins.getPluginInfo({ id });
      if (override === 'on' && (info?.enabled !== true || info.state !== 'ok')) throw new Error2(ErrorCodes.REQUEST_INVALID, 'This plugin is disabled globally or invalid');
      const previous = await this.read();
      const overrides = { ...previous.overrides };
      if (override === 'inherit') delete overrides[info?.id ?? id];
      else overrides[info?.id ?? id] = override === 'on';
      const next: PluginUsageSnapshot = { ...previous, revision: previous.revision + 1, overrides, applyState: 'pending', errors: [] };
      await this.persist(next);
      this.application = next;
      const applied = await this.usage.applySession(next, info?.id ?? id);
      if (applied.applyState === 'failed') {
        const restored: PluginUsageSnapshot = { ...previous, revision: next.revision + 1, applyState: 'pending', errors: applied.errors };
        await this.persist(restored);
        this.application = await this.usage.applySession(restored, info?.id ?? id);
      } else this.application = applied;
      return this.application;
    });
    this.writes = write;
    return write;
  }
  private persist(snapshot: PluginUsageSnapshot): Promise<void> {
    return this.store.set('session-plugin-usage', this.session.sessionId, { revision: snapshot.revision, overrides: snapshot.overrides });
  }
}
registerScopedService(LifecycleScope.Session, ISessionPluginUsageService, SessionPluginUsageService, ScopeActivation.OnScopeCreated, 'sessionPluginUsage');
