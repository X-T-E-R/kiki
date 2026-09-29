import { createHash } from 'node:crypto';

import { stableFingerprint, type CanonicalConfig } from '@nb-corp/nb-search';
import { z } from 'zod';

import { isStorageError, StorageErrors, type IFileSystemStorageService, type IStorageLock } from '#/persistence/interface/storage';
import { nbSearchEnvironmentName } from './environment';

const SCOPE = 'secrets/nb-search';
const KEY = 'gui-credentials.json';
const MAX_BYTES = 256 * 1024;
const recordSchema = z.object({ provider_id: z.string(), env: z.string(), binding: z.string(), value: z.string() }).strict();
const documentSchema = z.object({ schema_version: z.literal('1'), slots: z.record(z.string(), recordSchema) }).strict();
type RecordEntry = z.infer<typeof recordSchema>;

/** The Kiki-owned credential document. CLI secrets and process env are never read by this store. */
export class NbSearchManagedCredentials {
  constructor(private readonly storage: IFileSystemStorageService) {}

  async read(slotId: string): Promise<{ entry?: RecordEntry; version: string }> {
    const doc = await this.readDocument();
    const entry = doc.slots[slotId];
    return { entry, version: version(entry) };
  }

  async all(): Promise<Readonly<Record<string, RecordEntry>>> {
    return (await this.readDocument()).slots;
  }

  async set(slotId: string, entry: RecordEntry | undefined, expectedVersion: string, verifyBinding: () => Promise<boolean>): Promise<string> {
    let lock: IStorageLock | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        lock = await this.storage.acquireLock(SCOPE, `${KEY}.lock`);
        break;
      } catch (error) {
        if (!isStorageError(error, StorageErrors.codes.STORAGE_LOCKED) || attempt === 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (lock === undefined) throw new ManagedCredentialError('unavailable');
    try {
      const doc = await this.readDocument();
      if (version(doc.slots[slotId]) !== expectedVersion || !await verifyBinding()) throw new ManagedCredentialError('changed');
      const original = doc.slots[slotId];
      if (entry === undefined) delete doc.slots[slotId];
      else doc.slots[slotId] = entry;
      const bytes = new TextEncoder().encode(JSON.stringify(doc));
      if (bytes.length > MAX_BYTES) throw new ManagedCredentialError('full');
      await this.storage.write(SCOPE, KEY, bytes, { atomic: true });
      try {
        if (!await verifyBinding()) throw new ManagedCredentialError('changed');
      } catch (error) {
        if (original === undefined) delete doc.slots[slotId];
        else doc.slots[slotId] = original;
        await this.storage.write(SCOPE, KEY, new TextEncoder().encode(JSON.stringify(doc)), { atomic: true });
        throw error;
      }
      return version(entry);
    } finally {
      await lock.release();
    }
  }

  private async readDocument(): Promise<z.infer<typeof documentSchema>> {
    const size = await this.storage.size(SCOPE, KEY);
    if (size === undefined) return { schema_version: '1', slots: {} };
    if (size > MAX_BYTES) throw new ManagedCredentialError('unreadable');
    const bytes = await this.storage.read(SCOPE, KEY);
    if (bytes === undefined || bytes.length > MAX_BYTES) throw new ManagedCredentialError('unreadable');
    try {
      return documentSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch {
      throw new ManagedCredentialError('unreadable');
    }
  }
}

export class ManagedCredentialError extends Error {
  constructor(readonly reason: 'changed' | 'full' | 'unreadable' | 'binding' | 'unavailable') {
    super(`NB_SEARCH_MANAGED_CREDENTIAL_${reason.toUpperCase()}`);
    this.name = 'ManagedCredentialError';
  }
}

function version(entry: RecordEntry | undefined): string {
  return entry === undefined ? 'none' : createHash('sha256').update(JSON.stringify(entry)).digest('hex');
}

function managedEnvAliases(config: CanonicalConfig, slotId: string, env: NodeJS.ProcessEnv) {
  const name = nbSearchEnvironmentName(env, config.credential_slots[slotId]!.env);
  return Object.entries(config.provider_instances).flatMap(([id, instance]) => {
    const otherSlotId = instance.credential_slot_id;
    if (otherSlotId === undefined || otherSlotId === slotId) return [];
    const otherSlot = config.credential_slots[otherSlotId];
    return otherSlot !== undefined && nbSearchEnvironmentName(env, otherSlot.env) === name
      ? [{ id, slot_id: otherSlotId, provider_id: otherSlot.provider_id, base_url: instance.base_url ?? null }]
      : [];
  }).toSorted((a, b) => a.id.localeCompare(b.id));
}

export function managedBindingVersion(config: CanonicalConfig, slotId: string, env: NodeJS.ProcessEnv): string {
  const consumers = Object.entries(config.provider_instances).flatMap(([id, instance]) =>
    instance.credential_slot_id === slotId
      ? [{ id, provider_id: instance.provider_id, base_url: instance.base_url ?? null }]
      : [],
  ).toSorted((a, b) => a.id.localeCompare(b.id));
  const slot = config.credential_slots[slotId];
  if (slot === undefined || consumers.length === 0 || consumers.some((consumer) => consumer.provider_id !== slot.provider_id)) {
    throw new ManagedCredentialError('binding');
  }
  const binding = stableFingerprint({ slotId, provider_id: slot.provider_id, env: nbSearchEnvironmentName(env, slot.env), consumers });
  const aliases = managedEnvAliases(config, slotId, env);
  return aliases.length === 0 ? binding : stableFingerprint({ binding, aliases });
}

/** A managed value cannot enter a vendor env variable shared by another referenced credential slot. */
export function managedBinding(config: CanonicalConfig, slotId: string, env: NodeJS.ProcessEnv): string {
  const binding = managedBindingVersion(config, slotId, env);
  if (managedEnvAliases(config, slotId, env).length > 0) throw new ManagedCredentialError('binding');
  return binding;
}

export function managedEntryMatches(entry: RecordEntry | undefined, config: CanonicalConfig, slotId: string, env: NodeJS.ProcessEnv): boolean {
  if (entry === undefined) return false;
  const slot = config.credential_slots[slotId];
  if (slot === undefined || entry.provider_id !== slot.provider_id || nbSearchEnvironmentName(env, entry.env) !== nbSearchEnvironmentName(env, slot.env)) return false;
  try {
    return entry.binding === managedBinding(config, slotId, env);
  } catch {
    return false;
  }
}
