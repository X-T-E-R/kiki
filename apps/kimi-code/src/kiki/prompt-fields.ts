import {
  inspectPromptFields,
  listPromptFieldDefinitions,
  type PromptFieldDefinitionInfo,
  type PromptFieldInspectOptions,
  type PromptFieldInspection,
  type PromptFieldValueInfo,
} from '@kiki/node-sdk';
import type { Command } from 'commander';

import { resolveKikiHome } from './home';

interface WritableLike {
  write(chunk: string): boolean;
}

type MaybePromise<T> = T | Promise<T>;

export interface PromptFieldsCommandDeps {
  readonly cwd: () => string;
  readonly resolveHome: (home?: string) => string;
  readonly list: () => readonly PromptFieldDefinitionInfo[];
  readonly inspect: (options: PromptFieldInspectOptions) => Promise<PromptFieldInspection>;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
}

interface ContextOptions {
  readonly home?: string;
  readonly config?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly executor?: string;
  readonly delegationPosition?: 'main' | 'sub' | 'independent';
}

export function registerPromptFieldsCommand(
  program: Command,
  deps?: Partial<PromptFieldsCommandDeps>,
): void {
  const resolved = resolveDeps(deps);
  const command = program
    .command('prompt-fields')
    .description('List, validate, and explain prompt fields without changing configuration.')
    .action(() => {
      resolved.stdout.write(formatList(resolved.list()));
    });

  command
    .command('list')
    .description('List every registered prompt field.')
    .action(() => {
      resolved.stdout.write(formatList(resolved.list()));
    });

  command
    .command('show')
    .description('Show one field definition, default, and allowed variables.')
    .argument('<id>', 'Prompt field ID.')
    .action((id: string) => {
      const field = resolved.list().find((candidate) => candidate.id === id);
      if (field === undefined) return fail(resolved, `Unknown prompt field "${id}".`);
      resolved.stdout.write(formatDefinition(field));
    });

  addContextOptions(command
    .command('validate')
    .description('Validate prompt field overrides in config, external TOML files, and profiles.')
    .argument('[path]', 'Config file to validate instead of <home>/config.toml.'))
    .action(async (path: string | undefined, options: ContextOptions) => {
      await run(resolved, async () => {
        const report = await resolved.inspect(inspectOptions(resolved, {
          ...options,
          config: path ?? options.config,
        }));
        resolved.stdout.write(formatValidation(report));
      });
    });

  addContextOptions(command
    .command('explain')
    .description('Explain the effective value, status, and complete source chain for one field.')
    .argument('<id>', 'Prompt field ID.'))
    .action(async (id: string, options: ContextOptions) => {
      await run(resolved, async () => {
        const report = await resolved.inspect(inspectOptions(resolved, options));
        const field = report.fields.find((candidate) => candidate.id === id);
        if (field === undefined) return fail(resolved, `Unknown prompt field "${id}".`);
        resolved.stdout.write(formatExplanation(report, field));
      });
    });
}

function addContextOptions(command: Command): Command {
  return command
    .option('--home <dir>', 'Kiki home directory. Defaults to KIKI_HOME or ~/.kiki.')
    .option('--config <path>', 'Config file to inspect instead of <home>/config.toml.')
    .option('--agent <name>', 'Agent profile context. Defaults to agent.')
    .option('--model <alias>', 'Model context. Defaults to default_model when configured.')
    .option('--executor <id>', 'Executor context. Defaults to the selected profile executor or native.')
    .option(
      '--delegation-position <position>',
      'Delegation context.',
      (value: string) => {
        if (value === 'main' || value === 'sub' || value === 'independent') return value;
        throw new Error('Delegation position must be main, sub, or independent.');
      },
    );
}

function inspectOptions(
  deps: PromptFieldsCommandDeps,
  options: ContextOptions,
): PromptFieldInspectOptions {
  return {
    homeDir: deps.resolveHome(options.home),
    configPath: options.config,
    cwd: deps.cwd(),
    profile: options.agent,
    model: options.model,
    executor: options.executor,
    delegationPosition: options.delegationPosition,
  };
}

