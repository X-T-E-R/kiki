import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import type { ModelRecord } from '@kiki/agent-core-v2/kosong/model/model';
import { resolveModelId } from '@kiki/agent-core-v2/kosong/model/resolveModelId';
import {
  createKimiConfigRpc,
  type KimiConfigRpc,
  type KimiConfigValidationIssue,
} from '@kiki/node-sdk';
import type { Command } from 'commander';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

import { getTuiConfigPath, parseTuiConfig } from '#/tui/config';
import { getDataDir } from '#/utils/paths';

interface WritableLike {
  write(chunk: string): boolean;
}

type MaybePromise<T> = T | Promise<T>;

type AgentCoreModule = typeof import('@kiki/agent-core-v2');
type AgentRootsModule = typeof import(
  '@kiki/agent-core-v2/workspace/workspaceAgentProfileLoader/internal/agentRoots'
);
type AgentPathsModule = typeof import(
  '@kiki/agent-core-v2/workspace/workspaceAgentProfileLoader/internal/paths'
);
type ShippedAgentProfilesModule = typeof import(
  '@kiki/agent-core-v2/app/shippedAgentProfiles/shippedAgentProfiles'
);

interface DoctorAgentModules {
  readonly core: AgentCoreModule;
  readonly agentRoots: AgentRootsModule;
  readonly agentPaths: AgentPathsModule;
  readonly shippedAgentProfiles: ShippedAgentProfilesModule;
}

async function loadAgentProfileModules(): Promise<DoctorAgentModules> {
  const [core, agentRoots, agentPaths, shippedAgentProfiles] = await Promise.all([
    import('@kiki/agent-core-v2'),
    import('@kiki/agent-core-v2/workspace/workspaceAgentProfileLoader/internal/agentRoots'),
    import('@kiki/agent-core-v2/workspace/workspaceAgentProfileLoader/internal/paths'),
    import('@kiki/agent-core-v2/app/shippedAgentProfiles/shippedAgentProfiles'),
  ]);
  return { core, agentRoots, agentPaths, shippedAgentProfiles };
}

export interface DoctorDeps {
  readonly cwd: () => string;
  readonly defaultConfigPath: () => MaybePromise<string>;
  readonly defaultTuiConfigPath: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
  readonly configRpc?: KimiConfigRpc;
  readonly fileExists?: (path: string) => boolean;
  readonly readTextFile?: (path: string) => Promise<string>;
  readonly validateConfigToml?: (text: string, path: string) => MaybePromise<string | void>;
  readonly kimiHomeDir?: () => string;
  readonly osHomeDir?: () => string;
  readonly getEnv?: (name: string) => string | undefined;
  readonly loadAgentProfileModules?: () => Promise<DoctorAgentModules>;
}

export interface DoctorOptions {
  readonly target?: 'config' | 'tui';
  readonly path?: string;
}

interface DoctorConfigContext {
  models: Readonly<Record<string, ModelRecord>>;
  extraAgentDirs: readonly string[];
}

interface CheckSpec {
  readonly label: 'config.toml' | 'tui.toml';
  readonly path: string;
  readonly explicit: boolean;
  /** Throws on invalid content; may return a non-fatal warning message. */
  readonly parse: (text: string, path: string) => MaybePromise<string | void>;
}

interface CheckResult {
  readonly label: CheckSpec['label'] | 'agents';
  readonly path: string;
  readonly status: 'OK' | 'SKIP' | 'WARN' | 'ERROR';
  readonly message?: string;
}

interface ResolvedDoctorDeps {
  readonly cwd: () => string;
  readonly defaultConfigPath: () => MaybePromise<string>;
  readonly defaultTuiConfigPath: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
  readonly fileExists: (path: string) => boolean;
  readonly readTextFile: (path: string) => Promise<string>;
  readonly validateConfigToml: (text: string, path: string) => MaybePromise<string | void>;
  readonly kimiHomeDir: () => string;
  readonly osHomeDir: () => string;
  readonly getEnv: (name: string) => string | undefined;
  readonly loadAgentProfileModules: () => Promise<DoctorAgentModules>;
}

