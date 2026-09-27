import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';
import { type Event } from '#/_base/event';
import type { StorageReadOptions } from './storage';

export interface DocumentCodec {
  readonly format: string;
  encode(value: unknown): Uint8Array;
  decode(bytes: Uint8Array): unknown;
}

export interface IAtomicDocumentStore {
  readonly _serviceBrand: undefined;

  get<T>(scope: string, key: string): Promise<T | undefined>;
  set<T>(scope: string, key: string, value: T): Promise<void>;
  update<T>(
    scope: string,
    key: string,
    updater: (current: T | undefined) => T | undefined,
  ): Promise<T | undefined>;
  delete(scope: string, key: string): Promise<void>;
  list(scope: string, prefix?: string): Promise<readonly string[]>;
  watch(scope: string, key: string): Event<void>;
  acquire(scope: string, key: string): IDisposable;
}

export const IAtomicDocumentStore: ServiceIdentifier<IAtomicDocumentStore> =
  createDecorator<IAtomicDocumentStore>('atomicDocumentStore');

export interface IAtomicTomlDocumentStore extends IAtomicDocumentStore {
  getText(scope: string, key: string, options?: StorageReadOptions): Promise<string | undefined>;
  setText(scope: string, key: string, text: string): Promise<void>;
  compareAndSetText(scope: string, key: string, expected: string | undefined, next: string | undefined): Promise<boolean>;
}

export const IAtomicTomlDocumentStore: ServiceIdentifier<IAtomicTomlDocumentStore> =
  createDecorator<IAtomicTomlDocumentStore>('atomicTomlDocumentStore');
