import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';

import type { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import { isPlainObject, stripTomlBom } from './configPure';
import { planConfigWriteback } from './tomlWriteback';

type Raw = Record<string, unknown>;
const SCOPE = '';
const REVISION_KEY = randomBytes(32);
const BACKUP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isModelGenerationBackupKey(configKey: string, name: string): boolean {
  const prefix = `${configKey}.generation-backup-`;
  return name.startsWith(prefix) && BACKUP_UUID.test(name.slice(prefix.length));
}

export type ModelGenerationMigrationReason = 'invalid_model' | 'invalid_parameters' | 'invalid_value' | 'differs' | 'ambiguous' | 'default_effort' | 'max_output_size';

export interface ModelGenerationMigrationPreview {
  readonly changes: readonly { readonly modelId: string; readonly fields: readonly string[] }[];
  readonly needsConfirmation: readonly { readonly modelId: string; readonly reason: string; readonly code: ModelGenerationMigrationReason; readonly field?: string }[];
}

export function modelGenerationRevision(text: string): string {
  return createHmac('sha256', REVISION_KEY).update(text).digest('hex');
}

export async function listModelGenerationBackups(store: IAtomicTomlDocumentStore, configKey: string): Promise<readonly string[]> {
  const names = await store.list(SCOPE, `${configKey}.generation-backup-`);
  return names.filter((name) => isModelGenerationBackupKey(configKey, name)).toSorted();
}

export interface PreparedModelGenerationMigration {
  readonly preview: ModelGenerationMigrationPreview;
  readonly originalText: string;
  readonly nextText: string;
}

export function prepareModelGenerationMigration(originalText: string): PreparedModelGenerationMigration {
  const parsed: unknown = parseToml(stripTomlBom(originalText));
  if (!isPlainObject(parsed)) throw new Error('Configuration is not a TOML table');
  const models = parsed['models'];
  if (models !== undefined && !isPlainObject(models)) throw new Error('Models section is not a TOML table');
  const migrated: Raw = { ...(models as Raw | undefined) };
  const changes: Array<{ modelId: string; fields: string[] }> = [];
  const needsConfirmation: Array<ModelGenerationMigrationPreview['needsConfirmation'][number]> = [];
  for (const [modelId, value] of Object.entries(migrated)) {
    if (!isPlainObject(value)) {
      needsConfirmation.push({ modelId, code: 'invalid_model', reason: 'Model entry is not a table; no automatic conversion.' });
      continue;
    }
    const parameters = value['parameters'];
    if (parameters !== undefined && !isPlainObject(parameters)) {
      needsConfirmation.push({ modelId, code: 'invalid_parameters', reason: 'Existing parameters are not a table; no automatic conversion.' });
      continue;
    }
    const next: Raw = { ...(parameters as Raw | undefined) };
    const migratedFields: string[] = [];
    const legacyOverride = isPlainObject(value['overrides']) ? value['overrides'] : {};
    const requestParams = isPlainObject(value['request_params']) ? value['request_params'] : {};
    const overrideParams = isPlainObject(legacyOverride['request_params']) ? legacyOverride['request_params'] : {};
    for (const [target, source, valid] of [
      ['temperature', 'temperature', (item: unknown) => typeof item === 'number' && Number.isFinite(item) && item >= 0],
      ['top_p', 'top_p', (item: unknown) => typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 1],
    ] as const) {
      const candidate = overrideParams[source] ?? requestParams[source];
      if (candidate === undefined) continue;
      if (!valid(candidate)) {
        needsConfirmation.push({ modelId, code: 'invalid_value', field: source, reason: `Legacy ${source} cannot be mapped without changing semantics.` });
      } else if (next[target] !== undefined && next[target] !== candidate) {
        needsConfirmation.push({ modelId, code: 'differs', field: target, reason: `Existing parameters.${target} differs from the legacy value.` });
      } else if (next[target] === undefined) {
        next[target] = candidate;
        migratedFields.push(target);
      }
    }
    for (const key of ['max_completion_tokens', 'service_tier'] as const) {
      const candidate = legacyOverride[key] ?? value[key];
      if (candidate === undefined) continue;
      const valid = key === 'max_completion_tokens'
        ? typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0
        : typeof candidate === 'string' && ['auto', 'default', 'flex', 'priority'].includes(candidate);
      if (!valid) {
        needsConfirmation.push({ modelId, code: 'ambiguous', field: key, reason: `Legacy ${key} is invalid or ambiguous.` });
      } else if (next[key] !== undefined && next[key] !== candidate) {
        needsConfirmation.push({ modelId, code: 'differs', field: key, reason: `Existing parameters.${key} differs from the legacy value.` });
      } else if (next[key] === undefined) {
        next[key] = candidate;
        migratedFields.push(key);
      }
    }
    if (value['default_effort'] !== undefined || legacyOverride['default_effort'] !== undefined) {
      needsConfirmation.push({ modelId, code: 'default_effort', reason: 'Legacy default_effort is also capability metadata; it is retained without conversion.' });
    }
    if (value['max_output_size'] !== undefined || legacyOverride['max_output_size'] !== undefined) {
      needsConfirmation.push({ modelId, code: 'max_output_size', reason: 'Legacy max_output_size may be a limit or a preference; it is retained without conversion.' });
    }
    if (migratedFields.length === 0) continue;
    migrated[modelId] = { ...value, parameters: next };
    changes.push({ modelId, fields: migratedFields });
  }
  const nextText = changes.length === 0 ? originalText : planConfigWriteback(originalText, [
    { snakeKey: 'models', previousValue: models, nextValue: migrated },
  ], { ...parsed, models: migrated });
  if (nextText === undefined) throw new Error('TOML writeback cannot preserve this configuration; migration refused');
  const reparsed: unknown = parseToml(stripTomlBom(nextText));
  if (!isPlainObject(reparsed) || (reparsed['models'] !== undefined && !isPlainObject(reparsed['models']))) {
    throw new Error('Migration output could not be parsed; migration refused');
  }
  return { preview: { changes, needsConfirmation }, originalText, nextText };
}

export async function previewModelGenerationMigration(
  store: IAtomicTomlDocumentStore, configKey: string,
): Promise<PreparedModelGenerationMigration> {
  const text = await store.getText(SCOPE, configKey, { recoverMissing: false });
  if (text === undefined) throw new Error('Config document is missing');
  return prepareModelGenerationMigration(text);
}

export async function applyModelGenerationMigration(
  store: IAtomicTomlDocumentStore, configKey: string, prepared: PreparedModelGenerationMigration,
): Promise<{ readonly backupKey: string | undefined }> {
  const verified = prepareModelGenerationMigration(prepared.originalText);
  if (verified.nextText !== prepared.nextText) throw new Error('Migration preview was modified; preview again');
  if (prepared.nextText === prepared.originalText) return { backupKey: undefined };
  const current = await store.getText(SCOPE, configKey);
  if (current !== prepared.originalText) throw new Error('Config changed after preview; preview again before migration');
  const backupKey = `${configKey}.generation-backup-${randomUUID()}`;
  if (!await store.compareAndSetText(SCOPE, backupKey, undefined, prepared.originalText)) {
    throw new Error('Migration backup already exists; no changes made');
  }
  let published: boolean;
  try {
    published = await store.compareAndSetText(SCOPE, configKey, prepared.originalText, prepared.nextText);
  } catch (error) {
    throw new Error(`Migration write outcome is uncertain; inspect config and backup ${backupKey} before retrying`, { cause: error });
  }
  if (!published) {
    let removed: boolean;
    try {
      removed = await store.compareAndSetText(SCOPE, backupKey, prepared.originalText, undefined);
    } catch (error) {
      throw new Error(`Config changed during migration; backup cleanup is uncertain. Inspect backup ${backupKey}`, { cause: error });
    }
    if (!removed) throw new Error(`Config changed during migration; backup cleanup conflicted. Inspect backup ${backupKey}`);
    throw new Error('Config changed during migration; this migration published no config or backup');
  }
  return { backupKey };
}

export async function restoreModelGenerationMigration(
  store: IAtomicTomlDocumentStore, configKey: string, prepared: PreparedModelGenerationMigration,
  backupKey: string,
): Promise<void> {
  if (!isModelGenerationBackupKey(configKey, backupKey)) throw new Error('Invalid migration backup key');
  const backup = await store.getText(SCOPE, backupKey);
  if (backup === undefined || backup !== prepared.originalText) throw new Error('Migration backup missing or changed');
  if (!await store.compareAndSetText(SCOPE, configKey, prepared.nextText, backup)) {
    throw new Error('Config changed since migration; refusing to overwrite subsequent edits');
  }
}
