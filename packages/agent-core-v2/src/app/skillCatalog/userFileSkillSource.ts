import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { TimeoutTimer } from '#/_base/utils/timer';
import path from 'pathe';

import {
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
  type MergeAllAvailableSkillsConfig,
} from './configSection';
import { ISkillDiscovery } from './skillDiscovery';
import { configuredRoots, userRoots } from './skillRoots';
import { SKILL_SOURCE_PRIORITY, type ISkillSource, type SkillContribution } from './skillSource';

export interface IUserFileSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IUserFileSkillSource: ServiceIdentifier<IUserFileSkillSource> =
  createDecorator<IUserFileSkillSource>('userFileSkillSource');

export class UserFileSkillSource extends Disposable implements IUserFileSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'user';
  readonly priority = SKILL_SOURCE_PRIORITY.user;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
  private readonly watchReady: Promise<void>;

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @IHostFsWatchService fsWatch: IHostFsWatchService,
  ) {
    super();
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain === MERGE_ALL_AVAILABLE_SKILLS_SECTION) this.onDidChangeEmitter.fire();
      }),
    );
    if ((bootstrap.args.skillDirs?.length ?? 0) > 0 || bootstrap.args.userSkillDir !== undefined) {
      this.watchReady = Promise.resolve();
    } else {
      const watch = this._register(fsWatch.watch(bootstrap.homeDir, {
        ignored: subtreeWatchFilter(bootstrap.homeDir, [path.join(bootstrap.homeDir, 'commands')], { maxDepth: 1 }),
        signal: true,
      }));
      const debounce = this._register(new TimeoutTimer());
      this._register(watch.onDidChange(() => {
        debounce.cancelAndSet(() => this.onDidChangeEmitter.fire(), 200);
      }));
      this.watchReady = watch.ready;
    }
  }

  async load(): Promise<SkillContribution> {
    await this.watchReady;
    if ((this.bootstrap.args.skillDirs?.length ?? 0) > 0) {
      return { skills: [] };
    }
    if (this.bootstrap.args.userSkillDir !== undefined) {
      return this.discovery.discover(
        await configuredRoots(
          [this.bootstrap.args.userSkillDir],
          this.bootstrap.cwd,
          this.bootstrap.osHomeDir,
          'user',
        ),
      );
    }
    await this.config.ready;
    const mergeAllAvailableSkills =
      this.config.get<MergeAllAvailableSkillsConfig>(MERGE_ALL_AVAILABLE_SKILLS_SECTION) ?? true;
    return this.discovery.discover(
      await userRoots(this.bootstrap.homeDir, this.bootstrap.osHomeDir, { mergeAllAvailableSkills }),
    );
  }
}

registerScopedService(
  LifecycleScope.App,
  IUserFileSkillSource,
  UserFileSkillSource,
  ScopeActivation.OnScopeCreated,
  'skillCatalog',
);
