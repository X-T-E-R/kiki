import { createDecorator } from '#/_base/di/instantiation';
import type { MemoryEntry, MemoryJournalRecord } from '#/app/memory/memoryStore';

export interface MemoryStoredObject {
  readonly scope: string;
  readonly id: string;
  readonly entry: MemoryEntry | null;
  readonly revision: string;
}
export interface MemoryReadView {
  readonly generation: number;
  readonly objects: readonly MemoryStoredObject[];
}
export interface MemoryObjectEdit {
  readonly scope: string;
  readonly id: string;
  readonly expectedRevision: string | null;
  readonly entry: MemoryEntry | null;
  readonly revision: string;
}
export interface MemoryEvidenceSource {
  readonly id: string;
  readonly scope: string;
  readonly objectId: string;
  readonly payload: string;
  readonly locator?: string;
  readonly learnedAt: string;
}
export type MemorySourceState =
  | { readonly state: 'missing' }
  | { readonly state: 'forgotten'; readonly id: string; readonly scope: string }
  | { readonly state: 'registered'; readonly source: MemoryEvidenceSource; readonly objectIds: readonly string[] };
export interface MemoryProvenance {
  readonly sources: readonly MemoryEvidenceSource[];
  readonly adjudications: readonly MemoryAdjudication[];
  readonly relatedObjectIds: readonly string[];
}
export interface MemoryAdjudication {
  readonly id: string;
  readonly scope: string;
  readonly objectId: string;
  readonly kind: 'correction' | 'retirement' | 'restoration';
  readonly revision: string;
  readonly reason: string;
  readonly sourceIds: readonly string[];
}
export interface MemoryForgetBarrier {
  readonly scope: string;
  readonly objectId: string;
  readonly at: string;
}
export interface MemoryCommit {
  readonly operationId: string;
  readonly request: string;
  readonly expectedGeneration: number;
  readonly edits: readonly MemoryObjectEdit[];
  readonly sources?: readonly (MemoryEvidenceSource & { readonly aliases?: readonly string[]; readonly signatures?: readonly string[] })[];
  readonly sourceTransfers?: readonly { readonly scope: string; readonly from: string; readonly to: string }[];
  readonly adjudications?: readonly MemoryAdjudication[];
  readonly barriers?: readonly MemoryForgetBarrier[];
  readonly journal?: readonly (MemoryJournalRecord & { readonly scope: string })[];
  readonly result: unknown;
}
export interface MemoryCommitReceipt {
  readonly operationId: string;
  readonly generation: number;
  readonly result: unknown;
  readonly saved: true;
  readonly index: 'lexical';
}
export interface MemoryLegacyPayload {
  readonly scope: string;
  readonly key: string;
  readonly payload: string;
  readonly entry?: MemoryEntry;
  readonly history?: readonly MemoryEntry[];
  readonly journal?: readonly MemoryJournalRecord[];
  readonly issue?: string;
}
export interface MemoryImportResult {
  readonly imported: number;
  readonly retained: number;
  readonly issues: readonly { readonly scope: string; readonly key: string; readonly issue: string }[];
}
export interface IMemoryPersistence {
  readonly _serviceBrand: undefined;
  read(scopes: readonly string[], generation?: number): Promise<MemoryReadView>;
  revision(scope: string, id: string, revision: string): Promise<MemoryEntry | undefined>;
  commit(input: MemoryCommit): Promise<MemoryCommitReceipt>;
  receipt(operationId: string, request?: string): Promise<MemoryCommitReceipt | undefined>;
  journal(scope: string, id?: string): Promise<readonly MemoryJournalRecord[]>;
  source(scope: string, id: string): Promise<MemorySourceState>;
  provenance(scope: string, id: string): Promise<MemoryProvenance>;
  importLegacy(batch: readonly MemoryLegacyPayload[]): Promise<MemoryImportResult>;
  legacy(scope: string): Promise<readonly MemoryLegacyPayload[]>;
  namespaces(): Promise<readonly string[]>;
  backup(recoveryId: string): Promise<{ readonly generation: number; readonly scope: string }>;
  close(): Promise<void>;
}
export const IMemoryPersistence = createDecorator<IMemoryPersistence>('memoryPersistence');
