import { createDecorator } from '#/_base/di/instantiation';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IMemoryPersistence, type MemoryLegacyPayload } from '#/persistence/interface/memoryPersistence';
import { IMemoryScopes, type MemoryScope } from './memoryScopes';
import { decodeMemoryEntry } from './memoryStore';

export interface MemoryShadowImportResult {
  readonly imported: number;
  readonly retained: number;
  readonly issues: readonly { readonly scope: string; readonly key: string; readonly issue: string }[];
  readonly nextKey?: string;
  readonly complete: boolean;
}
export interface IMemoryShadowImport {
  readonly _serviceBrand: undefined;
  run(scope: MemoryScope, after?: string, signal?: AbortSignal): Promise<MemoryShadowImportResult>;
}
export const IMemoryShadowImport = createDecorator<IMemoryShadowImport>('memoryShadowImport');
export class MemoryShadowImport implements IMemoryShadowImport {
  declare readonly _serviceBrand: undefined;
  constructor(@IFileSystemStorageService private readonly storage: IFileSystemStorageService, @IMemoryScopes private readonly scopes: IMemoryScopes, @IMemoryPersistence private readonly persistence: IMemoryPersistence) {}
  async run(scope: MemoryScope, after?: string, signal?: AbortSignal): Promise<MemoryShadowImportResult> {
    const base = await this.scopes.resolve(scope);
    const keys: string[] = [];
    for (const folder of ['entries', 'inbox']) for (const name of await this.storage.list(`${base}/${folder}`)) if (name.endsWith('.md')) keys.push(`${folder}/${name}`);
    if (await this.storage.size(base, 'journal.jsonl') !== undefined) keys.push('journal.jsonl');
    keys.sort();
    const selected = keys.filter((key) => after === undefined || key > after).slice(0, 128);
    const batch: MemoryLegacyPayload[] = [];
    const issues: MemoryShadowImportResult['issues'][number][] = [];
    let bytes = 0;
    let nextKey = after;
    for (const key of selected) {
      signal?.throwIfAborted();
      const size = await this.storage.size(base, key);
      const mtime = await this.storage.mtime(base, key);
      if (size === undefined) { issues.push({ scope: base, key, issue: 'source_disappeared' }); nextKey = key; continue; }
      if (size > 16 * 1024 * 1024) { issues.push({ scope: base, key, issue: 'source_exceeds_16_mib_import_unit' }); nextKey = key; continue; }
      if (bytes + size > 16 * 1024 * 1024 && batch.length > 0) break;
      const raw = await this.storage.read(base, key, { recoverMissing: false });
      if (raw === undefined || size !== raw.byteLength || size !== await this.storage.size(base, key) || mtime !== await this.storage.mtime(base, key)) {
        issues.push({ scope: base, key, issue: 'source_changed_retry_incremental_import' }); nextKey = key; continue;
      }
      bytes += raw.byteLength;
      const payload = new TextDecoder().decode(raw);
      let entry: MemoryLegacyPayload['entry'];
      const history: NonNullable<MemoryLegacyPayload['history']>[number][] = [];
      const journal: NonNullable<MemoryLegacyPayload['journal']>[number][] = [];
      let issue: string | undefined;
      if (key !== 'journal.jsonl') {
        try {
          entry = decodeMemoryEntry(payload);
          if (key.slice(key.lastIndexOf('/') + 1, -3) !== entry.id) { entry = undefined; issue = 'legacy_identity_mismatch'; }
        } catch (error) { issue = error instanceof Error ? error.message : 'invalid_legacy_entry'; }
      } else {
        for (const line of payload.split('\n').filter(Boolean)) {
          try {
            const record = JSON.parse(line) as NonNullable<MemoryLegacyPayload['journal']>[number];
            if (!record.operationId || !/^m_[a-zA-Z0-9_]+$/.test(record.id) || typeof record.action !== 'string' || typeof record.at !== 'string' || !['user', 'agent', 'consolidator', 'import'].includes(record.writer) || record.before !== null && typeof record.before !== 'string' || record.afterRevision !== null && typeof record.afterRevision !== 'string') throw new Error('Invalid legacy journal record');
            if (record.before !== null) {
              const previous = decodeMemoryEntry(record.before);
              if (previous.id !== record.id || previous.revision !== record.beforeRevision) throw new Error('Broken legacy revision link');
              history.push(previous);
            }
            journal.push(record);
          } catch (error) { issue = error instanceof Error ? error.message : 'invalid_legacy_journal'; }
        }
      }
      batch.push({ scope: base, key, payload, entry, history, journal, issue });
      nextKey = key;
    }
    signal?.throwIfAborted();
    const imported = await this.persistence.importLegacy(batch);
    const complete = !keys.some((key) => nextKey === undefined || key > nextKey);
    return { ...imported, issues: [...issues, ...imported.issues], complete, nextKey: complete ? undefined : nextKey };
  }
}
registerScopedService(LifecycleScope.App, IMemoryShadowImport, MemoryShadowImport, ScopeActivation.OnDemand, 'memory');
