import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { combinedDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { PLUGIN_SKILL_SOURCE_ID, SKILL_SOURCE_PRIORITY, type ISkillSource, type SkillContribution } from '#/app/skillCatalog/skillSource';
import { IPluginService } from '#/app/plugin/plugin';
import type { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';

export interface IPluginSkillSource extends ISkillSource { readonly _serviceBrand: undefined; }
export const IPluginSkillSource: ServiceIdentifier<IPluginSkillSource> = createDecorator<IPluginSkillSource>('pluginSkillSource');
export { PLUGIN_SKILL_SOURCE_ID };
export class PluginSkillSource implements IPluginSkillSource {
  declare readonly _serviceBrand: undefined;
  readonly id = PLUGIN_SKILL_SOURCE_ID;
  readonly priority = SKILL_SOURCE_PRIORITY.plugin;
  readonly onDidChange: Event<void> = (listener, thisArg, disposables) => {
    const reload = this.plugins.onDidReload((event) => event.waitUntil(Promise.resolve(listener.call(thisArg, undefined))), undefined, disposables);
    const usage = this.usage?.onDidChange((event) => {
      if (event.workspaceId === this.workspaceId && event.sessionId === undefined) {
        event.waitUntil(Promise.resolve(listener.call(thisArg, undefined)));
      }
    }, undefined, disposables);
    return usage === undefined ? reload : combinedDisposable(reload, usage);
  };
  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @IPluginService private readonly plugins: IPluginService,
    private readonly workspaceId?: string,
    private readonly usage?: IPluginUsageService,
  ) {}
  async load(): Promise<SkillContribution> { return this.discovery.discover(await this.plugins.pluginSkillRoots(this.workspaceId)); }
}
