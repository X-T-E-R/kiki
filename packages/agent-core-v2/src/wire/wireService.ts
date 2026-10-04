import { createHash, randomUUID, type Hash } from 'node:crypto';

import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { Service } from '#/_base/di/service';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ContentPart } from '#/kosong/contract/message';
import {
  type AppendLogTruncation,
  IAppendLogStore,
} from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService, StorageError, StorageErrors } from '#/persistence/interface/storage';

import { IWireService, type WireJournalIdentity } from './wire';
import { WireError, WireErrors } from './errors';
import { repairWireJournal } from './repair';
import {
  WIRE_PROTOCOL_VERSION,
  isNewerWireVersion,
  migrateWireRecord,
  resolveWireMigrations,
  type WireMigration,
} from './migration/migration';
import {
  AGENT_WIRE_RECORD_KEY,
  createWireMetadataRecord,
  isWireRecord,
  isWireMetadataRecord,
  type PartsTransformer,
  type RecordDehydrator,
  type WireRecord,
} from './record';
import {
  WIRE_TRANSCRIPT_RECEIPT_KEY,
  digestWireBytes,
  parseWireTranscriptReceipt,
  type WireTranscriptReceipt,
} from './transcriptReceipt';

const JOURNAL_HEAD_HASH_BYTES = 64 * 1024;
const JOURNAL_HEAD_HASH_HEX_LENGTH = 32;

export class WireService extends Service implements IWireService {
  declare readonly _serviceBrand: undefined;

  private readonly wireScope: string;
  private persistQueue: Promise<void> | undefined;
  private pendingRepair:
    | { readonly records: WireRecord[]; readonly truncation: AppendLogTruncation }
    | undefined;
  private persistFailure: { readonly error: unknown } | undefined;
  private freshJournal = false;
  private transcriptEpoch: WireTranscriptReceipt | undefined;
  private epochBaselineLines = 0;
  private epochAcceptedRecords = 0;
  private epochExpectedHash: Hash | undefined;
  private epochExpectedSize = 0;
  private verifiedAcceptedRecords = -1;

  constructor(
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAppendLogStore private readonly log: IAppendLogStore,
    @IAgentBlobService private readonly blobService: IAgentBlobService,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @ILogService private readonly logger: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    this.wireScope = scopeContext.scope();
    this._register(this.log.acquire(this.wireScope, AGENT_WIRE_RECORD_KEY));
  }

  async seal(): Promise<void> {
    const tolerate = { onTruncate: () => {} };
    for await (const record of this.log.read(this.wireScope, AGENT_WIRE_RECORD_KEY, tolerate)) {
      void record;
      return;
    }
    this.appendRecordLow(createWireMetadataRecord());
    this.freshJournal = true;
  }

  async beginTranscriptEpoch(): Promise<void> {
    if (this.transcriptEpoch !== undefined) throw new Error('Transcript epoch has already begun');
    await this.flush();
    const previousBytes = await this.storage.read(this.wireScope, WIRE_TRANSCRIPT_RECEIPT_KEY);
    const expectedHash = createHash('sha256');
    const source = this.storage.readStream(this.wireScope, AGENT_WIRE_RECORD_KEY);
    const hashed = async function* (): AsyncIterable<Uint8Array> {
      for await (const chunk of source) {
        expectedHash.update(chunk);
        yield chunk;
      }
    };
    const identity = await digestWireBytes(hashed());
    let trusted = this.freshJournal && previousBytes === undefined;
    if (previousBytes !== undefined) {
      let previous: WireTranscriptReceipt | undefined;
      try {
        previous = parseWireTranscriptReceipt(JSON.parse(Buffer.from(previousBytes).toString('utf8')));
      } catch {
        previous = undefined;
      }
      trusted = previous?.state === 'sealed' && previous.trusted && previous.wire !== undefined &&
        identity.size === previous.wire.size && identity.sha256 === previous.wire.sha256;
    }
    trusted = trusted && identity.size > 0 && identity.endsWithNewline;
    if (trusted) {
      let first: unknown;
      for await (const candidate of this.log.read(this.wireScope, AGENT_WIRE_RECORD_KEY)) {
        first = candidate;
        break;
      }
      trusted = first !== undefined && isWireRecord(first) && isWireMetadataRecord(first);
    }
    const epoch: WireTranscriptReceipt = { format: 1, epoch: randomUUID(), state: 'open', trusted };
    await this.storage.write(
      this.wireScope,
      WIRE_TRANSCRIPT_RECEIPT_KEY,
      Buffer.from(JSON.stringify(epoch)),
      { atomic: true },
    );
    this.transcriptEpoch = epoch;
    this.epochBaselineLines = identity.lines;
    this.epochAcceptedRecords = 0;
    this.epochExpectedHash = trusted ? expectedHash : undefined;
    this.epochExpectedSize = identity.size;
    this.verifiedAcceptedRecords = -1;
  }

