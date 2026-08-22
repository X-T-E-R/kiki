import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';

import type { RuntimeCallOptions, RuntimeHostStatus, RuntimeMethodContext, RuntimeRole } from './messages';

export interface RuntimeMethodHandler {
  (payload: unknown, ctx: RuntimeMethodContext): unknown;
}

export interface RuntimeRoleStatus {
  readonly role: RuntimeRole;
  readonly ready: boolean;
  readonly epoch: number;
}

export interface IHomeRuntimeService {
  readonly _serviceBrand: undefined;
  readonly onDidChangeRoleStatus: Event<RuntimeRoleStatus>;

  ready(): Promise<void>;
  status(): RuntimeHostStatus;
  registerMethod(name: string, handler: RuntimeMethodHandler): IDisposable;
  call(name: string, payload: unknown, options?: RuntimeCallOptions): Promise<unknown>;
  close(): Promise<void>;
}

export const IHomeRuntimeService: ServiceIdentifier<IHomeRuntimeService> =
  createDecorator<IHomeRuntimeService>('homeRuntimeService');