export async function handleDoctor(deps: DoctorDeps, options: DoctorOptions): Promise<number> {
  const resolved = resolveDeps(deps);
  const cwd = resolved.cwd();
  const context = createDoctorConfigContext(resolved);
  const specs = await buildCheckSpecs(resolved, options, cwd, context);
  const results: CheckResult[] = [];
  for (const spec of specs) {
    results.push(await checkTomlFile(resolved, spec));
  }
  if (options.target === undefined) {
    results.push(...(await checkAgentProfiles(resolved, cwd, context)));
  }

  const issueCount = results.filter((result) => result.status === 'ERROR').length;
  const text = issueCount === 0 ? formatSuccess(results) : formatFailure(results, issueCount);
  if (issueCount === 0) {
    resolved.stdout.write(text);
  } else {
    resolved.stderr.write(text);
  }
  return issueCount === 0 ? 0 : 1;
}

export function registerDoctorCommand(parent: Command, deps?: Partial<DoctorDeps>): void {
  const doctor = parent
    .command('doctor')
    .description('Validate Kimi Code configuration files and agent profiles.')
    .action(async () => {
      await runDoctorCommand(deps, {});
    });

  doctor
    .command('config')
    .description('Validate config.toml.')
    .argument('[path]', 'Validate this file as config.toml instead of the default path.')
    .action(async (path: string | undefined) => {
      await runDoctorCommand(deps, { target: 'config', path });
    });

  doctor
    .command('tui')
    .description('Validate tui.toml.')
    .argument('[path]', 'Validate this file as tui.toml instead of the default path.')
    .action(async (path: string | undefined) => {
      await runDoctorCommand(deps, { target: 'tui', path });
    });
}

async function runDoctorCommand(
  deps: Partial<DoctorDeps> | undefined,
  options: DoctorOptions,
): Promise<void> {
  const resolved = resolveDeps(deps);
  const code = await handleDoctor(resolved, options);
  if (code !== 0) resolved.exit(code);
}

function resolveDeps(deps: Partial<DoctorDeps> | DoctorDeps | undefined): ResolvedDoctorDeps {
  let configRpc = deps?.configRpc;
  const getConfigRpc = (): KimiConfigRpc => {
    configRpc ??= createKimiConfigRpc();
    return configRpc;
  };

  return {
    cwd: deps?.cwd ?? (() => process.cwd()),
    defaultConfigPath: deps?.defaultConfigPath ?? (() => getConfigRpc().resolveConfigPath()),
    defaultTuiConfigPath: deps?.defaultTuiConfigPath ?? getTuiConfigPath,
    stdout: deps?.stdout ?? process.stdout,
    stderr: deps?.stderr ?? process.stderr,
    exit: deps?.exit ?? ((code) => process.exit(code)),
    fileExists: deps?.fileExists ?? existsSync,
    readTextFile: deps?.readTextFile ?? ((path) => readFile(path, 'utf-8')),
    validateConfigToml:
      deps?.validateConfigToml ??
      (async (text, filePath) => {
        // Validate with the agent-core-v2 section registry. Loaded lazily so
        // the v2 module graph stays off the doctor's cheap paths.
        const { validateConfigTomlV2 } = await import('../v2/validate-config');
        return validateConfigTomlV2(text, filePath);
      }),
    kimiHomeDir: deps?.kimiHomeDir ?? getDataDir,
    osHomeDir: deps?.osHomeDir ?? homedir,
    getEnv: deps?.getEnv ?? ((name) => process.env[name]),
    loadAgentProfileModules: deps?.loadAgentProfileModules ?? loadAgentProfileModules,
  };
}

async function buildCheckSpecs(
  deps: ResolvedDoctorDeps,
  options: DoctorOptions,
  cwd: string,
  context: DoctorConfigContext,
): Promise<CheckSpec[]> {
  if (options.target === 'config') {
    return [
      makeConfigSpec(
        await resolveConfigTargetPath(deps, options.path, cwd),
        options.path !== undefined,
        deps,
        context,
      ),
    ];
  }

  if (options.target === 'tui') {
    return [
      makeTuiSpec(
        resolveTuiTargetPath(deps, options.path, cwd),
        options.path !== undefined,
      ),
    ];
  }

  return [
    makeConfigSpec(await deps.defaultConfigPath(), false, deps, context),
    makeTuiSpec(deps.defaultTuiConfigPath(), false),
  ];
}

function makeConfigSpec(
  path: string,
  explicit: boolean,
  deps: ResolvedDoctorDeps,
  context: DoctorConfigContext,
): CheckSpec {
  return {
    label: 'config.toml',
    path,
    explicit,
    parse: async (text, filePath) => {
      updateDoctorConfigContext(context, text, deps);
      return deps.validateConfigToml(text, filePath);
    },
  };
}

function makeTuiSpec(path: string, explicit: boolean): CheckSpec {
  return {
    label: 'tui.toml',
    path,
    explicit,
    parse: (text) => {
      parseTuiConfig(text);
    },
  };
}