  async sealTranscriptEpoch(): Promise<void> {
    const epoch = this.transcriptEpoch;
    if (epoch?.state !== 'open') throw new Error('Transcript epoch is not open');
    await this.flush();
    const digest = await digestWireBytes(this.storage.readStream(this.wireScope, AGENT_WIRE_RECORD_KEY));
    if (epoch.trusted && (digest.size === 0 || !digest.endsWithNewline ||
        digest.lines !== this.epochBaselineLines + this.epochAcceptedRecords ||
        this.epochExpectedHash === undefined || digest.size !== this.epochExpectedSize ||
        digest.sha256 !== this.epochExpectedHash.copy().digest('hex'))) {
      throw new Error('Transcript wire contents do not match accepted events');
    }
    const wire = { size: digest.size, sha256: digest.sha256 };
    const sealed: WireTranscriptReceipt = { ...epoch, state: 'sealed', wire };
    await this.storage.write(
      this.wireScope,
      WIRE_TRANSCRIPT_RECEIPT_KEY,
      Buffer.from(JSON.stringify(sealed)),
      { atomic: true },
    );
    this.transcriptEpoch = sealed;
  }

  async verifyTranscriptLiveEpoch(): Promise<boolean> {
    const epoch = this.transcriptEpoch;
    this.verifiedAcceptedRecords = -1;
    if (epoch?.state !== 'open' || !epoch.trusted || this.persistFailure !== undefined) return false;
    const accepted = this.epochAcceptedRecords;
    await this.flush();
    const stored = await this.storage.read(this.wireScope, WIRE_TRANSCRIPT_RECEIPT_KEY);
    if (stored === undefined || Buffer.from(stored).toString('utf8') !== JSON.stringify(epoch)) return false;
    const digest = await digestWireBytes(this.storage.readStream(this.wireScope, AGENT_WIRE_RECORD_KEY));
    const verified = this.transcriptEpoch === epoch && this.persistFailure === undefined &&
      this.epochAcceptedRecords === accepted && digest.size > 0 && digest.endsWithNewline &&
      digest.lines === this.epochBaselineLines + accepted &&
      this.epochExpectedHash !== undefined && digest.size === this.epochExpectedSize &&
      digest.sha256 === this.epochExpectedHash.copy().digest('hex');
    this.verifiedAcceptedRecords = verified ? accepted : -1;
    return verified;
  }

  isTranscriptLiveEpochVerified(): boolean {
    return this.transcriptEpoch?.state === 'open' && this.transcriptEpoch.trusted &&
      this.persistFailure === undefined && this.epochAcceptedRecords === this.verifiedAcceptedRecords;
  }

  appendRecord(record: WireRecord, dehydrate?: RecordDehydrator): void {
    if (this.transcriptEpoch?.state === 'sealed') throw new Error('Transcript epoch has been sealed');
    if (this.transcriptEpoch?.state === 'open') this.epochAcceptedRecords += 1;
    if (
      this.pendingRepair === undefined &&
      dehydrate === undefined &&
      this.persistQueue === undefined
    ) {
      try {
        this.appendRecordLow(record);
      } catch (error) {
        this.reportPersistFailure(error);
      }
      return;
    }
    const transform: PartsTransformer = (parts) =>
      this.blobService.offloadParts(
        parts as readonly ContentPart[],
      ) as Promise<readonly unknown[]>;
    const queued = (this.persistQueue ?? Promise.resolve())
      .then(async () => {
        if (this.pendingRepair !== undefined) {
          await this.repairPendingJournal();
        }
        const output = dehydrate === undefined ? record : await dehydrate(record, transform);
        this.appendRecordLow(output);
      })
      .catch((error: unknown) => this.reportPersistFailure(error));
    this.persistQueue = queued;
    void queued.then(() => {
      if (this.persistQueue === queued) this.persistQueue = undefined;
    });
  }

  async *readJournal(): AsyncIterable<WireRecord> {
    let truncation: AppendLogTruncation | undefined;
    const source = this.log.read<WireRecord>(this.wireScope, AGENT_WIRE_RECORD_KEY, {
      onTruncate: (info) => {
        truncation = info;
      },
    });
    let migrations: readonly WireMigration[] = [];
    let rewrittenRecords: WireRecord[] | undefined;
    let newerWireVersion = false;
    let recordIndex = 0;
    let hasRecords = false;

    for await (const candidate of source) {
      const sourceRecord: unknown = candidate;
      if (!isWireRecord(sourceRecord)) {
        this.reportSkippedRecord(undefined, recordIndex, true);
        recordIndex++;
        continue;
      }
      if (!hasRecords) {
        hasRecords = true;
        if (sourceRecord.type !== 'metadata') {
          rewrittenRecords = [createWireMetadataRecord()];
          migrations = resolveWireMigrations('1.4');
        } else if (!isWireMetadataRecord(sourceRecord)) {
          throw new StorageError(
            StorageErrors.codes.STORAGE_CORRUPTED,
            'Agent wire metadata is malformed',
            { details: { scope: this.wireScope, key: AGENT_WIRE_RECORD_KEY } },
          );
        } else if (isNewerWireVersion(sourceRecord.protocol_version)) {
          newerWireVersion = true;
        } else {
          migrations = resolveWireMigrations(sourceRecord.protocol_version);
          if (sourceRecord.protocol_version !== WIRE_PROTOCOL_VERSION) {
            rewrittenRecords = [];
          }
        }
      }

      const migratedRecord = migrateWireRecord(sourceRecord, migrations);
      const record =
        !newerWireVersion && migratedRecord.type === 'metadata'
          ? { ...migratedRecord, protocol_version: WIRE_PROTOCOL_VERSION }
          : migratedRecord;
      rewrittenRecords?.push(record);
      yield record;
      if (record.type !== 'metadata') {
        recordIndex++;
      }
    }

    if (!hasRecords) {
      rewrittenRecords = [createWireMetadataRecord()];
    }
    if (truncation !== undefined || rewrittenRecords !== undefined) {
      if (this.transcriptEpoch?.state === 'open') this.transcriptEpoch = { ...this.transcriptEpoch, trusted: false };
    }
    if (truncation !== undefined) {
      await this.repairJournal(truncation, rewrittenRecords);
    } else if (rewrittenRecords !== undefined) {
      await this.log.rewrite(this.wireScope, AGENT_WIRE_RECORD_KEY, rewrittenRecords);
    }
  }

