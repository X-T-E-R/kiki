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
  type AppendLogSourceRevision,
  IAppendLogStore,
} from '#/persistence/interface/appendLogStore';
import { coldManifestKey, logicalByteSize, readLogicalBytes } from '#/persistence/coldSegmentLog';
import { IFileSystemStorageService, StorageError, StorageErrors, type StorageReadRange } from '#/persistence/interface/storage';

import { IWireService, JOURNAL_HEAD_HASH_BYTES, JournalTailUnreadableError, type WireJournalIdentity, type WireJournalReadOptions } from './wire';
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
  WIRE_RECEIPT_TAIL_BYTES,
  WIRE_TRANSCRIPT_RECEIPT_KEY,
  extendWireDigest,
  type WireDigestState,
  parseWireTranscriptReceipt,
  wireTailSha256,
  type WireTranscriptReceipt,
} from './transcriptReceipt';

const JOURNAL_HEAD_HASH_HEX_LENGTH = 32;
const WIRE_DIGEST_BOUNDARY_BYTES = 4096;

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
  private epochBase: {
    readonly generation: number;
    readonly identity: AppendLogSourceRevision | undefined;
    readonly state: WireDigestState;
    readonly boundary: Buffer;
  } | undefined;
  private epochAcceptedRecords = 0;
  private epochExpectedHash: Hash | undefined;
  private epochExpectedSize = 0;
  private verifiedAcceptedRecords = -1;
  private verifiedJournal: {
    readonly generation: number;
    readonly source: AppendLogSourceRevision;
    readonly state: WireDigestState;
    readonly boundary: Buffer;
  } | undefined;
  private sealedPrefix: { readonly size: number; readonly sha256: string } | undefined;
  private prefixHash: Hash | undefined;
  private prefixHashLength = 0;
  private journalGeneration = 0;
  private journalHashOperation: Promise<void> = Promise.resolve();
  private appendedBytes = 0;
  private readonly appendListeners = new Set<(appendedBytes: number) => void>();
  private transcriptVerification: {
    readonly epoch: WireTranscriptReceipt;
    readonly accepted: number;
    readonly promise: Promise<boolean>;
  } | undefined;

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
    const base = await this.readJournalBase();
    if (base === undefined) throw new Error('Transcript wire changed while opening its epoch');
    const endsWithNewline = base.boundary.at(-1) === 0x0a;
    let trusted = this.freshJournal && previousBytes === undefined;
    if (previousBytes !== undefined) {
      let previous: WireTranscriptReceipt | undefined;
      try {
        previous = parseWireTranscriptReceipt(JSON.parse(Buffer.from(previousBytes).toString('utf8')));
      } catch {
        previous = undefined;
      }
      const sealed = previous?.state === 'sealed' && previous.trusted ? previous.wire : undefined;
      if (sealed !== undefined && 'sha256' in sealed) this.sealedPrefix = { size: sealed.size, sha256: sealed.sha256 };
      trusted = sealed !== undefined && base.size === sealed.size &&
        (!('tailSha256' in sealed) || (sealed.tailBytes <= base.boundary.byteLength &&
          wireTailSha256(base.boundary.subarray(base.boundary.byteLength - sealed.tailBytes)) === sealed.tailSha256));
    }
    trusted = trusted && base.size > 0 && endsWithNewline;
    if (trusted) {
      let first: unknown;
      for await (const candidate of this.log.read(this.wireScope, AGENT_WIRE_RECORD_KEY)) {
        first = candidate;
        break;
      }
      trusted = first !== undefined && isWireRecord(first) && isWireMetadataRecord(first);
    }
    const epoch: WireTranscriptReceipt = { format: 2, epoch: randomUUID(), state: 'open', trusted };
    await this.storage.write(
      this.wireScope,
      WIRE_TRANSCRIPT_RECEIPT_KEY,
      Buffer.from(JSON.stringify(epoch)),
      { atomic: true },
    );
    this.transcriptEpoch = epoch;
    this.epochBase = {
      generation: this.journalGeneration,
      identity: base.identity,
      state: { hash: createHash('sha256'), size: base.size, lines: 0, endsWithNewline },
      boundary: base.boundary,
    };
    this.verifiedJournal = undefined;
    this.epochAcceptedRecords = 0;
    this.epochExpectedHash = trusted ? createHash('sha256') : undefined;
    this.epochExpectedSize = base.size;
    this.verifiedAcceptedRecords = -1;
  }

  async sealTranscriptEpoch(): Promise<void> {
    if (this.transcriptEpoch?.state !== 'open') throw new Error('Transcript epoch is not open');
    await this.flush();
    let digest = await this.readEpochDigest();
    if (this.transcriptEpoch?.state !== 'open') throw new Error('Transcript epoch is not open');
    if (digest === undefined || (this.transcriptEpoch.trusted && !this.transcriptDigestMatches(digest.state, this.epochAcceptedRecords))) {
      await this.flush();
      if (this.transcriptEpoch?.state !== 'open') throw new Error('Transcript epoch is not open');
      digest = await this.readEpochDigest();
      if (this.transcriptEpoch?.state !== 'open') throw new Error('Transcript epoch is not open');
    }
    digest ??= await this.readUnverifiedTail();
    if (digest === undefined) throw new Error('Transcript wire changed while sealing its epoch');
    const open = this.transcriptEpoch;
    if (open?.state !== 'open') throw new Error('Transcript epoch is not open');
    const certified = open.trusted && this.transcriptDigestMatches(digest.state, this.epochAcceptedRecords);
    if (open.trusted && !certified) {
      this.verifiedAcceptedRecords = -1;
      this.transcriptEpoch = { ...open, trusted: false };
      onUnexpectedError(new Error('Transcript wire contents do not match accepted events'));
    }
    const sealing = this.transcriptEpoch;
    if (sealing?.state !== 'open') throw new Error('Transcript epoch is not open');
    const tail = digest.boundary.subarray(Math.max(0, digest.boundary.byteLength - WIRE_RECEIPT_TAIL_BYTES));
    const sealed: WireTranscriptReceipt = {
      ...sealing,
      format: 2,
      state: 'sealed',
      trusted: sealing.trusted,
      wire: { size: digest.state.size, tailBytes: tail.byteLength, tailSha256: wireTailSha256(tail) },
    };
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
    if (epoch?.state !== 'open' || !epoch.trusted || this.persistFailure !== undefined) return false;
    const accepted = this.epochAcceptedRecords;
    const pending = this.transcriptVerification;
    if (pending?.epoch === epoch && pending.accepted === accepted) return pending.promise;
    this.verifiedAcceptedRecords = -1;
    const verification = { epoch, accepted, promise: this.verifyTranscriptFence(epoch, accepted) };
    this.transcriptVerification = verification;
    try {
      return await verification.promise;
    } finally {
      if (this.transcriptVerification === verification) this.transcriptVerification = undefined;
    }
  }

  private async verifyTranscriptFence(epoch: WireTranscriptReceipt, accepted: number): Promise<boolean> {
    await this.flush();
    const stored = await this.storage.read(this.wireScope, WIRE_TRANSCRIPT_RECEIPT_KEY);
    if (stored === undefined || Buffer.from(stored).toString('utf8') !== JSON.stringify(epoch)) return false;
    const digest = await this.readEpochDigest();
    const verified = this.transcriptEpoch === epoch && this.persistFailure === undefined &&
      this.epochAcceptedRecords === accepted && digest !== undefined && this.transcriptDigestMatches(digest.state, accepted);
    if (this.transcriptEpoch === epoch && this.epochAcceptedRecords === accepted) {
      this.verifiedAcceptedRecords = verified ? accepted : -1;
    }
    return verified;
  }

  private transcriptDigestMatches(digest: WireDigestState, acceptedRecords: number): boolean {
    return digest.size > 0 && digest.endsWithNewline && digest.lines === acceptedRecords &&
      this.epochExpectedHash !== undefined && digest.size === this.epochExpectedSize &&
      digest.hash.copy().digest('hex') === this.epochExpectedHash.copy().digest('hex');
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

  async *readJournal(options?: WireJournalReadOptions): AsyncIterable<WireRecord> {
    if (options?.startByte !== undefined && options.startByte > 0) {
      yield* this.readJournalTail(options.startByte);
      return;
    }
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
      this.resetJournalPrefix();
      await this.repairJournal(truncation, rewrittenRecords);
    } else if (rewrittenRecords !== undefined) {
      this.resetJournalPrefix();
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
    this.resetJournalPrefix();
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

  sealedJournalDigest(): { readonly size: number; readonly sha256: string } | undefined {
    return this.sealedPrefix;
  }

  appendedByteCount(): number {
    return this.appendedBytes;
  }

  onDidAppendBytes(listener: (appendedBytes: number) => void): { dispose(): void } {
    this.appendListeners.add(listener);
    return { dispose: () => { this.appendListeners.delete(listener); } };
  }

  async journalSha256(byteLength: number): Promise<string | undefined> {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) return undefined;
    const previous = this.journalHashOperation;
    const operation = previous.then(() => this.computeJournalSha256(byteLength));
    this.journalHashOperation = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async computeJournalSha256(byteLength: number): Promise<string | undefined> {
    await this.flush();
    const generation = this.journalGeneration;
    const size = await this.journalSize() ?? 0;
    if (byteLength > size) return undefined;
    const hash = this.prefixHash !== undefined && this.prefixHashLength <= byteLength
      ? this.prefixHash.copy()
      : createHash('sha256');
    const start = this.prefixHash !== undefined && this.prefixHashLength <= byteLength
      ? this.prefixHashLength
      : 0;
    if (start < byteLength) {
      let read = 0;
      for await (const chunk of this.journalBytes({
        start,
        end: byteLength - 1,
      })) {
        hash.update(chunk);
        read += chunk.byteLength;
      }
      if (read !== byteLength - start || generation !== this.journalGeneration) return undefined;
    }
    if (generation !== this.journalGeneration) return undefined;
    this.prefixHash = hash;
    this.prefixHashLength = byteLength;
    return hash.copy().digest('hex');
  }

  private async readJournalBase(): Promise<{
    readonly size: number;
    readonly boundary: Buffer;
    readonly identity: AppendLogSourceRevision | undefined;
  } | undefined> {
    const generation = this.journalGeneration;
    const source = await this.log.sourceRevision?.(this.wireScope, AGENT_WIRE_RECORD_KEY);
    const cold = await this.storage.read(this.wireScope, coldManifestKey(AGENT_WIRE_RECORD_KEY)) !== undefined;
    const size = (cold ? undefined : source?.size) ?? await this.journalSize() ?? 0;
    const chunks: Uint8Array[] = [];
    if (size > 0) {
      for await (const chunk of this.journalBytes({ start: Math.max(0, size - WIRE_DIGEST_BOUNDARY_BYTES), end: size - 1 })) {
        chunks.push(chunk);
      }
    }
    const boundary = Buffer.concat(chunks);
    const after = await this.log.sourceRevision?.(this.wireScope, AGENT_WIRE_RECORD_KEY);
    if (generation !== this.journalGeneration || boundary.byteLength !== Math.min(size, WIRE_DIGEST_BOUNDARY_BYTES) ||
      source?.revision !== after?.revision || source?.identity !== after?.identity || source?.size !== after?.size) return undefined;
    return { size, boundary, identity: cold ? undefined : source };
  }

  private async readEpochDigest(): Promise<{ state: WireDigestState; boundary: Buffer } | undefined> {
    const base = this.epochBase;
    if (base === undefined || base.generation !== this.journalGeneration) return undefined;
    const generation = this.journalGeneration;
    const source = await this.log.sourceRevision?.(this.wireScope, AGENT_WIRE_RECORD_KEY);
    const cold = await this.storage.read(this.wireScope, coldManifestKey(AGENT_WIRE_RECORD_KEY)) !== undefined;
    const chained = !cold && source?.identity !== undefined && base.identity?.identity !== undefined;
    if (chained && (source.revision !== base.identity!.revision || source.identity !== base.identity!.identity)) return undefined;
    const size = (cold ? undefined : source?.size) ?? await this.journalSize() ?? 0;
    if (size < base.state.size) return undefined;
    if (size === 0) return { state: base.state, boundary: base.boundary };
    const cached = this.verifiedJournal;
    const start = chained && cached !== undefined && cached.generation === generation &&
      cached.source.revision === source.revision && cached.source.identity === source.identity && cached.state.size <= size
      ? cached
      : base;
    const result = await this.resumeJournalDigest(start, size);
    const after = await this.log.sourceRevision?.(this.wireScope, AGENT_WIRE_RECORD_KEY);
    if (result === undefined || generation !== this.journalGeneration || source?.revision !== after?.revision ||
      source?.identity !== after?.identity || (!cold && source?.size !== after?.size)) return undefined;
    if (chained) {
      const current = this.verifiedJournal;
      if (!(current !== undefined && current.generation === generation && current.source.revision === source.revision &&
        current.state.size > size)) {
        this.verifiedJournal = { generation, source, ...result };
      }
    }
    return result;
  }

  private async readUnverifiedTail(): Promise<{ state: WireDigestState; boundary: Buffer } | undefined> {
    const base = await this.readJournalBase();
    if (base === undefined) return undefined;
    return {
      state: { hash: createHash('sha256'), size: base.size, lines: -1, endsWithNewline: base.boundary.at(-1) === 0x0a },
      boundary: base.boundary,
    };
  }

  private async resumeJournalDigest(
    cached: { readonly state: WireDigestState; readonly boundary: Buffer },
    size: number,
  ): Promise<{ state: WireDigestState; boundary: Buffer } | undefined> {
    const boundaryStart = cached.state.size - cached.boundary.byteLength;
    const observed: Uint8Array[] = [];
    let observedBytes = 0;
    const tail = new WireBoundaryCapture(cached.boundary);
    const source = this.journalBytes({ start: boundaryStart, end: size - 1 });
    const appended = async function* (): AsyncIterable<Uint8Array> {
      for await (const chunk of source) {
        let offset = 0;
        if (observedBytes < cached.boundary.byteLength) {
          offset = Math.min(chunk.byteLength, cached.boundary.byteLength - observedBytes);
          observed.push(chunk.subarray(0, offset));
          observedBytes += offset;
          if (observedBytes === cached.boundary.byteLength && !Buffer.concat(observed).equals(cached.boundary)) {
            throw new WireBoundaryMismatch();
          }
        }
        if (offset < chunk.byteLength) yield chunk.subarray(offset);
      }
    };
    let state: WireDigestState;
    try {
      state = await extendWireDigest(cached.state, tail.observe(appended()));
    } catch (error) {
      if (error instanceof WireBoundaryMismatch) return undefined;
      throw error;
    }
    if (observedBytes !== cached.boundary.byteLength || state.size !== size) return undefined;
    return { state, boundary: tail.bytes() };
  }

  private resetJournalPrefix(): void {
    this.verifiedJournal = undefined;
    this.journalGeneration += 1;
    this.prefixHash = undefined;
    this.prefixHashLength = 0;
    this.appendedBytes = 0;
    for (const listener of this.appendListeners) listener(0);
  }

  private async *readJournalTail(startByte: number): AsyncIterable<WireRecord> {
    if (!Number.isSafeInteger(startByte) || startByte <= 0) throw new JournalTailUnreadableError();
    const size = await this.journalSize() ?? 0;
    if (startByte > size) throw new JournalTailUnreadableError();
    let marker: number | undefined;
    for await (const chunk of this.journalBytes({
      start: startByte - 1,
      end: startByte - 1,
    })) {
      marker = chunk[0];
    }
    if (marker !== 0x0a) throw new JournalTailUnreadableError();
    if (startByte === size) return;
    const decoder = new TextDecoder();
    let pending = '';
    for await (const chunk of this.journalBytes({
      start: startByte,
      end: size - 1,
    })) {
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const raw = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (line.length > 0) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            throw new JournalTailUnreadableError();
          }
          if (!isWireRecord(parsed)) throw new JournalTailUnreadableError();
          yield parsed;
        }
        newline = pending.indexOf('\n');
      }
    }
    pending += decoder.decode();
    if (pending.length > 0) throw new JournalTailUnreadableError();
  }

  async journalIdentity(): Promise<WireJournalIdentity> {
    await this.flush();
    return {
      size: await this.journalSize() ?? 0,
      mtimeMs: await this.storage.mtime(this.wireScope, AGENT_WIRE_RECORD_KEY) ?? 0,
      headHash: await this.journalHeadHash(),
    };
  }

  private async journalHeadHash(): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of this.journalBytes({
      start: 0,
      end: JOURNAL_HEAD_HASH_BYTES - 1,
    })) {
      hash.update(chunk);
    }
    return hash.digest('hex').slice(0, JOURNAL_HEAD_HASH_HEX_LENGTH);
  }

  private journalBytes(range?: StorageReadRange): AsyncIterable<Uint8Array> {
    return readLogicalBytes(this.storage, this.wireScope, AGENT_WIRE_RECORD_KEY, range);
  }

  private journalSize(): Promise<number | undefined> {
    return logicalByteSize(this.storage, this.wireScope, AGENT_WIRE_RECORD_KEY);
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
    this.appendedBytes += Buffer.byteLength(`${JSON.stringify(record)}\n`);
    for (const listener of this.appendListeners) listener(this.appendedBytes);
    if (expectedBytes !== undefined) {
      this.epochExpectedHash!.update(expectedBytes);
      this.epochExpectedSize += expectedBytes.byteLength;
    }
  }
}

class WireBoundaryMismatch extends Error {}

class WireBoundaryCapture {
  private tail: Buffer;

  constructor(initial: Buffer = Buffer.alloc(0)) {
    this.tail = initial;
  }

  async *observe(chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
    for await (const chunk of chunks) {
      this.tail = chunk.byteLength >= WIRE_DIGEST_BOUNDARY_BYTES
        ? Buffer.from(chunk.subarray(chunk.byteLength - WIRE_DIGEST_BOUNDARY_BYTES))
        : Buffer.concat([this.tail.subarray(Math.max(0, this.tail.byteLength + chunk.byteLength - WIRE_DIGEST_BOUNDARY_BYTES)), chunk]);
      yield chunk;
    }
  }

  bytes(): Buffer {
    return this.tail;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IWireService,
  WireService,
  ScopeActivation.OnScopeCreated,
  'wire',
);
