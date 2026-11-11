import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';

export interface WorkAdmission extends IDisposable {
  dispose(): void;
  run<T>(operation: () => T): T;
  hold(completion: Promise<unknown>): IDisposable;
}

export interface WorkAdmissionState {
  readonly operationId?: string;
  readonly pending: readonly { readonly kind: string; readonly startedAt: number }[];
}

export interface IWorkAdmissionService {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<void>;
  acquire(kind: string): WorkAdmission;
  run<T>(kind: string, operation: () => Promise<T>): Promise<T>;
  detach<T>(operation: () => T): T;
  fence(operationId: string): void;
  reopen(operationId: string): void;
  state(): WorkAdmissionState;
  joined(): Promise<void>;
}

export const IWorkAdmissionService = createDecorator<IWorkAdmissionService>('workAdmissionService');
