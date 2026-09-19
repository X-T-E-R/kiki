import { createDecorator } from '#/_base/di/instantiation';

export interface ICronScheduler {
  readonly _serviceBrand: undefined;

  tick(): Promise<void>;
}

export const ICronScheduler = createDecorator<ICronScheduler>('cronScheduler');
