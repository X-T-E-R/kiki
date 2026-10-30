import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';

import { StorageError, StorageErrors } from '#/persistence/interface/storage';

export class AppendLogCorruptedError extends StorageError {
  constructor(scope: string, key: string, lineNumber: number, cause: unknown) {
    super(
      StorageErrors.codes.STORAGE_CORRUPTED,
      `append-log ${scope}/${key}: corrupted line ${lineNumber}`,
      {
        details: { scope, key, lineNumber },
        cause,
      },
    );
    this.name = 'AppendLogCorruptedError';
  }
}

export interface AppendLogOptions {
  readonly onError?: (error: unknown) => void;
}

export interface AppendLogTruncation {
  readonly lineNumber: number;
  readonly reason: 'corrupted' | 'truncated';
  readonly cause?: unknown;
}

export interface AppendLogReadOptions {
  readonly onTruncate?: (truncation: AppendLogTruncation) => void;
  readonly signal?: AbortSignal;
  readonly chunkBytes?: number;
  /** Resume at a previously observed complete-record byte boundary. */
  readonly startOffset?: number;
  readonly endOffset?: number;
  readonly onPosition?: (endOffset: number) => void;
  /** Called before each yielded record with its UTF-8 source line length, including a present newline. */
  readonly onRecordBytes?: (byteLength: number) => void;
}

export interface AppendLogWrite {
  readonly scope: string;
  readonly key: string;
}

export interface AppendLogCommit extends AppendLogWrite {
  readonly generation: string;
  readonly start: number;
  readonly end: number;
  readonly boundaryHash: string;
  readonly rewrite: boolean;
}

/** Projection work is bounded by the writer: prepare retains only derived data, commit runs after canonical success, and failures never reject a successful canonical write. */
export interface AppendLogProjection<T> {
  readonly key: string;
  prepare(scope: string, records: readonly unknown[]): T;
  commit(position: AppendLogCommit, value: T): Promise<void>;
  onError(error: unknown): void;
}

export interface ColdSealOptions {
  readonly segmentBytes?: number;
  readonly signal?: AbortSignal;
}

export interface ColdSealResult {
  readonly format: 1;
  readonly codec: 'deflate-raw';
  readonly level: 6;
  readonly segmentBytes: number;
  readonly sealedCut: number;
  readonly logicalSize: number;
  readonly segmentCount: number;
  readonly generation: string;
  readonly originalRetained: true;
}

/** A process-local revision invalidated by observed metadata changes outside successful appends; absent identity disables incremental digest reuse. */
export interface AppendLogSourceRevision {
  readonly revision: number;
  /**
   * Counts revision changes that no append of this store can explain: every observed change between appends,
   * a lost observation, a managed rewrite, and a failed append whose file did not grow within its own batch.
   * A failed append that grew the file within its batch advances `revision` but not this count.
   */
  readonly unexplained: number;
  readonly size: number;
  readonly identity?: string;
}

export interface IAppendLogStore {
  readonly _serviceBrand: undefined;

  readonly onDidWrite: Event<AppendLogWrite>;
  registerProjection<T>(projection: AppendLogProjection<T>): IDisposable;
  generation(scope: string, key: string): Promise<string>;
  sourceRevision?(scope: string, key: string): Promise<AppendLogSourceRevision | undefined>;

  append<R>(scope: string, key: string, record: R, options?: AppendLogOptions): void;
  read<R>(scope: string, key: string, options?: AppendLogReadOptions): AsyncIterable<R>;
  rewrite<R>(scope: string, key: string, records: readonly R[]): Promise<void>;
  sealCold(scope: string, key: string, sealedCut: number, options?: ColdSealOptions): Promise<ColdSealResult>;
  discardCold(scope: string, key: string): Promise<void>;
  flush(): Promise<void>;
  flush(scope: string, key: string): Promise<void>;
  close(): Promise<void>;
  acquire(scope: string, key: string): IDisposable;
  drainRetirements(): Promise<void>;
}

export const IAppendLogStore: ServiceIdentifier<IAppendLogStore> =
  createDecorator<IAppendLogStore>('appendLogStore');
