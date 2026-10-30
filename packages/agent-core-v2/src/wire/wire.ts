import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { RecordDehydrator, WireRecord } from './record';

export const JOURNAL_HEAD_HASH_BYTES = 64 * 1024;

/** Bytes bound by {@link IWireService.journalBoundarySha256}. */
export const JOURNAL_BOUNDARY_HASH_BYTES = 4096;

/**
 * Coordinate of the durable journal's current byte content. An exact checkpoint
 * matches `size`, `mtimeMs`, and `headHash`. `headHash` binds the leading bytes
 * so a same-size rewrite cannot alias an older engine state. A stored prefix
 * digest can prove those bytes when the file has grown or the mtime moved, so
 * restore replays only the verified tail.
 */
export interface WireJournalIdentity {
  readonly size: number;
  readonly mtimeMs: number;
  readonly headHash: string;
  /** Append-log generation; a store rewrite or repair replaces it even when the length is unchanged. */
  readonly storeGeneration?: string;
}

/** `startByte` reads the appended tail without migrating or rewriting the prefix. */
export interface WireJournalReadOptions {
  readonly startByte?: number;
}

export class JournalTailUnreadableError extends Error {
  constructor() {
    super('Journal tail cannot be replayed');
    this.name = 'JournalTailUnreadableError';
  }
}

export interface IWireService {
  readonly _serviceBrand: undefined;

  seal(): Promise<void>;
  beginTranscriptEpoch?(): Promise<void>;
  /**
   * Closes the open transcript epoch after its durable flush.
   * A flush or receipt-write failure rejects and leaves the epoch open.
   * When the journal does not match accepted events, the epoch still closes
   * and the receipt records `trusted: false`. The receipt binds the journal size
   * and the SHA-256 of its last bytes, not a hash of the whole journal.
   * A rewrite of bytes before the epoch base and outside that tail is therefore not detected
   * until the next new base, whether the concurrent append succeeded or failed.
   */
  sealTranscriptEpoch?(): Promise<void>;
  verifyTranscriptLiveEpoch?(): Promise<boolean>;
  isTranscriptLiveEpochVerified?(): boolean;
  appendRecord(record: WireRecord, dehydrate?: RecordDehydrator): void;
  readJournal(options?: WireJournalReadOptions): AsyncIterable<WireRecord>;
  journalIdentity?(): Promise<WireJournalIdentity>;
  /** SHA-256 of the first `byteLength` bytes, or undefined if the journal is shorter. */
  journalSha256?(byteLength: number): Promise<string | undefined>;
  /**
   * SHA-256 of the last {@link JOURNAL_BOUNDARY_HASH_BYTES} bytes before `byteLength`
   * (or of all of them when fewer), or undefined if the journal is shorter.
   */
  journalBoundarySha256?(byteLength: number): Promise<string | undefined>;
  /** Bytes queued through this process, reset when the journal is replaced. */
  appendedByteCount?(): number;
  /** Fires after those bytes are queued. The count is cumulative for this process. */
  onDidAppendBytes?(listener: (appendedBytes: number) => void): { dispose(): void };
  /**
   * Trusted sealed digest observed when this epoch opened, even if the journal
   * has since grown. Undefined when no trusted seal was observed.
   */
  sealedJournalDigest?(): { readonly size: number; readonly sha256: string } | undefined;
  /**
   * Drains this journal's pending writes. A record rejected before store acceptance
   * remains a durability failure for this service's lifetime, even after later writes
   * succeed. The append queue stays usable; no failed record is automatically retried.
   * Store-owned write failures recover only when the store restores durability.
   */
  flush(): Promise<void>;
}

export const IWireService: ServiceIdentifier<IWireService> =
  createDecorator<IWireService>('wireService');
