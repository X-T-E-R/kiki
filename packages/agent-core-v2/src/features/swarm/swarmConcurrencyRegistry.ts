import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';

export interface SwarmConcurrencyLease extends IDisposable {
  tryAcquire(): boolean;
  release(): void;
}

export interface ISwarmConcurrencyRegistry {
  readonly _serviceBrand: undefined;

  createLease(maxConcurrency: number, onPermitAvailable: () => void): SwarmConcurrencyLease;
}

export const ISwarmConcurrencyRegistry: ServiceIdentifier<ISwarmConcurrencyRegistry> =
  createDecorator<ISwarmConcurrencyRegistry>('swarmConcurrencyRegistry');