async function checkTomlFile(deps: ResolvedDoctorDeps, spec: CheckSpec): Promise<CheckResult> {
  if (!deps.fileExists(spec.path)) {
    return {
      label: spec.label,
      path: spec.path,
      status: spec.explicit ? 'ERROR' : 'SKIP',
      message: spec.explicit
        ? 'File does not exist.'
        : 'File does not exist; built-in defaults will apply.',
    };
  }

  try {
    const text = await deps.readTextFile(spec.path);
    const warning = await spec.parse(text, spec.path);
    return { label: spec.label, path: spec.path, status: 'OK', message: warning ?? undefined };
  } catch (error) {
    return {
      label: spec.label,
      path: spec.path,
      status: 'ERROR',
      message: formatErrorMessage(error, spec.path),
    };
  }
}

const MAX_AGENT_SCAN_DEPTH = 8;

interface ParsedAgentFile {
  readonly path: string;
  readonly name: string;
  readonly subagents?: readonly string[];
  readonly modelAlias?: string;
  readonly parserWarnings: readonly string[];
}

function createDoctorConfigContext(deps: ResolvedDoctorDeps): DoctorConfigContext {
  return {
    models: {},
    extraAgentDirs: [],
  };
}

function updateDoctorConfigContext(
  context: DoctorConfigContext,
  text: string,
  deps: ResolvedDoctorDeps,
): void {
  let data: Record<string, unknown>;
  try {
    data = parseToml(text) as Record<string, unknown>;
  } catch {
    return;
  }

  const models = data['models'];
  context.models = isRecord(models) ? modelsSectionFromToml(models) : {};

  const extraAgentDirs = data['extra_agent_dirs'];
  context.extraAgentDirs = Array.isArray(extraAgentDirs)
    ? extraAgentDirs.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '') return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

