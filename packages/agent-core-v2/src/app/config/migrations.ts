import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'pathe';

import { type IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { type ILogService } from '#/_base/log/log';
import { Error2, ErrorCodes } from '#/errors';

import { readConfigDocumentSnapshot, writeConfigDocument } from './configDocument';
import { mergeConfigCredentials, splitConfigCredentials } from './credentials';
import { deepEqual, isPlainObject } from './configPure';
import { replaceThinkingEffortMax } from './tomlWriteback';

const MIGRATIONS_FILE = 'migrations-effort.json';
const THINKING_EFFORT_MAX_TO_HIGH = 'thinking-effort-max-to-high';
const CONFIG_SCOPE = '';
export const CREDENTIALS_KEY = 'credentials/credentials.toml';
export const LEGACY_CREDENTIALS_KEY = 'credentials.toml';

/** Move the byte-exact legacy document; neither a conflicting destination nor a concurrent edit is overwritten. */
export async function migrateCredentialsDirectory(store: IAtomicTomlDocumentStore): Promise<void> {
  const oldText = await store.getText(CONFIG_SCOPE, LEGACY_CREDENTIALS_KEY, { recoverMissing: false });
  if (oldText === undefined) return;
  const newText = await store.getText(CONFIG_SCOPE, CREDENTIALS_KEY, { recoverMissing: false });
  if (newText !== undefined && newText !== oldText) {
    throw new Error2(ErrorCodes.CONFIG_PERSIST_BLOCKED, 'Old and new credentials.toml differ; resolve them before retrying migration. Neither file was changed.');
  }
  if (newText === undefined && !await store.compareAndSetText(CONFIG_SCOPE, CREDENTIALS_KEY, undefined, oldText)) {
    throw new Error2(ErrorCodes.CONFIG_PERSIST_BLOCKED, 'Credentials destination changed during migration; inspect both files before retrying.');
  }
  if (!await store.compareAndSetText(CONFIG_SCOPE, LEGACY_CREDENTIALS_KEY, oldText, undefined)) {
    throw new Error2(ErrorCodes.CONFIG_PERSIST_BLOCKED, 'Legacy credentials changed during migration; inspect both files before retrying.');
  }
}

function hasConflictingCredentialValues(inline: unknown, stored: unknown): boolean {
  if (Array.isArray(inline) && Array.isArray(stored)) {
    return inline.some((value, index) => index < stored.length && hasConflictingCredentialValues(value, stored[index]));
  }
  if (isPlainObject(inline) && isPlainObject(stored)) {
    return Object.entries(inline).some(([key, value]) => Object.hasOwn(stored, key) && hasConflictingCredentialValues(value, stored[key]));
  }
  return !deepEqual(inline, stored);
}

function hasAllCredentialPaths(current: unknown, original: unknown): boolean {
  if (Array.isArray(original)) {
    return Array.isArray(current) && original.every((value, index) => index < current.length && hasAllCredentialPaths(current[index], value));
  }
  if (isPlainObject(original)) {
    return isPlainObject(current) && Object.entries(original).every(([key, value]) => Object.hasOwn(current, key) && hasAllCredentialPaths(current[key], value));
  }
  return current !== undefined;
}

export async function migrateConfigCredentials(
  documentStore: IAtomicTomlDocumentStore,
  configKey: string,
  log: ILogService,
): Promise<void> {
  let config: Record<string, unknown>;
  let credentials: Record<string, unknown>;
  let configText: string | undefined;
  let credentialsText: string | undefined;
  try {
    const configSnapshot = await readConfigDocumentSnapshot(documentStore, configKey);
    const credentialsSnapshot = await readConfigDocumentSnapshot(documentStore, CREDENTIALS_KEY);
    config = configSnapshot.data;
    credentials = credentialsSnapshot.data;
    configText = configSnapshot.text;
    credentialsText = credentialsSnapshot.text;
  } catch {
    return;
  }
  const separated = splitConfigCredentials(config);
  if (deepEqual(separated.config, config)) return;
  if (configText === undefined) return;
  if (hasConflictingCredentialValues(separated.credentials, splitConfigCredentials(credentials).credentials)) {
    throw new Error2(ErrorCodes.CONFIG_PERSIST_BLOCKED, 'Legacy credential migration found conflicting inline and stored secrets. Resolve the conflicting credentials before retrying; neither file was changed.');
  }
  const merged = mergeConfigCredentials(config, credentials);
  const nextCredentials = splitConfigCredentials(merged).credentials;
  const backupKey = `${configKey}.bak-${new Date().toISOString().slice(0, 10)}-${randomUUID()}`;
  if (!await documentStore.compareAndSetText(CONFIG_SCOPE, backupKey, undefined, configText)) {
    throw new Error('Credential migration backup already exists; no changes made');
  }
  const writtenCredentials = await writeConfigDocument(documentStore, CREDENTIALS_KEY, credentials, credentialsText, nextCredentials);
  try {
    await writeConfigDocument(documentStore, configKey, config, configText, separated.config);
  } catch (error) {
    if (writtenCredentials !== undefined) {
      let observed;
      try {
        observed = await readConfigDocumentSnapshot(documentStore, configKey);
      } catch (inspectionError) {
        throw new Error2(ErrorCodes.CONFIG_PERSIST_BLOCKED, `Credential migration failed; config cannot be inspected, credentials retained. Inspect backup ${backupKey}`, { cause: inspectionError });
      }
      if (!hasAllCredentialPaths(splitConfigCredentials(observed.data).credentials, separated.credentials)) {
        throw new Error2(ErrorCodes.CONFIG_PERSIST_BLOCKED, `Credential migration failed; config changed and credentials retained. Inspect backup ${backupKey}`, { cause: error });
      }
      try {
        if (!await documentStore.compareAndSetText(CONFIG_SCOPE, CREDENTIALS_KEY, writtenCredentials, credentialsText)) {
          throw new Error('Credential migration rollback conflicted with another writer', { cause: error });
        }
      } catch (rollbackError) {
        throw new Error2(ErrorCodes.CONFIG_PERSIST_BLOCKED, `Credential migration failed; rollback could not complete. Inspect backup ${backupKey}`, { cause: rollbackError });
      }
    }
    throw error;
  }
  log.info('Moved config credentials into credentials.toml', { backup: backupKey });
}

function readMigrationMarkers(homeDir: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(homeDir, MIGRATIONS_FILE), 'utf-8'));
    if (isPlainObject(parsed)) return parsed as Record<string, string>;
  } catch {
  }
  return {};
}