function resolveDeps(
  deps: Partial<PromptFieldsCommandDeps> | undefined,
): PromptFieldsCommandDeps {
  return {
    cwd: deps?.cwd ?? (() => process.cwd()),
    resolveHome: deps?.resolveHome ?? resolveKikiHome,
    list: deps?.list ?? listPromptFieldDefinitions,
    inspect: deps?.inspect ?? inspectPromptFields,
    stdout: deps?.stdout ?? process.stdout,
    stderr: deps?.stderr ?? process.stderr,
    exit: deps?.exit ?? ((code) => process.exit(code)),
  };
}

async function run(deps: PromptFieldsCommandDeps, task: () => MaybePromise<void>): Promise<void> {
  try {
    await task();
  } catch (error) {
    fail(deps, error instanceof Error ? error.message : String(error));
  }
}

function fail(deps: PromptFieldsCommandDeps, message: string): never {
  deps.stderr.write(`Prompt field inspection failed: ${message}\n`);
  return deps.exit(1);
}

function formatList(fields: readonly PromptFieldDefinitionInfo[]): string {
  const lines = ['ID\tOWNER\tCONSUMERS\tOVERRIDE'];
  for (const field of fields) {
    lines.push(
      `${field.id}\t${field.owner}\t${field.consumers.join(',')}\t${field.overridable ? 'yes' : 'no'}`,
    );
  }
  lines.push('', `${String(fields.length)} prompt fields.`);
  return `${lines.join('\n')}\n`;
}

function formatDefinition(field: PromptFieldDefinitionInfo): string {
  const variables = field.allowedVariables.length === 0 ? '(none)' : field.allowedVariables.join(', ');
  const required = field.requiredPlaceholders.length === 0
    ? '(none)'
    : field.requiredPlaceholders.join(', ');
  const defaultLabel = field.defaultKind === 'resource' ? 'Default resource' : 'Default value';
  return [
    `ID: ${field.id}`,
    `Owner: ${field.owner}`,
    `Consumers: ${field.consumers.join(', ')}`,
    `Overridable: ${field.overridable ? 'yes' : 'no'}`,
    `Allow empty: ${field.allowEmpty ? 'yes' : 'no'}`,
    `Allowed variables: ${variables}`,
    `Required placeholders: ${required}`,
    `${defaultLabel}:`,
    field.defaultValue,
    '',
  ].join('\n');
}

function formatValidation(report: PromptFieldInspection): string {
  const summary = report.validation;
  return [
    'OK prompt field configuration is valid.',
    `Config: ${summary.configPath}`,
    `Fields: ${String(summary.fieldCount)}`,
    `Models: ${String(summary.modelCount)}`,
    `Profiles: ${String(summary.profileCount)}`,
    `SYSTEM.md: ${summary.systemMdLoaded ? 'loaded' : 'not found'}`,
    `External override files: ${String(summary.externalFileCount)}`,
    ...report.warnings.map((warning) => `Warning: ${warning}`),
    '',
  ].join('\n');
}

function formatExplanation(report: PromptFieldInspection, field: PromptFieldValueInfo): string {
  const lines = [
    `ID: ${field.id}`,
    `Status: ${field.status}`,
    `Profile: ${report.profile}`,
    `Model: ${report.model ?? '(none)'}`,
    `Executor: ${report.executor}`,
    `Delegation position: ${report.delegationPosition}`,
    'Source chain:',
    ...field.sources.map((source) => `  ${source.status}\t${formatSource(source)}`),
  ];
  if (field.value === undefined) {
    lines.push('Effective value: (none)');
  } else {
    lines.push('Effective value:', field.value);
  }
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  lines.push('');
  return lines.join('\n');
}

function formatSource(source: PromptFieldValueInfo['sources'][number]): string {
  if (source.surface === 'default') return 'default';
  const location = source.path === undefined
    ? ''
    : ` ${source.path}${source.line === undefined ? '' : `:${String(source.line)}`}`;
  const index = source.fileIndex === undefined ? '' : `[${String(source.fileIndex)}]`;
  return `${source.surface}:${source.kind}${index}${location}`;
}
