import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { readCognitionFiles, type CognitionSlot } from '#/agent/cognition/cognitionFiles';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IModelPromptReader } from '#/app/kosongConfig/modelPromptReader';
import { LifecycleScope } from '#/app/scopes';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

export class ModelPromptReader implements IModelPromptReader {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostEnvironment private readonly environment: IHostEnvironment,
    @IHostFileSystem private readonly fs: IHostFileSystem,
  ) {}

  read(slot: CognitionSlot, refs: readonly string[]): Promise<Array<{ path: string; text: string }>> {
    return readCognitionFiles(this.fs, this.bootstrap.homeDir, slot, refs, this.environment.pathClass, 2_097_152);
  }
}

registerScopedService(LifecycleScope.App, IModelPromptReader, ModelPromptReader, ScopeActivation.OnDemand, 'kosongConfig');
