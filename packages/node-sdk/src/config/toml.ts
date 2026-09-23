import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import { dirname } from 'pathe';

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
import { atomicWrite } from '../internal/fs';
import { parse as parseToml, stringify as stringifyToml, TomlError } from 'smol-toml';

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

const DEFAULT_CREDENTIALS_FILE_TEXT = `# ~/.kiki/credentials.toml
# Provider credentials for Kiki, keyed by provider name.
# Kept out of config.toml; a value here overrides config.toml.
`;

/**
 * Create `config.toml` and its companion `credentials.toml` when missing. Both
 * are owner-only (`0600`); the credentials file is scaffolded empty so the
 * write path never has to create it with the process umask.
 */
export async function ensureConfigFile(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await createFileIfMissing(filePath, DEFAULT_CONFIG_FILE_TEXT);
  await createFileIfMissing(credentialsPathFor(filePath), DEFAULT_CREDENTIALS_FILE_TEXT);
}

async function createFileIfMissing(filePath: string, text: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, 'wx', 0o600);
    await handle.writeFile(text, 'utf-8');
  } catch (error) {
    if (isFileExistsError(error)) return;
    throw error;
  } finally {
    await handle?.close();
  }
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

function readMergedConfigData(filePath: string): Record<string, unknown> | undefined {
  const configData = readTomlData(filePath);
  const credentialsData = readTomlData(credentialsPathFor(filePath));
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

  const credentialsPath = credentialsPathFor(filePath);
  let credentialsText: string | undefined;
  try {
    credentialsText = existsSync(credentialsPath) ? readFileSync(credentialsPath, 'utf-8') : undefined;
  } catch (error) {
    fileError ??= new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Failed to read ${credentialsPath}: ${describeUnknownError(error)}`,
      { cause: error },
    );
    fileWarnings.push(`Failed to read ${credentialsPath}: ${describeUnknownError(error)}.`);
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

export async function writeConfigFile(filePath: string, config: KimiConfig): Promise<void> {
  // Final guard: never persist the env-synthesized model/provider to disk,
  // even if a caller passes back the runtime config as a patch (see
  // stripEnvModelConfig / the getConfig -> setConfig round-trip).
  const validated = validateConfig(stripEnvModelConfig(config));
  await writeConfigData(filePath, configToTomlData(validated));
}

/**
 * Persist one TOML document across the two files: secrets go to
 * `credentials.toml` (owner-only), everything else to `config.toml`, which
 * therefore never carries a credential. `config.toml` remains the full-state
 * document — a secret absent from `data` is removed from `credentials.toml`
 * too, mirroring a normal config rewrite.
 *
 * The credentials file is written first: a crash between the two writes can
 * then only leave a secret duplicated in `config.toml`, never dropped.
 */
async function writeConfigData(filePath: string, data: Record<string, unknown>): Promise<void> {
  const separated = splitConfigCredentials(data);
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeCredentialsData(filePath, separated.credentials);
  await atomicWrite(filePath, `${stringifyToml(separated.config)}\n`);
}

async function writeCredentialsData(
  configPath: string,
  credentials: Record<string, unknown>,
): Promise<void> {
  const credentialsPath = credentialsPathFor(configPath);
  // Nothing to store and no file to clear: skip rather than create an empty
  // companion for a secret-free config.
  if (Object.keys(credentials).length === 0 && !existsSync(credentialsPath)) return;
  await atomicWrite(credentialsPath, `${stringifyToml(credentials)}\n`, undefined, 0o600);
  // Re-apply the mode after replacement on platforms that support it.
  try {
    await chmod(credentialsPath, 0o600);
  } catch {
    // Best-effort: platforms without POSIX modes (Windows) keep the write.
  }
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

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}
