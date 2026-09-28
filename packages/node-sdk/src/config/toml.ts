import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'pathe';
import { readConfigDocumentSnapshot, writeConfigDocument } from '@kiki/agent-core-v2/app/config/configDocument';
import { CREDENTIALS_KEY, migrateCredentialsDirectory } from '@kiki/agent-core-v2/app/config/migrations';
import { FileStorageService } from '@kiki/agent-core-v2/persistence/backends/node-fs/fileStorageService';
import { TomlAtomicDocumentStore } from '@kiki/agent-core-v2/persistence/backends/node-fs/atomicDocumentStore';

import { ErrorCodes, KimiError } from '../errors';
import { credentialsPathFor, mergeConfigCredentials, splitConfigCredentials } from './credentials';
import { applyEnvModelConfig, stripEnvModelConfig } from './env-model';
import {
  KimiConfigSchema,
  formatConfigValidationError,
  getDefaultConfig,
  type BackgroundConfig,
  type ExperimentalConfig,
  type HookDefConfig,
  type ImageConfig,
  type KimiConfig,
  type LoopControl,
  type McpConfig,
  type ModelAlias,
  type NbSearchConfig,
  type OAuthRef,
  type PermissionConfig,
  type ProviderConfig,
  type SubagentConfig,
  type ThinkingConfig,
  validateConfig,
} from './schema';
import { parse as parseToml, TomlError } from 'smol-toml';

/* ------------------------------------------------------------------ */
/*  Key helpers – reuse generic snake / camel conversion instead of    */
/*  maintaining per-section *_KEY_MAP tables.                         */
/* ------------------------------------------------------------------ */

function snakeToCamel(str: string): string {
  return str.replaceAll(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function camelToSnake(str: string): string {
  return str.replaceAll(/[A-Z]/g, (ch: string) => `_${ch.toLowerCase()}`);
}

/* ------------------------------------------------------------------ */
/*  Read / parse                                                       */
/* ------------------------------------------------------------------ */

const DEFAULT_CONFIG_FILE_TEXT = `# ~/.kiki/config.toml
# Runtime settings for Kiki.
# This file starts empty so built-in defaults can apply.
# Login will populate managed Kimi provider and model entries.
`;

const DEFAULT_CREDENTIALS_FILE_TEXT = `# ~/.kiki/credentials/credentials.toml
# Provider credentials for Kiki, keyed by provider name.
# Kept out of config.toml; a value here overrides config.toml.
`;

/** Create config.toml and its restricted credentials document when missing. */
export async function ensureConfigFile(filePath: string): Promise<void> {
  await withConfigWrite(filePath, async (store, key) => {
    if (await store.getText('', key, { recoverMissing: false }) === undefined) await store.setText('', key, DEFAULT_CONFIG_FILE_TEXT);
    if (await store.getText('', CREDENTIALS_KEY, { recoverMissing: false }) === undefined) {
      await store.setText('', CREDENTIALS_KEY, DEFAULT_CREDENTIALS_FILE_TEXT);
    }
  });
}

/**
 * Read the effective config: `config.toml` overlaid with `credentials.toml`
 * (the credentials file wins on a shared TOML path). Secrets are never taken
 * from `config.toml` over a value already in `credentials.toml`.
 */
export function readConfigFile(filePath: string): KimiConfig {
  const merged = readMergedConfigData(filePath);
  if (merged === undefined || Object.keys(merged).length === 0) {
    return getDefaultConfig();
  }
  return parseConfigData(merged, filePath);
}

function credentialsTextFor(filePath: string): { path: string; text: string | undefined } {
  const current = credentialsPathFor(filePath);
  const legacy = join(dirname(filePath), 'credentials.toml');
  const read = (path: string): string | undefined => {
    try {
      return existsSync(path) ? readFileSync(path, 'utf-8') : undefined;
    } catch (error) {
      throw new KimiError(ErrorCodes.CONFIG_INVALID, `Failed to read ${path}: ${describeUnknownError(error)}`, { cause: error });
    }
  };
  const currentText = read(current);
  const legacyText = read(legacy);
  if (currentText !== undefined && legacyText !== undefined && currentText !== legacyText) {
    throw new KimiError(ErrorCodes.CONFIG_INVALID, 'Old and new credentials.toml differ; inspect both files before continuing.');
  }
  return currentText === undefined ? { path: legacy, text: legacyText } : { path: current, text: currentText };
}

function readMergedConfigData(filePath: string): Record<string, unknown> | undefined {
  const configData = readTomlData(filePath);
  const { path, text } = credentialsTextFor(filePath);
  const credentialsData = text === undefined ? undefined : readTomlData(path);
  if (configData === undefined && credentialsData === undefined) return undefined;
  return mergeConfigCredentials(configData ?? {}, credentialsData ?? {});
}

/** Parse one TOML file to its snake_case document; `undefined` when absent. */
function readTomlData(filePath: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    if (!existsSync(filePath)) return undefined;
    text = readFileSync(filePath, 'utf-8');
  } catch (error) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Failed to read ${filePath}: ${describeUnknownError(error)}`,
      { cause: error },
    );
  }
  if (text.trim().length === 0) return {};
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch (error) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Invalid TOML in ${filePath}: ${describeUnknownError(error)}`,
      { cause: error },
    );
  }
}