function writeMigrationMarker(homeDir: string, key: string): void {
  try {
    mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    const markers = readMigrationMarkers(homeDir);
    markers[key] = new Date().toISOString();
    writeFileSync(join(homeDir, MIGRATIONS_FILE), `${JSON.stringify(markers, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch {
  }
}

export async function migrateThinkingEffortMaxToHigh(
  documentStore: IAtomicTomlDocumentStore,
  configKey: string,
  homeDir: string,
  propagateWriteErrors = false,
): Promise<void> {
  try {
    if (readMigrationMarkers(homeDir)[THINKING_EFFORT_MAX_TO_HIGH] !== undefined) return;
    let snapshot;
    try {
      snapshot = await readConfigDocumentSnapshot(documentStore, configKey);
    } catch {
      return;
    }
    const thinking = snapshot.data['thinking'];
    if (isPlainObject(thinking) && thinking['effort'] === 'max') {
      if (snapshot.text === undefined) return;
      const migrated = replaceThinkingEffortMax(snapshot.text);
      if (migrated === undefined || migrated === snapshot.text) return;
      if (!await documentStore.compareAndSetText(CONFIG_SCOPE, configKey, snapshot.text, migrated)) return;
    }
    writeMigrationMarker(homeDir, THINKING_EFFORT_MAX_TO_HIGH);
  } catch (error) {
    if (propagateWriteErrors) throw error;
  }
}
