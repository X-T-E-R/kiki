import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Event } from '#/_base/event';

import { IFileSystemStorageService, StorageError, StorageErrors, type StorageReadOptions } from '#/persistence/interface/storage';
import {
  IAtomicDocumentStore,
  IAtomicTomlDocumentStore,
  type DocumentCodec,
} from '#/persistence/interface/atomicDocumentStore';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const exactTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });

export const jsonDocumentCodec: DocumentCodec = {
  format: 'json',
  encode(value: unknown): Uint8Array {
    return textEncoder.encode(JSON.stringify(value));
  },
  decode(bytes: Uint8Array): unknown {
    return JSON.parse(textDecoder.decode(bytes));
  },
};

export const tomlDocumentCodec: DocumentCodec = {
  format: 'toml',
  encode(value: unknown): Uint8Array {
    return textEncoder.encode(`${stringifyToml(value as Record<string, unknown>)}\n`);
  },
  decode(bytes: Uint8Array): unknown {
    const text = textDecoder.decode(bytes);
    if (text.trim().length === 0) return {};
    return parseToml(text);
  },
};

class AtomicDocumentStoreBase implements IAtomicDocumentStore {
  declare readonly _serviceBrand: undefined;

  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    protected readonly storage: IFileSystemStorageService,
    private readonly codec: DocumentCodec,
  ) {}

  protected enqueue<T>(scope: string, key: string, operation: () => Promise<T>): Promise<T> {
    const id = `${scope}\0${key}`;
    const previous = this.tails.get(id) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(id, tail);
    void tail.finally(() => {
      if (this.tails.get(id) === tail) this.tails.delete(id);
    });
    return result;
  }

  private async readDocument<T>(scope: string, key: string): Promise<T | undefined> {
    const bytes = await this.storage.read(scope, key);
    if (bytes === undefined) return undefined;
    try {
      return this.codec.decode(bytes) as T;
    } catch (error) {
      throw new StorageError(
        StorageErrors.codes.STORAGE_DECODE_FAILED,
        `failed to decode ${scope}/${key} as ${this.codec.format}`,
        {
          details: { scope, key, format: this.codec.format },
          cause: error,
        },
      );
    }
  }

  async get<T>(scope: string, key: string): Promise<T | undefined> {
    return this.enqueue(scope, key, () => this.readDocument<T>(scope, key));
  }

  protected withWriteLock<T>(_scope: string, _key: string, operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  async set<T>(scope: string, key: string, value: T): Promise<void> {
    await this.enqueue(scope, key, () => this.withWriteLock(scope, key,
      () => this.storage.write(scope, key, this.codec.encode(value), { atomic: true })));
  }

  async update<T>(
    scope: string,
    key: string,
    updater: (current: T | undefined) => T | undefined,
  ): Promise<T | undefined> {
    return this.enqueue(scope, key, () => this.withWriteLock(scope, key, async () => {
      const current = await this.readDocument<T>(scope, key);
      const next = updater(current);
      if (next === undefined || next === current) return current;
      await this.storage.write(scope, key, this.codec.encode(next), { atomic: true });
      return next;
    }));
  }

  async delete(scope: string, key: string): Promise<void> {
    await this.enqueue(scope, key, () => this.withWriteLock(scope, key,
      () => this.storage.delete(scope, key)));
  }

  async list(scope: string, prefix?: string): Promise<readonly string[]> {
    return this.storage.list(scope, prefix);
  }

  watch(scope: string, key: string): Event<void> {
    return this.storage.watch?.(scope, key) ?? (Event.None as Event<void>);
  }

  acquire(_scope: string, _key: string): IDisposable {
    return toDisposable(() => {});
  }
}

export class JsonAtomicDocumentStore extends AtomicDocumentStoreBase {
  constructor(@IFileSystemStorageService storage: IFileSystemStorageService) {
    super(storage, jsonDocumentCodec);
  }
}

export class TomlAtomicDocumentStore
  extends AtomicDocumentStoreBase
  implements IAtomicTomlDocumentStore
{
  constructor(@IFileSystemStorageService storage: IFileSystemStorageService) {
    super(storage, tomlDocumentCodec);
  }

  private async readText(scope: string, key: string, options?: StorageReadOptions): Promise<string | undefined> {
    const bytes = await this.storage.read(scope, key, options);
    return bytes === undefined ? undefined : exactTextDecoder.decode(bytes);
  }

  protected override async withWriteLock<T>(scope: string, key: string, operation: () => Promise<T>): Promise<T> {
    const lock = await this.storage.acquireLock(scope, `${key}.cas.lock`);
    try {
      return await operation();
    } finally {
      await lock.release();
    }
  }

  getText(scope: string, key: string, options?: StorageReadOptions): Promise<string | undefined> {
    return this.enqueue(scope, key, () => this.readText(scope, key, options));
  }

  setText(scope: string, key: string, text: string): Promise<void> {
    return this.enqueue(scope, key, () => this.withWriteLock(scope, key,
      () => this.storage.write(scope, key, textEncoder.encode(text), { atomic: true })));
  }

  compareAndSetText(scope: string, key: string, expected: string | undefined, next: string | undefined): Promise<boolean> {
    return this.enqueue(scope, key, () => this.withWriteLock(scope, key, async () => {
      if (await this.readText(scope, key) !== expected) return false;
      if (next === undefined) await this.storage.delete(scope, key);
      else await this.storage.write(scope, key, textEncoder.encode(next), { atomic: true });
      return true;
    }));
  }
}

registerScopedService(
  LifecycleScope.App,
  IAtomicDocumentStore,
  JsonAtomicDocumentStore,
  ScopeActivation.OnScopeCreated,
  'storage',
);

registerScopedService(
  LifecycleScope.App,
  IAtomicTomlDocumentStore,
  TomlAtomicDocumentStore,
  ScopeActivation.OnScopeCreated,
  'storage',
);