/**
 * Strict read for write paths (read-merge-write must never use a salvaged
 * config as its base, or the rewrite would drop the user's broken-but-fixable
 * sections). Re-throws validation failures with a short actionable message —
 * UIs surface it directly — instead of the raw validation details.
 */
export function readConfigFileForUpdate(filePath: string): KimiConfig {
  try {
    return readConfigFile(filePath);
  } catch (error) {
    if (error instanceof KimiError && error.code === ErrorCodes.CONFIG_INVALID) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Cannot change settings while ${filePath} is invalid — fix it first (run \`kimi doctor\` for details).`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Load the config for runtime consumption: the on-disk config plus any model
 * synthesized from `KIKI_MODEL_*` environment variables. Use this everywhere a
 * value is assigned to the live runtime config; use the raw `readConfigFile`
 * for write-back paths so the synthesized model is never persisted.
 */
export function loadRuntimeConfig(
  filePath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): KimiConfig {
  return applyEnvModelConfig(readConfigFile(filePath), env);
}

export interface RuntimeConfigLoadResult {
  readonly config: KimiConfig;
  /**
   * Problems in `config.toml` or `credentials.toml`; non-empty means parts
   * (or all) of a file were ignored. Missing credentials are optional, but a
   * malformed credentials file sets `fileError` to prevent lost keys.
   */
  readonly fileWarnings: readonly string[];
  /** Problems applying KIKI_MODEL_* env overrides; the overlay was skipped. */
  readonly envWarnings: readonly string[];
  /**
   * Set when `config.toml` is entirely unusable or `credentials.toml` is
   * unreadable or malformed. Startup fails fast rather than silently dropping
   * credentials; mid-run reloads keep the last good config.
   */
  readonly fileError?: KimiError;
}

/**
 * Lenient variant of `loadRuntimeConfig` that never throws: schema errors
 * drop only the offending sections (whole entry for `providers`/`models`,
 * whole top-level section otherwise) and a bad KIKI_MODEL_* env overlay is
 * skipped, each reported as a warning. An unusable `config.toml` or malformed
 * `credentials.toml` sets `fileError` so startup fails fast while mid-run
 * reloads retain the last good config. Write paths must keep using
 * the strict readers so a broken file is never silently rewritten.
 */
export function loadRuntimeConfigSafe(
  filePath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeConfigLoadResult {
  const fileWarnings: string[] = [];
  let fileError: KimiError | undefined;
  let config = getDefaultConfig();

  let configText: string | undefined;
  try {
    configText = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : undefined;
  } catch (error) {
    fileError = new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Failed to read ${filePath}: ${describeUnknownError(error)}`,
      { cause: error },
    );
    fileWarnings.push(`Failed to read ${filePath}: ${describeUnknownError(error)}.`);
  }

  let credentialsPath = credentialsPathFor(filePath);
  let credentialsText: string | undefined;
  try {
    ({ path: credentialsPath, text: credentialsText } = credentialsTextFor(filePath));
  } catch (error) {
    fileError ??= error instanceof KimiError ? error : new KimiError(ErrorCodes.CONFIG_INVALID, describeUnknownError(error), { cause: error });
    fileWarnings.push(fileError.message);
  }

  let data: Record<string, unknown> | undefined;
  if (configText !== undefined && configText.trim().length > 0) {
    try {
      data = parseToml(configText) as Record<string, unknown>;
    } catch (error) {
      // Same message as the strict parser, code frame included, so failing
      // startup points straight at the offending line.
      fileError = new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Invalid TOML in ${filePath}: ${describeUnknownError(error)}`,
        { cause: error },
      );
      fileWarnings.push(`Invalid TOML in ${filePath}: ${describeTomlSyntaxError(error)}.`);
    }
  }

  let credentialsData: Record<string, unknown> | undefined;
  if (credentialsText !== undefined && credentialsText.trim().length > 0) {
    try {
      credentialsData = parseToml(credentialsText) as Record<string, unknown>;
    } catch (error) {
      fileError ??= new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Invalid TOML in ${credentialsPath}: ${describeUnknownError(error)}`,
        { cause: error },
      );
      fileWarnings.push(`Invalid TOML in ${credentialsPath}: ${describeTomlSyntaxError(error)}.`);
    }
  }

  const merged = data === undefined && credentialsData === undefined
    ? undefined
    : mergeConfigCredentials(data ?? {}, credentialsData ?? {});
  if (merged !== undefined) {
    const raw = cloneRecord(merged);
    const transformed = transformTomlData(merged);
    transformed['raw'] = raw;
    const salvaged = salvageConfigData(transformed);
    if (salvaged.config === undefined) {
      fileError = new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Invalid configuration in ${filePath}: ${formatConfigValidationError(salvaged.error)}`,
        { cause: salvaged.error },
      );
      fileWarnings.push(
        `Invalid configuration in ${filePath}: ${formatConfigValidationError(salvaged.error)}.`,
      );
    } else {
      config = salvaged.config;
      if (salvaged.dropped.length > 0) {
        fileWarnings.push(
          `Ignored invalid config in ${filePath}: ${salvaged.dropped.join(', ')}. Run \`kimi doctor\` for details.`,
        );
      }
    }
  }

  const envWarnings: string[] = [];
  try {
    config = applyEnvModelConfig(config, env);
  } catch (error) {
    envWarnings.push(
      `Ignoring KIKI_MODEL_* environment overrides: ${describeUnknownError(error)}`,
    );
  }

  return { config, fileWarnings, envWarnings, fileError };
}

/** Sections keyed by user-chosen names where single entries can be dropped. */
const ENTRY_KEYED_SECTIONS = new Set(['providers', 'models']);

interface SalvageResult {
  readonly config: KimiConfig | undefined;
  readonly dropped: readonly string[];
  readonly error?: unknown;
}

function salvageConfigData(transformed: Record<string, unknown>): SalvageResult {
  const dropped: string[] = [];
  for (;;) {
    const result = KimiConfigSchema.safeParse(transformed);
    if (result.success) {
      return { config: result.data, dropped };
    }
    let deletedAny = false;
    for (const issue of result.error.issues) {
      const [section, entry] = issue.path;
      if (typeof section !== 'string' || !(section in transformed)) continue;
      const sectionValue = transformed[section];
      if (
        ENTRY_KEYED_SECTIONS.has(section) &&
        typeof entry === 'string' &&
        isPlainObject(sectionValue)
      ) {
        // Issues on entry-keyed sections only ever drop that entry. An entry
        // with several issues is deleted by the first one; later issues are
        // no-ops and must not escalate to deleting the whole section.
        if (entry in sectionValue) {
          delete sectionValue[entry];
          dropped.push(`${camelToSnake(section)}.${entry}`);
          deletedAny = true;
        }
        continue;
      }
      delete transformed[section];
      dropped.push(camelToSnake(section));
      deletedAny = true;
    }
    if (!deletedAny) {
      return { config: undefined, dropped, error: result.error };
    }
  }
}

function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One-line summary of a smol-toml parse error: first message line plus the
 * line/column location, without the multi-line code-frame block.
 */
function describeTomlSyntaxError(error: unknown): string {
  const firstLine = describeUnknownError(error).split('\n', 1)[0] ?? '';
  if (error instanceof TomlError) {
    return `${firstLine} (line ${error.line}, column ${error.column})`;
  }
  return firstLine;
}

export function parseConfigString(tomlText: string, filePath = 'config.toml'): KimiConfig {
  if (tomlText.trim().length === 0) {
    return getDefaultConfig();
  }

  let data: Record<string, unknown>;
  try {
    data = parseToml(tomlText) as Record<string, unknown>;
  } catch (error) {
    throw new KimiError(ErrorCodes.CONFIG_INVALID, `Invalid TOML in ${filePath}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }

  return parseConfigData(data, filePath);
}

function parseConfigData(data: Record<string, unknown>, filePath: string): KimiConfig {
  const raw = cloneRecord(data);
  const transformed = transformTomlData(data);
  transformed['raw'] = raw;

  try {
    return KimiConfigSchema.parse(transformed);
  } catch (error) {
    throw new KimiError(ErrorCodes.CONFIG_INVALID, `Invalid configuration in ${filePath}: ${formatConfigValidationError(error)}`, {
      cause: error,
    });
  }
}

export function transformTomlData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);

    if (targetKey === 'providers' && isPlainObject(value)) {
      result[targetKey] = transformRecord(value, transformProviderData);
    } else if (targetKey === 'models' && isPlainObject(value)) {
      result[targetKey] = transformRecord(value, transformModelData);
    } else if (targetKey === 'thinking' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'permission' && isPlainObject(value)) {
      result[targetKey] = transformPermissionData(value);
    } else if ((targetKey === 'nbSearch' || targetKey === 'nbSearchSource') && isPlainObject(value)) {
      result[targetKey] = cloneRecord(value);
    } else if (targetKey === 'loopControl' && isPlainObject(value)) {
      result[targetKey] = transformLoopControlData(value);
    } else if (targetKey === 'background' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'image' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'experimental' && isPlainObject(value)) {
      result[targetKey] = cloneRecord(value);
    } else if ((targetKey === 'subagent' || targetKey === 'agents') && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'mcp' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (!isPlainObject(value)) {
      result[targetKey] = value;
    }
  }
  return result;
}

function transformRecord(
  value: Record<string, unknown>,
  transformEntry: (entry: Record<string, unknown>) => Record<string, unknown>,
  transformName: (name: string) => string = (name) => name,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [entryName, entryConfig] of Object.entries(value)) {
    record[transformName(entryName)] = isPlainObject(entryConfig)
      ? transformEntry(entryConfig)
      : entryConfig;
  }
  return record;
}

function transformPlainObject(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[snakeToCamel(key)] = value;
  }
  return out;
}

function transformProviderData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'oauth') {
      out[targetKey] = isPlainObject(value) ? transformPlainObject(value) : value;
    } else if (targetKey === 'env' || targetKey === 'customHeaders') {
      out[targetKey] = cloneObjectValue(value);
    } else {
      out[targetKey] = value;
    }
  }
  return out;
}

function transformModelData(data: Record<string, unknown>): Record<string, unknown> {
  const out = transformPlainObject(data);
  if (isPlainObject(out['overrides'])) {
    out['overrides'] = transformPlainObject(out['overrides']);
  }
  if (isPlainObject(out['cognition'])) {
    out['cognition'] = transformPlainObject(out['cognition']);
  }
  return out;
}

function transformPermissionData(data: Record<string, unknown>): Record<string, unknown> {
  const raw = transformPlainObject(data);
  const out: Record<string, unknown> = {};

  const rules: unknown[] = [];
  appendPermissionRules(rules, raw['rules']);
  appendPermissionRules(rules, raw['deny'], 'deny');
  appendPermissionRules(rules, raw['allow'], 'allow');
  appendPermissionRules(rules, raw['ask'], 'ask');
  if (rules.length > 0) {
    out['rules'] = rules;
  }
  if (raw['dangerousBash'] !== undefined) {
    out['dangerousBash'] = raw['dangerousBash'];
  }
  return out;
}

function appendPermissionRules(
  target: unknown[],
  value: unknown,
  decision?: 'allow' | 'deny' | 'ask',
): void {
  if (value === undefined) return;
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    target.push(transformPermissionRule(entry, decision));
  }
}

function transformPermissionRule(value: unknown, decision?: 'allow' | 'deny' | 'ask'): unknown {
  if (!isPlainObject(value)) return value;

  const rule = transformPlainObject(value);
  const tool = rule['tool'];
  const match = rule['match'];
  const pattern = rule['pattern'];
  const out: Record<string, unknown> = {};

  if (decision !== undefined) {
    out['decision'] = decision;
  } else {
    out['decision'] = rule['decision'];
  }
  out['scope'] = rule['scope'];
  out['reason'] = rule['reason'];

  if (typeof tool === 'string') {
    const argPattern = typeof match === 'string' ? match : pattern;
    out['pattern'] = typeof argPattern === 'string' ? `${tool}(${argPattern})` : tool;
  } else {
    out['pattern'] = pattern;
  }

  return out;
}

function transformLoopControlData(data: Record<string, unknown>): Record<string, unknown> {
  const out = transformPlainObject(data);
  if (out['maxStepsPerTurn'] === undefined && out['maxStepsPerRun'] !== undefined) {
    out['maxStepsPerTurn'] = out['maxStepsPerRun'];
  }
  delete out['maxStepsPerRun'];
  return out;
}

/* ------------------------------------------------------------------ */
/*  Write / stringify                                                  */
/* ------------------------------------------------------------------ */

export interface ConfigWriteSnapshot {
  readonly configText: string | undefined;
  readonly credentialsText: string | undefined;
  readonly loaded?: KimiConfig;
}

export function readConfigWriteSnapshot(filePath: string): ConfigWriteSnapshot {
  const read = (name: string) => existsSync(name) ? readFileSync(name, 'utf-8') : undefined;
  return { configText: read(filePath), credentialsText: credentialsTextFor(filePath).text };
}

export async function writeConfigFile(filePath: string, config: KimiConfig, expected?: ConfigWriteSnapshot): Promise<void> {
  const validated = validateConfig(stripEnvModelConfig(config));
  const separated = splitConfigCredentials(configToTomlData(validated));
  await withConfigWrite(filePath, async (store, key) => {
    const before = await readConfigDocumentSnapshot(store, key, { recoverMissing: false });
    const credentials = await readConfigDocumentSnapshot(store, CREDENTIALS_KEY, { recoverMissing: false });
    if (expected !== undefined && (before.text !== expected.configText || credentials.text !== expected.credentialsText)) {
      throw new KimiError(ErrorCodes.CONFIG_INVALID, 'Configuration changed during login; retry without overwriting other changes.');
    }
    let nextConfig = separated.config;
    let nextCredentials = { ...separated.credentials };
    if (expected?.loaded !== undefined) {
      const originalData = configToTomlData(validateConfig(stripEnvModelConfig(expected.loaded)));
      const nextData = configToTomlData(validated);
      const changed = new Set([...Object.keys(originalData), ...Object.keys(nextData)]
        .filter((domain) => JSON.stringify(originalData[domain]) !== JSON.stringify(nextData[domain])));
      nextConfig = { ...before.data };
      nextCredentials = { ...credentials.data };
      for (const domain of changed) {
        if (separated.config[domain] === undefined) delete nextConfig[domain];
        else nextConfig[domain] = separated.config[domain];
        if (separated.credentials[domain] === undefined) delete nextCredentials[domain];
        else nextCredentials[domain] = separated.credentials[domain];
      }
    }
    const writtenCredentials = await writeConfigDocument(store, CREDENTIALS_KEY, credentials.data, credentials.text, nextCredentials);
    try {
      await writeConfigDocument(store, key, before.data, before.text, nextConfig);
    } catch (error) {
      if (writtenCredentials !== undefined && await store.getText('', key, { recoverMissing: false }) === before.text) {
        await store.compareAndSetText('', CREDENTIALS_KEY, writtenCredentials, credentials.text);
      }
      throw error;
    }
  });
}

export async function withConfigWrite<T>(
  filePath: string,
  operation: (store: import('@kiki/agent-core-v2/persistence/interface/atomicDocumentStore').IAtomicTomlDocumentStore, key: string) => Promise<T>,
): Promise<T> {
  const storage = new FileStorageService(dirname(filePath), 0o700, 0o600, false);
  const store = new TomlAtomicDocumentStore(storage);
  await migrateCredentialsDirectory(store);
  return operation(store, basename(filePath));
}

export function configToTomlData(config: KimiConfig): Record<string, unknown> {
  const out = cloneRecord(config.raw);

  // Strip deprecated fields
  delete out['default_yolo'];
  delete out['defaultYolo'];
  delete out['defaultPermissionMode'];
  delete out['default_thinking'];
  delete out['defaultThinking'];
  delete out['services'];

  // Top-level scalar fields
  const scalarFields: (keyof KimiConfig)[] = [
    'defaultProvider',
    'defaultModel',
    'planMode',
    'yolo',
    'defaultPermissionMode',
    'defaultPlanMode',
    'mergeAllAvailableSkills',
    'extraSkillDirs',
    'extraAgentDirs',
  ];
  for (const key of scalarFields) {
    setDefined(out, camelToSnake(key), config[key]);
  }

  setRecordSection(out, 'providers', config.providers, providerToToml);
  setRecordSection(out, 'models', config.models, modelToToml);
  setSection(out, 'thinking', config.thinking, thinkingToToml);
  setSection(out, 'nb_search', config.nbSearch, nbSearchToToml);
  setSection(out, 'nb_search_source', config.nbSearchSource, (source) => ({ ...source }));
  setSection(out, 'loop_control', config.loopControl, loopControlToToml);
  setSection(out, 'background', config.background, backgroundToToml);
  setSection(out, 'subagent', config.subagent, subagentToToml);
  setSection(out, 'agents', config.agents, plainSectionToToml);
  setSection(out, 'mcp', config.mcp, mcpToToml);
  setSection(out, 'image', config.image, imageToToml);
  setSection(out, 'experimental', config.experimental, experimentalToToml);
  setSection(out, 'permission', config.permission, permissionToToml);
  setHooks(out, config.hooks);

  return out;
}

function setRecordSection<T>(
  out: Record<string, unknown>,
  snakeKey: string,
  value: Record<string, T> | undefined,
  toToml: (v: T, raw: unknown) => Record<string, unknown>,
): void {
  if (value === undefined) {
    delete out[snakeKey];
    return;
  }

  const rawSub = cloneRecord(out[snakeKey]);
  const converted: Record<string, unknown> = {};
  for (const [entryName, entryConfig] of Object.entries(value)) {
    converted[entryName] = toToml(entryConfig, rawSub[entryName]);
  }

  if (Object.keys(converted).length > 0) {
    out[snakeKey] = converted;
  } else {
    delete out[snakeKey];
  }
}

function setSection<T>(
  out: Record<string, unknown>,
  snakeKey: string,
  value: T | undefined,
  toToml: (v: T, raw: unknown) => Record<string, unknown>,
): void {
  if (value === undefined) {
    delete out[snakeKey];
    return;
  }
  const rawSub = cloneRecord(out[snakeKey]);
  const converted = toToml(value, rawSub);
  if (Object.keys(converted).length > 0) {
    out[snakeKey] = converted;
  } else {
    delete out[snakeKey];
  }
}

function providerToToml(provider: ProviderConfig, rawProvider: unknown): Record<string, unknown> {
  const out = cloneRecord(rawProvider);
  for (const [key, value] of Object.entries(provider)) {
    if (key === 'oauth' && value !== undefined) {
      out[camelToSnake(key)] = oauthToToml(value as OAuthRef);
    } else if ((key === 'env' || key === 'customHeaders') && value !== undefined) {
      out[camelToSnake(key)] = cloneUnknown(value);
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

function modelToToml(model: ModelAlias, rawModel: unknown): Record<string, unknown> {
  const out = cloneRecord(rawModel);
  for (const [key, value] of Object.entries(model)) {
    if (key === 'capabilities' && Array.isArray(value)) {
      out[camelToSnake(key)] = [...value];
    } else if (key === 'overrides' && isPlainObject(value)) {
      const rawOverrides = isPlainObject(rawModel) ? rawModel['overrides'] : undefined;
      out['overrides'] = modelOverridesToToml(value, rawOverrides);
    } else if (key === 'cognition' && isPlainObject(value)) {
      out['cognition'] = Object.fromEntries(Object.entries(value).map(([field, item]) => [camelToSnake(field), item]));
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

function modelOverridesToToml(
  overrides: Record<string, unknown>,
  rawOverrides: unknown,
): Record<string, unknown> {
  const out = cloneRecord(rawOverrides);
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'capabilities' && Array.isArray(value)) {
      out[camelToSnake(key)] = [...value];
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

function thinkingToToml(thinking: ThinkingConfig, rawThinking: unknown): Record<string, unknown> {
  const out = cloneRecord(rawThinking);
  delete out['mode'];
  for (const [key, value] of Object.entries(thinking)) {
    setDefined(out, camelToSnake(key), value);
  }
  return out;
}

function permissionToToml(
  permission: PermissionConfig,
  rawPermission: unknown,
): Record<string, unknown> {
  const out = cloneRecord(rawPermission);
  delete out['deny'];
  delete out['allow'];
  delete out['ask'];

  if (permission.rules !== undefined) {
    out['rules'] = permission.rules.map(permissionRuleToToml);
  } else {
    delete out['rules'];
  }
  setDefined(out, 'dangerous_bash', permission.dangerousBash);
  return out;
}

function permissionRuleToToml(
  rule: NonNullable<PermissionConfig['rules']>[number],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rule)) {
    setDefined(out, camelToSnake(key), value);
  }
  return out;
}

function nbSearchToToml(config: NbSearchConfig): Record<string, unknown> {
  return cloneRecord(config);
}

function loopControlToToml(
  loopControl: LoopControl,
  rawLoopControl: unknown,
): Record<string, unknown> {
  const out = cloneRecord(rawLoopControl);
  for (const [key, value] of Object.entries(loopControl)) {
    setDefined(out, camelToSnake(key), value);
  }
  return out;
}

function backgroundToToml(
  background: BackgroundConfig,
  rawBackground: unknown,
): Record<string, unknown> {
  const out = cloneRecord(rawBackground);
  for (const [key, value] of Object.entries(background)) {
    setDefined(out, camelToSnake(key), value);
  }
  return out;
}

function subagentToToml(subagent: SubagentConfig, rawSubagent: unknown): Record<string, unknown> {
  const out = cloneRecord(rawSubagent);
  for (const [key, value] of Object.entries(subagent)) {
    setDefined(out, camelToSnake(key), value);
  }
  return out;
}

function plainSectionToToml<T extends object>(
  section: T,
  rawSection: unknown,
): Record<string, unknown> {
  const out = cloneRecord(rawSection);
  for (const [key, value] of Object.entries(section)) {
    setDefined(out, camelToSnake(key), value);
  }
  return out;
}

function mcpToToml(mcp: McpConfig, rawMcp: unknown): Record<string, unknown> {
  const out = cloneRecord(rawMcp);
  for (const [key, value] of Object.entries(mcp)) {
    setDefined(out, camelToSnake(key), value);
  }
  return out;
}

function imageToToml(image: ImageConfig, rawImage: unknown): Record<string, unknown> {
  const out = cloneRecord(rawImage);
  for (const [key, value] of Object.entries(image)) {
    setDefined(out, camelToSnake(key), value);
  }
  return out;
}

function experimentalToToml(
  experimental: ExperimentalConfig,
  _rawExperimental: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(experimental)) {
    setDefined(out, key, value);
  }
  return out;
}

function setHooks(out: Record<string, unknown>, hooks: readonly HookDefConfig[] | undefined): void {
  if (hooks === undefined) {
    delete out['hooks'];
    return;
  }
  out['hooks'] = hooks.map(hookToToml);
}

function hookToToml(hook: HookDefConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(hook)) {
    setDefined(out, camelToSnake(key), value);
  }
  return out;
}

function oauthToToml(oauth: OAuthRef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(oauth)) {
    setDefined(out, camelToSnake(key), value);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Utilities                                                          */
/* ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  return cloneUnknown(value);
}

function cloneUnknown<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneObjectValue(value: unknown): unknown {
  return isPlainObject(value) ? cloneUnknown(value) : value;
}

function setDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  } else {
    delete target[key];
  }
}
