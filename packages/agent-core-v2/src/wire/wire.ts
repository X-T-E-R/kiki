import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { RecordDehydrator, WireRecord } from './record';

/**
 * Coordinate of the durable journal's current byte content. Consumers compare
 * `size` and `mtimeMs` first as the cheap negative check; `headHash` is the
 * deciding check — it binds the journal's leading bytes into the identity so a
 * same-size rewrite can no longer alias an older engine state.
 */
export interface WireJournalIdentity {
  readonly size: number;
  readonly mtimeMs: number;
  readonly headHash: string;
}

export interface IWireService {
  readonly _serviceBrand: undefined;

  seal(): Promise<void>;
  appendRecord(record: WireRecord, dehydrate?: RecordDehydrator): void;
  readJournal(): AsyncIterable<WireRecord>;
  journalIdentity?(): Promise<WireJournalIdentity>;
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