  private async repairJournal(
    truncation: AppendLogTruncation,
    rewrittenRecords: WireRecord[] | undefined,
  ): Promise<void> {
    let records: WireRecord[] = rewrittenRecords ?? [];
    if (rewrittenRecords === undefined) {
      const tolerate = { onTruncate: () => {} };
      for await (const record of this.log.read<WireRecord>(
        this.wireScope,
        AGENT_WIRE_RECORD_KEY,
        tolerate,
      )) {
        records.push(record);
      }
    }
    const outcome = await repairWireJournal(
      {
        appendLog: this.log,
        storage: this.storage,
        log: this.logger,
        telemetry: this.telemetry,
      },
      this.wireScope,
      AGENT_WIRE_RECORD_KEY,
      records,
      truncation,
    );
    this.pendingRepair = outcome === 'failed' ? { records, truncation } : undefined;
  }

  private async repairPendingJournal(): Promise<void> {
    const pending = this.pendingRepair;
    if (pending === undefined) return;
    await this.repairJournal(pending.truncation, pending.records);
    if (this.pendingRepair !== undefined) {
      const error = new WireError(
        WireErrors.codes.RECORDS_WRITE_FAILED,
        'Wire journal repair did not complete; record was not appended',
        {
          details: {
            scope: this.wireScope,
            key: AGENT_WIRE_RECORD_KEY,
            lineNumber: pending.truncation.lineNumber,
          },
        },
      );
      throw error;
    }
  }

  async flush(): Promise<void> {
    await this.persistQueue;
    try {
      await this.log.flush(this.wireScope, AGENT_WIRE_RECORD_KEY);
    } catch (error) {
      if (this.persistFailure !== undefined) throw this.persistFailure.error;
      throw error;
    }
    if (this.persistFailure !== undefined) throw this.persistFailure.error;
  }

  async journalIdentity(): Promise<WireJournalIdentity> {
    await this.flush();
    return {
      size: await this.storage.size(this.wireScope, AGENT_WIRE_RECORD_KEY) ?? 0,
      mtimeMs: await this.storage.mtime(this.wireScope, AGENT_WIRE_RECORD_KEY) ?? 0,
      headHash: await this.journalHeadHash(),
    };
  }

  private async journalHeadHash(): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of this.storage.readStream(this.wireScope, AGENT_WIRE_RECORD_KEY, {
      start: 0,
      end: JOURNAL_HEAD_HASH_BYTES - 1,
    })) {
      hash.update(chunk);
    }
    return hash.digest('hex').slice(0, JOURNAL_HEAD_HASH_HEX_LENGTH);
  }

  private reportPersistFailure(error: unknown): void {
    this.persistFailure ??= { error };
    onUnexpectedError(error);
  }

  private reportSkippedRecord(type: string | undefined, index: number, malformed = false): void {
    onUnexpectedError(
      new WireError(
        WireErrors.codes.WIRE_UNKNOWN_RECORD,
        type === undefined
          ? 'Malformed wire record skipped during restore'
          : malformed
            ? `Malformed wire record type '${type}' skipped during restore`
            : `Unknown wire record type '${type}' skipped during restore`,
        { details: { type, index } },
      ),
    );
  }

  private appendRecordLow(record: WireRecord): void {
    const expectedBytes = this.transcriptEpoch?.state === 'open' && this.transcriptEpoch.trusted &&
      this.epochExpectedHash !== undefined
      ? Buffer.from(`${JSON.stringify(record)}\n`)
      : undefined;
    this.log.append(this.wireScope, AGENT_WIRE_RECORD_KEY, record, {
      onError: onUnexpectedError,
    });
    if (expectedBytes !== undefined) {
      this.epochExpectedHash!.update(expectedBytes);
      this.epochExpectedSize += expectedBytes.byteLength;
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IWireService,
  WireService,
  ScopeActivation.OnScopeCreated,
  'wire',
);
