import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { BlobReadRange } from './blobStore';

/** Content-addressed object receipt returned after durable raw-byte publication. */
export interface CasStoredObject {
  readonly sha256: string;
  readonly bytes: number;
  readonly deduplicated: boolean;
}

/** Optional cancellation and chunk-size controls for CAS operations. */
export interface CasOperationOptions {
  readonly signal?: AbortSignal;
  readonly chunkBytes?: number;
}

/** App-scoped global raw-byte content-addressed store for non-private canonical media and blobs. */
export interface IContentAddressedStore {
  readonly _serviceBrand: undefined;

  putBytes(data: Uint8Array, options?: CasOperationOptions): Promise<CasStoredObject>;
  putStream(source: AsyncIterable<Uint8Array>, options?: CasOperationOptions): Promise<CasStoredObject>;
  putFromFile(sourcePath: string, options?: CasOperationOptions): Promise<CasStoredObject>;
  has(sha256: string): Promise<boolean>;
  size(sha256: string): Promise<number | undefined>;
  get(sha256: string): Promise<Uint8Array | undefined>;
  getStream(sha256: string, range?: BlobReadRange, options?: CasOperationOptions): AsyncIterable<Uint8Array>;
  linkAlias(sha256: string, targetScope: string, targetKey: string, options?: CasOperationOptions): Promise<string | undefined>;
  linkAliasToPath(sha256: string, targetPath: string, options?: CasOperationOptions): Promise<void>;
  objectPath(sha256: string): string | undefined;
  removeUnreferenced(sha256: string): Promise<boolean>;
}

/** DI token for the App-scoped raw-byte content-addressed store. */
export const IContentAddressedStore: ServiceIdentifier<IContentAddressedStore> =
  createDecorator<IContentAddressedStore>('contentAddressedStore');
