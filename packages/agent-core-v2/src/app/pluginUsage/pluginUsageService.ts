import { z } from 'zod';
import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { currentPluginId } from '#/app/plugin/renamedPlugins';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { Error2, ErrorCodes } from '#/errors';
import { IPluginUsageService, type PluginUsageChange, type PluginUsageSnapshot, type PluginUsageOverride } from './pluginUsage';
import { PLUGIN_WORKSPACE_USAGE_FLAG } from './flag';

const storedSchema = z.object({ revision: z.number().int().nonnegative(), overrides: z.record(z.string(), z.boolean()) });
type StoredUsage = z.infer<typeof storedSchema>;

export class PluginUsageService extends Service implements IPluginUsageService {
  declare readonly _serviceBrand: undefined;
  private readonly documents = new Map<string, Promise<StoredUsage>>();
  private readonly application = new Map<string, { revision: number; applyState: PluginUsageSnapshot['applyState']; errors: string[] }>();
  private writes: Promise<unknown> = Promise.resolve();
  private readonly changed = this._register(new Emitter<PluginUsageChange>());
  readonly onDidChange = this.changed.event;
  private readonly applied = this._register(new Emitter<PluginUsageSnapshot>());
  readonly onDidApply = this.applied.event;
  constructor(
    @IAtomicDocumentStore private readonly store: IAtomicDocumentStore,
    @IFlagService private readonly flags: IFlagService,
  ) { super(); }
  enabled(): boolean { return this.flags.enabled(PLUGIN_WORKSPACE_USAGE_FLAG); }
  async read(workspaceId: string): Promise<PluginUsageSnapshot> {
    this.assertWorkspace(workspaceId);
    const stored = this.enabled() ? await this.load(workspaceId) : { revision: 0, overrides: {} };
    const application = this.application.get(workspaceId);
    return { workspaceId, revision: stored.revision, overrides: { ...stored.overrides },
      applyState: application?.revision === stored.revision ? application.applyState : 'applied',
      errors: application?.revision === stored.revision ? [...application.errors] : [] };
  }
  async allows(workspaceId: string | undefined, pluginId: string): Promise<boolean> {
    if (!this.enabled() || workspaceId === undefined) return true;
    return (await this.load(workspaceId)).overrides[currentPluginId(pluginId.toLowerCase())] !== false;
  }
  set(input: { workspaceId: string; pluginId: string; override: PluginUsageOverride }): Promise<PluginUsageSnapshot> {
    const write = this.writes.catch(() => undefined).then(async () => {
      if (!this.enabled()) throw new Error2(ErrorCodes.NOT_IMPLEMENTED, 'Workspace plugin selection is not enabled in this build');
      this.assertWorkspace(input.workspaceId);
      const pluginId = currentPluginId(input.pluginId.toLowerCase());
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(pluginId)) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Invalid plugin id');
      const stored = await this.load(input.workspaceId);
      const overrides = { ...stored.overrides };
      if (input.override === 'inherit') delete overrides[pluginId];
      else overrides[pluginId] = input.override === 'on';
      if (JSON.stringify(overrides) === JSON.stringify(stored.overrides)) return this.read(input.workspaceId);
      const next = { revision: stored.revision + 1, overrides };
      await this.store.set('plugin-usage', input.workspaceId, next);
      this.documents.set(input.workspaceId, Promise.resolve(next));
      const application = { revision: next.revision, applyState: 'pending' as PluginUsageSnapshot['applyState'], errors: [] as string[] };
      this.application.set(input.workspaceId, application);
      const work: Promise<unknown>[] = [];
      this.changed.fire({ workspaceId: input.workspaceId, pluginId, revision: next.revision, waitUntil: (promise) => { work.push(promise); } });
      if (work.length === 0) application.applyState = 'applied';
      else void Promise.allSettled(work).then(async (results) => {
        application.errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => String(result.reason));
        application.applyState = application.errors.length === 0 ? 'applied' : 'failed';
        if (this.application.get(input.workspaceId) === application) this.applied.fire(await this.read(input.workspaceId));
      });
      return this.read(input.workspaceId);
    });
    this.writes = write;
    return write;
  }
  private load(workspaceId: string): Promise<StoredUsage> {
    this.assertWorkspace(workspaceId);
    let document = this.documents.get(workspaceId);
    if (document === undefined) {
      document = this.store.get('plugin-usage', workspaceId).then((value) => value === undefined ? { revision: 0, overrides: {} } : storedSchema.parse(value));
      this.documents.set(workspaceId, document);
    }
    return document;
  }
  private assertWorkspace(workspaceId: string): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(workspaceId)) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Invalid workspace id');
  }
}
registerScopedService(LifecycleScope.App, IPluginUsageService, PluginUsageService, ScopeActivation.OnScopeCreated, 'pluginUsage');
