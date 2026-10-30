import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import { CPU_WORKERS_SECTION, CpuWorkersConfigSchema } from './configSection';
import type { CpuWorkerPool, CpuRequestOptions } from './host';
import { createCpuPool, registerCpuPool } from './runtime';

export interface ICpuWorkerService {
  readonly _serviceBrand: undefined;
  request<T>(operation: unknown, options?: CpuRequestOptions): Promise<T>;
}
export const ICpuWorkerService: ServiceIdentifier<ICpuWorkerService> = createDecorator<ICpuWorkerService>('cpuWorkerService');

export class CpuWorkerService extends Disposable implements ICpuWorkerService {
  declare readonly _serviceBrand: undefined;
  private readonly pool: CpuWorkerPool;

  constructor(@IConfigService config: IConfigService) {
    super();
    this.pool = createCpuPool(CpuWorkersConfigSchema.parse(config.get(CPU_WORKERS_SECTION) ?? {}));
    this._register(registerCpuPool(this.pool));
  }

  request<T>(operation: unknown, options?: CpuRequestOptions): Promise<T> {
    return this.pool.request<T>(operation, options);
  }
}
registerScopedService(LifecycleScope.App, ICpuWorkerService, CpuWorkerService, ScopeActivation.OnScopeCreated, 'runtime');
