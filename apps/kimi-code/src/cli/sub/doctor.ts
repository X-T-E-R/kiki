import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import {
  createKimiConfigRpc,
  type KimiConfigRpc,
  type KimiConfigValidationIssue,
} from '@moonshot-ai/kimi-code-sdk';
import type { Command } from 'commander';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

import { isKimiV2Enabled } from '#/cli/experimental-v2';
import { getTuiConfigPath, parseTuiConfig } from '#/tui/config';
import { getDataDir } from '#/utils/paths';

interface WritableLike {
  write(chunk: string): boolean;
}

type MaybePromise<T> = T | Promise<T>;

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
}

export interface DoctorOptions {
  readonly target?: 'config' | 'tui';
  readonly path?: string;
}

interface DoctorConfigContext {
  readonly modelAliases: Set<string>;
  extraAgentDirs: readonly string[];
  secondaryModelEnabled: boolean;
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
        if (isKimiV2Enabled()) {
          // Default v2 route (same engine gate as `kimi -p`): validate with
          // the agent-core-v2 section registry instead of the legacy schema.
          // Loaded lazily so the v2 module graph stays off the legacy path.
          const { validateConfigTomlV2 } = await import('../v2/validate-config');
          return validateConfigTomlV2(text, filePath);
        }
        await getConfigRpc().validateConfigToml({ text, filePath });
        return undefined;
      }),
    kimiHomeDir: deps?.kimiHomeDir ?? getDataDir,
    osHomeDir: deps?.osHomeDir ?? homedir,
    getEnv: deps?.getEnv ?? ((name) => process.env[name]),
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

const KNOWN_AGENT_FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'whenToUse',
  'override',
  'tools',
  'disallowedTools',
  'subagents',
  'model_preference',
  'model_alias',
  'thinking_effort',
  'service_tier',
]);
const MAX_AGENT_SCAN_DEPTH = 8;

interface ParsedAgentFile {
  readonly path: string;
  readonly name: string;
  readonly override: boolean;
  readonly subagents?: readonly string[];
  readonly modelPreference?: 'primary' | 'secondary';
  readonly modelAlias?: string;
  readonly unknownKeys: readonly string[];
}

function createDoctorConfigContext(deps: ResolvedDoctorDeps): DoctorConfigContext {
  return {
    modelAliases: new Set(),
    extraAgentDirs: [],
    secondaryModelEnabled: resolveSecondaryModelFlag(deps, undefined),
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

  context.modelAliases.clear();
  const models = data['models'];
  if (isRecord(models)) {
    for (const name of Object.keys(models)) context.modelAliases.add(name);
  }

  const extraAgentDirs = data['extra_agent_dirs'];
  context.extraAgentDirs = Array.isArray(extraAgentDirs)
    ? extraAgentDirs.filter((entry): entry is string => typeof entry === 'string')
    : [];

  const experimental = data['experimental'];
  const secondaryModelConfig = isRecord(experimental)
    ? experimental['secondary-model']
    : undefined;
  context.secondaryModelEnabled = resolveSecondaryModelFlag(
    deps,
    typeof secondaryModelConfig === 'boolean' ? secondaryModelConfig : undefined,
  );
}

function resolveSecondaryModelFlag(
  deps: ResolvedDoctorDeps,
  configValue: boolean | undefined,
): boolean {
  if (parseBooleanEnv(deps.getEnv('KIMI_CODE_EXPERIMENTAL_FLAG')) === true) return true;
  const envValue = parseBooleanEnv(deps.getEnv('KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL'));
  return envValue ?? configValue ?? false;
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
  const [core, agentRoots, agentPaths, frontmatter] = await Promise.all([
    import('@moonshot-ai/agent-core-v2'),
    import(
      '@moonshot-ai/agent-core-v2/workspace/workspaceAgentProfileLoader/internal/agentRoots'
    ),
    import('@moonshot-ai/agent-core-v2/workspace/workspaceAgentProfileLoader/internal/paths'),
    import('@moonshot-ai/agent-core-v2/_base/text/frontmatter'),
  ]);
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
          const agent = core.parseAgentFileText({ path: entryPath, source, text });
          const parsedFrontmatter = frontmatter.parseFrontmatter(text);
          const unknownKeys = isRecord(parsedFrontmatter.data)
            ? Object.keys(parsedFrontmatter.data).filter(
                (key) => !KNOWN_AGENT_FRONTMATTER_KEYS.has(key),
              )
            : [];
          parsedFiles.push({
            path: entryPath,
            name: agent.name,
            override: agent.override,
            subagents: agent.subagents,
            modelPreference: agent.modelPreference,
            modelAlias: agent.modelAlias,
            unknownKeys,
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

  const builtinNames = new Set(core.getAgentProfileContributions().map((profile) => profile.name));
  const discoveredNames = new Set(builtinNames);
  for (const file of parsedFiles) discoveredNames.add(file.name);

  for (const file of parsedFiles) {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (file.modelAlias !== undefined && !context.modelAliases.has(file.modelAlias)) {
      errors.push(
        `model_alias "${file.modelAlias}" does not name an entry in config.toml [models].`,
      );
    }
    const missingSubagents =
      file.subagents?.includes('*') === true
        ? []
        : (file.subagents?.filter((name) => !discoveredNames.has(name)) ?? []);
    if (missingSubagents.length > 0) {
      errors.push(`subagents references unknown agent profiles: ${missingSubagents.join(', ')}.`);
    }
    if (file.unknownKeys.length > 0) {
      warnings.push(
        `Unknown frontmatter ${file.unknownKeys.length === 1 ? 'key' : 'keys'} ignored by the engine: ${file.unknownKeys.join(', ')}.`,
      );
    }
    if (builtinNames.has(file.name) && !file.override) {
      warnings.push(
        `Agent profile "${file.name}" conflicts with a builtin profile; set override: true to replace it.`,
      );
    }
    if (file.modelPreference !== undefined && !context.secondaryModelEnabled) {
      warnings.push(
        'model_preference is ignored while the secondary-model experimental feature is disabled.',
      );
    }

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
  return [
    'Kimi doctor',
    '',
    ...formatResults(results),
    '',
    'All checked config files are valid.',
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
