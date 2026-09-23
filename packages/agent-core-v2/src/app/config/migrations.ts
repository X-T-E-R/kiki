import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'pathe';

import { type IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { type ILogService } from '#/_base/log/log';

import { writeConfigDocument } from './configDocument';
import { mergeConfigCredentials, splitConfigCredentials } from './credentials';
import { deepEqual, isPlainObject } from './configPure';
import { replaceThinkingEffortMax } from './tomlWriteback';

const MIGRATIONS_FILE = 'migrations-effort.json';
const THINKING_EFFORT_MAX_TO_HIGH = 'thinking-effort-max-to-high';
const CONFIG_SCOPE = '';
export const CREDENTIALS_KEY = 'credentials.toml';

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
    const configData = await documentStore.get<Record<string, unknown>>(CONFIG_SCOPE, configKey);
    config = isPlainObject(configData) ? configData : {};
    const credentialsData = await documentStore.get<Record<string, unknown>>(CONFIG_SCOPE, CREDENTIALS_KEY);
    credentials = isPlainObject(credentialsData) ? credentialsData : {};
    configText = await documentStore.getText(CONFIG_SCOPE, configKey);
    credentialsText = await documentStore.getText(CONFIG_SCOPE, CREDENTIALS_KEY);
  } catch {
    return;
  }
  const separated = splitConfigCredentials(config);
  if (deepEqual(separated.config, config)) return;
  if (configText === undefined) return;
  const merged = mergeConfigCredentials(config, credentials);
  const nextCredentials = splitConfigCredentials(merged).credentials;
  const backupKey = `${configKey}.bak-${new Date().toISOString().slice(0, 10)}`;
  if (await documentStore.getText(CONFIG_SCOPE, backupKey) === undefined) {
    await documentStore.setText(CONFIG_SCOPE, backupKey, configText);
  }
  await writeConfigDocument(documentStore, CREDENTIALS_KEY, credentials, credentialsText, nextCredentials);
  await writeConfigDocument(documentStore, configKey, config, configText, separated.config);
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
): Promise<void> {
  try {
    if (readMigrationMarkers(homeDir)[THINKING_EFFORT_MAX_TO_HIGH] !== undefined) return;
    let doc: Record<string, unknown> | undefined;
    let text: string | undefined;
    try {
      text = await documentStore.getText(CONFIG_SCOPE, configKey);
      const data = await documentStore.get<Record<string, unknown>>(CONFIG_SCOPE, configKey);
      doc = data !== undefined && isPlainObject(data) ? data : {};
    } catch {
      return;
    }
    const thinking = doc['thinking'];
    if (isPlainObject(thinking) && thinking['effort'] === 'max') {
      const migrated = text === undefined ? undefined : replaceThinkingEffortMax(text);
      if (migrated === undefined) {
        doc['thinking'] = { ...thinking, effort: 'high' };
        await documentStore.set(CONFIG_SCOPE, configKey, doc);
      } else if (migrated !== text) {
        await documentStore.setText(CONFIG_SCOPE, configKey, migrated);
      }
    }
    writeMigrationMarker(homeDir, THINKING_EFFORT_MAX_TO_HIGH);
  } catch {
  }
}
