import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { IDisposable } from '#/_base/di/lifecycle';

export type HostFsChangeKind = 'file' | 'directory';
export type HostFsChangeAction = 'created' | 'modified' | 'deleted';

export interface HostFsChange {
  readonly path: string;
  readonly action: HostFsChangeAction;
  readonly kind: HostFsChangeKind;
}

/**
 * Ignore predicate for a watch. When the predicate also carries `subtree`, a
 * `true` verdict from it promises that every path below the argument is
 * ignored too, which lets the watcher drop whole directory trees without
 * resolving each event.
 */
export type HostFsWatchIgnore = ((path: string) => boolean) & {
  readonly subtree?: (path: string) => boolean;
};

export interface HostFsWatchOptions {
  readonly recursive?: boolean;
  readonly ignored?: HostFsWatchIgnore;
  readonly signal?: boolean;
}

export interface IHostFsWatchHandle extends IDisposable {
  readonly ready: Promise<void>;
  readonly onDidChange: Event<HostFsChange>;
}

export interface IHostFsWatchService {
  readonly _serviceBrand: undefined;

  watch(path: string, options?: HostFsWatchOptions): IHostFsWatchHandle;
}

export const IHostFsWatchService: ServiceIdentifier<IHostFsWatchService> =
  createDecorator<IHostFsWatchService>('hostFsWatchService');