async function checkAgentProfiles(
  deps: ResolvedDoctorDeps,
  cwd: string,
  context: DoctorConfigContext,
): Promise<CheckResult[]> {
  let modules: DoctorAgentModules;
  try {
    modules = await deps.loadAgentProfileModules();
  } catch (error) {
    return [
      {
        label: 'agents',
        path: cwd,
        status: 'ERROR',
        message: `agent profile check unavailable: ${errorMessage(error)}`,
      },
    ];
  }
  const { core, agentRoots, agentPaths, shippedAgentProfiles } = modules;
  const fs = new core.HostFileSystem();
  const discoveryWarnings: string[] = [];
  const warn = (message: string): void => {
    discoveryWarnings.push(message);
  };

  let roots;
  try {
    roots = [
      ...(await agentRoots.userAgentRoots(
        fs,
        deps.kimiHomeDir(),
        deps.osHomeDir(),
        warn,
      )),
      ...(await agentRoots.projectAgentRoots(fs, cwd, warn)),
      ...(await agentRoots.configuredAgentRoots(
        fs,
        context.extraAgentDirs,
        cwd,
        deps.osHomeDir(),
        'extra',
        warn,
      )),
    ];
  } catch (error) {
    return [
      {
        label: 'agents',
        path: cwd,
        status: 'ERROR',
        message: `Unable to resolve agent profile roots: ${errorMessage(error)}`,
      },
    ];
  }

  const uniqueRoots = roots.filter(
    (root, index) => roots.findIndex((candidate) => candidate.path === root.path) === index,
  );
  const parsedFiles: ParsedAgentFile[] = [];
  const results: CheckResult[] = [];

  const walk = async (dirPath: string, source: (typeof uniqueRoots)[number]['source'], depth: number) => {
    if (depth > MAX_AGENT_SCAN_DEPTH) return;
    let entries;
    try {
      entries = (await fs.readdir(dirPath)).toSorted((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      discoveryWarnings.push(`Skipping unreadable agent directory ${dirPath}: ${errorMessage(error)}`);
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const entryPath = `${dirPath.replace(/[\\/]$/, '')}/${entry.name}`;
      try {
        if (await agentPaths.isDirectoryPath(fs, entryPath)) {
          await walk(entryPath, source, depth + 1);
          continue;
        }
        if (!entry.name.endsWith('.md') || !(await agentPaths.isFilePath(fs, entryPath))) continue;
        const text = await fs.readText(entryPath);
        try {
          const parserWarnings: string[] = [];
          const agent = core.parseAgentFileText({
            path: entryPath,
            source,
            text,
            warn: (message) => parserWarnings.push(message),
          });
          parsedFiles.push({
            path: entryPath,
            name: agent.name,
            subagents: agent.subagents,
            modelAlias: agent.modelAlias,
            parserWarnings,
          });
        } catch (error) {
          results.push({
            label: 'agents',
            path: entryPath,
            status: 'ERROR',
            message: errorMessage(error),
          });
        }
      } catch (error) {
        results.push({
          label: 'agents',
          path: entryPath,
          status: 'ERROR',
          message: `Unable to read agent profile: ${errorMessage(error)}`,
        });
      }
    }
  };

  for (const root of uniqueRoots) {
    await walk(root.path, root.source, 0);
  }

  const builtinNames = resolveBuiltinProfileNames(core, shippedAgentProfiles);
  const discoveredNames = new Set(builtinNames);
  for (const file of parsedFiles) discoveredNames.add(file.name);

  for (const file of parsedFiles) {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (file.modelAlias !== undefined) {
      const diagnostic = describeModelAlias(context.models, file.modelAlias);
      if (diagnostic?.kind === 'error') errors.push(diagnostic.message);
      if (diagnostic?.kind === 'warning') warnings.push(diagnostic.message);
    }
    const missingSubagents =
      file.subagents?.includes('*') === true
        ? []
        : (file.subagents?.filter((name) => !discoveredNames.has(name)) ?? []);
    if (missingSubagents.length > 0) {
      errors.push(`subagents references unknown agent profiles: ${missingSubagents.join(', ')}.`);
    }
    warnings.push(...file.parserWarnings);

    results.push({
      label: 'agents',
      path: file.path,
      status: errors.length > 0 ? 'ERROR' : warnings.length > 0 ? 'WARN' : 'OK',
      message: formatAgentIssues(errors, warnings),
    });
  }

  if (discoveryWarnings.length > 0) {
    results.unshift({
      label: 'agents',
      path: cwd,
      status: 'WARN',
      message: discoveryWarnings.join('\n'),
    });
  }
  if (results.length === 0) {
    return [
      {
        label: 'agents',
        path: cwd,
        status: 'SKIP',
        message: 'No agent profile files found.',
      },
    ];
  }
  return results.toSorted((a, b) => a.path.localeCompare(b.path));
}

/**
 * Names a `subagents` reference may resolve to without a project/user file: the profiles registered
 * in-process plus the ones the product ships. The shipped profiles are installed as low-priority
 * files under `<agent root>/builtin/` rather than contributed to the profile registry, so they are
 * read from the shipped originals here.
 */
function resolveBuiltinProfileNames(
  core: AgentCoreModule,
  shippedAgentProfiles: ShippedAgentProfilesModule,
): Set<string> {
  const names = new Set(core.getAgentProfileContributions().map((profile) => profile.name));
  for (const template of shippedAgentProfiles.SHIPPED_AGENT_PROFILE_TEMPLATES) {
    names.add(shippedProfileName(core, template));
  }
  return names;
}

function shippedProfileName(
  core: AgentCoreModule,
  template: ShippedAgentProfilesModule['SHIPPED_AGENT_PROFILE_TEMPLATES'][number],
): string {
  try {
    return core.parseAgentFileText({
      path: template.fileName,
      source: 'user',
      text: template.text,
    }).name;
  } catch {
    return template.id;
  }
}

function formatAgentIssues(
  errors: readonly string[],
  warnings: readonly string[],
): string | undefined {
  const messages = [
    ...errors.map((message) => `ERROR: ${message}`),
    ...warnings.map((message) => `WARN: ${message}`),
  ];
  return messages.length > 0 ? messages.join('\n') : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolveConfigTargetPath(
  deps: ResolvedDoctorDeps,
  input: string | undefined,
  cwd: string,
): Promise<string> {
  return input === undefined ? deps.defaultConfigPath() : resolveInputPath(input, cwd);
}

function resolveTuiTargetPath(
  deps: ResolvedDoctorDeps,
  input: string | undefined,
  cwd: string,
): string {
  return input === undefined ? deps.defaultTuiConfigPath() : resolveInputPath(input, cwd);
}

function resolveInputPath(input: string, cwd: string): string {
  return isAbsolute(input) ? input : resolve(cwd, input);
}

function formatSuccess(results: readonly CheckResult[]): string {
  const warningCount = results.filter((result) => result.status === 'WARN').length;
  const summary =
    warningCount === 0
      ? 'All checked config files are valid.'
      : `All checked config files are valid, ${String(warningCount)} ${warningCount === 1 ? 'warning' : 'warnings'}.`;
  return [
    'Kimi doctor',
    '',
    ...formatResults(results),
    '',
    summary,
    '',
  ].join('\n');
}

function formatFailure(results: readonly CheckResult[], issueCount: number): string {
  return [
    `Kimi doctor found ${String(issueCount)} ${issueCount === 1 ? 'issue' : 'issues'}.`,
    '',
    ...formatResults(results),
    '',
  ].join('\n');
}

function formatResults(results: readonly CheckResult[]): string[] {
  const lines: string[] = [];
  for (const result of results) {
    lines.push(`${result.status} ${result.label.padEnd(12)} ${result.path}`);
    if (result.message !== undefined) {
      for (const line of result.message.split('\n')) {
        lines.push(`  ${line}`);
      }
    }
  }
  return lines;
}

function formatErrorMessage(error: unknown, filePath: string): string {
  const validationIssues = findValidationIssues(error);
  if (validationIssues !== undefined) {
    return [
      `Invalid configuration in ${filePath}.`,
      'Validation issues:',
      ...validationIssues.map((issue) => `  ${formatIssuePath(issue.path)}: ${issue.message}`),
    ].join('\n');
  }

  const zodError = findZodError(error);
  if (zodError !== undefined) {
    return [
      `Invalid configuration in ${filePath}.`,
      'Validation issues:',
      ...zodError.issues.map((issue) => `  ${formatIssuePath(issue.path)}: ${issue.message}`),
    ].join('\n');
  }
  return error instanceof Error ? error.message : String(error);
}

function findValidationIssues(error: unknown): readonly KimiConfigValidationIssue[] | undefined {
  if (!(error instanceof Error)) return undefined;
  const details = 'details' in error ? error.details : undefined;
  if (!isRecord(details)) return undefined;
  const validationIssues = details['validationIssues'];
  return isValidationIssueArray(validationIssues) ? validationIssues : undefined;
}

function isValidationIssueArray(value: unknown): value is readonly KimiConfigValidationIssue[] {
  return Array.isArray(value) && value.every(isValidationIssue);
}

function isValidationIssue(value: unknown): value is KimiConfigValidationIssue {
  if (!isRecord(value) || typeof value['message'] !== 'string') return false;
  const path = value['path'];
  return (
    Array.isArray(path) &&
    path.every((segment) => typeof segment === 'string' || typeof segment === 'number')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function modelsSectionFromToml(models: Record<string, unknown>): Record<string, ModelRecord> {
  const out: Record<string, ModelRecord> = {};
  for (const [id, entry] of Object.entries(models)) {
    out[id] = isRecord(entry) ? modelRecordFromToml(entry) : {};
  }
  return out;
}

function modelRecordFromToml(entry: Record<string, unknown>): ModelRecord {
  const aliases = entry['aliases'];
  const provider = entry['provider'];
  const providerId = entry['provider_id'] ?? entry['providerId'];
  const model = entry['model'];
  return {
    ...(typeof provider === 'string' ? { provider } : {}),
    ...(typeof providerId === 'string' ? { providerId } : {}),
    ...(typeof model === 'string' ? { model } : {}),
    ...(Array.isArray(aliases)
      ? { aliases: aliases.filter((item): item is string => typeof item === 'string') }
      : {}),
  };
}

interface ModelAliasDiagnostic {
  readonly kind: 'error' | 'warning';
  readonly message: string;
}

function describeModelAlias(
  models: Readonly<Record<string, ModelRecord>>,
  modelAlias: string,
): ModelAliasDiagnostic | undefined {
  let warning: ModelAliasDiagnostic | undefined;
  const resolved = resolveModelId(models, modelAlias, ({ candidates, resolved: candidate }) => {
    warning = {
      kind: 'warning',
      message: `model_alias "${modelAlias}" is ambiguous and resolves to "${candidate}", the first configured candidate (${candidates.join(', ')}).`,
    };
  });
  if (resolved === undefined) {
    return {
      kind: 'error',
      message: `model_alias "${modelAlias}" does not name an entry in config.toml [models].`,
    };
  }
  return warning;
}

function findZodError(error: unknown): z.ZodError | undefined {
  if (error instanceof z.ZodError) return error;
  if (error instanceof Error && error.cause instanceof z.ZodError) return error.cause;
  return undefined;
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '<root>';

  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${String(segment)}]`;
    } else if (out.length === 0) {
      out = camelToSnake(String(segment));
    } else {
      out += `.${camelToSnake(String(segment))}`;
    }
  }
  return out;
}

function camelToSnake(value: string): string {
  return value.replaceAll(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}
