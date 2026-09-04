import { realpath } from 'node:fs/promises';
import { normalize, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Command } from 'commander';

import { resolveKikiHome } from './home';
import { createSeatOnConnection } from './seat';
import { ensureServer } from './serve';

export const KIKI_CLI_PRINCIPAL = 'kiki-cli';

export const KIKI_EXIT = {
  success: 0,
  failure: 1,
  usage: 2,
  notFound: 3,
  interactionPending: 4,
  timedOut: 124,
} as const;

interface Schema<T> {
  parse(value: unknown): T;
}

export interface DelegationProcedureEntry {
  readonly name: string;
  readonly mcp: {
    readonly description: string;
    readonly input: {
      readonly schema: Schema<unknown>;
      decode(value: never): unknown;
    };
  };
}

export interface DelegationProcedureTableModule {
  readonly delegationProcedureTable: readonly DelegationProcedureEntry[];
}

export interface SeatKlientLike {
  call(name: string, input: unknown): Promise<unknown>;
  close(): Promise<void>;
}

interface SeatKlientModule {
  createSeatKlient(options: { readonly endpoint: string; readonly token: string }): SeatKlientLike;
}

export interface DelegationRuntimeDependencies {
  readonly cwd?: () => string;
  readonly ensureServer?: typeof ensureServer;
  readonly createSeat?: typeof createSeatOnConnection;
  readonly createSeatKlient?: SeatKlientModule['createSeatKlient'];
  readonly loadProcedures?: () => Promise<DelegationProcedureTableModule>;
  readonly loadHttp?: () => Promise<SeatKlientModule>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly stdout?: Pick<NodeJS.WriteStream, 'write'>;
  readonly stderr?: Pick<NodeJS.WriteStream, 'write'>;
}

type ValueKind = 'boolean' | 'integer' | 'json' | 'key-value' | 'string';

interface CliPositionalMetadata {
  readonly name: string;
  readonly input: string;
  readonly required?: boolean;
}

interface CliOptionMetadata {
  readonly flags: string;
  readonly input?: string;
  readonly kind?: ValueKind;
  readonly value?: unknown;
  readonly defaultValue?: unknown;
}

interface CliProcedureMetadata {
  readonly procedure: string;
  readonly command: string;
  readonly positionals?: readonly CliPositionalMetadata[];
  readonly options?: readonly CliOptionMetadata[];
  readonly prepare?: (wire: Record<string, unknown>, options: Record<string, unknown>) => void;
  readonly behavior?: 'dispatch' | 'events' | 'plain';
}

export interface ProjectedDelegationCommand {
  readonly procedure: DelegationProcedureEntry;
  readonly command: string;
  readonly positionals: readonly CliPositionalMetadata[];
  readonly options: readonly CliOptionMetadata[];
  readonly behavior: 'dispatch' | 'events' | 'plain';
  canonicalInput(positionals: readonly unknown[], options: Record<string, unknown>): unknown;
}

const COMMON_OPTIONS: readonly CliOptionMetadata[] = [
  { flags: '--home <dir>' },
  { flags: '--workspace <dir>' },
  { flags: '--json', kind: 'boolean' },
];

const CLI_METADATA: readonly CliProcedureMetadata[] = [
  { procedure: 'profiles', command: 'agents', behavior: 'plain' },
  { procedure: 'list', command: 'list', behavior: 'plain' },
  {
    procedure: 'dispatch',
    command: 'dispatch <message>',
    positionals: [{ name: 'message', input: 'message', required: true }],
    options: [
      { flags: '--main', input: 'target', kind: 'boolean', value: 'main' },
      { flags: '--profile <name>', input: 'profile_name' },
      { flags: '--name <task>', input: 'task_name' },
      { flags: '--model <alias>', input: 'model_alias' },
      { flags: '--thinking <effort>', input: 'thinking_effort' },
      { flags: '--dispatch-key <key>', input: 'dispatch_key' },
      { flags: '--wait', kind: 'boolean' },
      { flags: '--timeout <seconds>', kind: 'integer' },
    ],
    prepare: (wire) => {
      wire['target'] ??= 'named';
    },
    behavior: 'dispatch',
  },
  {
    procedure: 'continue',
    command: 'continue <dispatchId> <message>',
    positionals: [
      { name: 'dispatchId', input: 'dispatch_id', required: true },
      { name: 'message', input: 'message', required: true },
    ],
    options: [
      { flags: '--dispatch-key <key>', input: 'dispatch_key' },
      { flags: '--wait', kind: 'boolean' },
      { flags: '--timeout <seconds>', kind: 'integer' },
    ],
    behavior: 'dispatch',
  },
  {
    procedure: 'send',
    command: 'send <taskName> <message>',
    positionals: [
      { name: 'taskName', input: 'task_name', required: true },
      { name: 'message', input: 'message', required: true },
    ],
    options: [{ flags: '--idempotency-key <key>', input: 'idempotency_key' }],
  },
  { procedure: 'interactions', command: 'interactions', options: [{ flags: '--cursor <cursor>', input: 'cursor', kind: 'integer' }] },
  {
    procedure: 'respond',
    command: 'respond <interactionId>',
    positionals: [{ name: 'interactionId', input: 'interaction_id', required: true }],
    options: [
      { flags: '--approve', kind: 'boolean' },
      { flags: '--reject', kind: 'boolean' },
      { flags: '--cancel', kind: 'boolean' },
      { flags: '--answer <key=value...>', kind: 'key-value' },
      { flags: '--method <method>' },
      { flags: '--feedback <text>' },
      { flags: '--selected-label <label>' },
      { flags: '--selected-option-id <id>' },
    ],
    prepare: (wire, options) => {
      if (options['answer'] !== undefined) {
        wire['kind'] = 'question';
        wire['response'] = {
          answers: options['answer'],
          method: options['method'],
        };
        return;
      }
      const selected = [options['approve'], options['reject'], options['cancel']].filter(Boolean);
      if (selected.length !== 1) throw new Error('Select exactly one approval decision or provide --answer.');
      wire['kind'] = 'approval';
      wire['response'] = {
        decision: options['approve'] === true ? 'approved' : options['reject'] === true ? 'rejected' : 'cancelled',
        feedback: options['feedback'],
        selected_label: options['selectedLabel'],
        selected_option_id: options['selectedOptionId'],
      };
    },
  },
  {
    procedure: 'status',
    command: 'status <dispatchId>',
    positionals: [{ name: 'dispatchId', input: 'dispatch_id', required: true }],
  },
  {
    procedure: 'wait',
    command: 'wait [dispatchId]',
    positionals: [{ name: 'dispatchId', input: 'dispatch_id' }],
    options: [{ flags: '--timeout <seconds>', input: 'timeout_s', kind: 'integer' }],
  },
  {
    procedure: 'result',
    command: 'result <dispatchId>',
    positionals: [{ name: 'dispatchId', input: 'dispatch_id', required: true }],
    options: [
      { flags: '--cursor <cursor>', input: 'cursor', kind: 'integer' },
      { flags: '--limit <bytes>', input: 'max_bytes', kind: 'integer' },
    ],
  },
  {
    procedure: 'events',
    command: 'events <dispatchId>',
    positionals: [{ name: 'dispatchId', input: 'dispatch_id', required: true }],
    options: [
      { flags: '--cursor <cursor>', input: 'cursor', kind: 'integer' },
      { flags: '--limit <count>', input: 'limit', kind: 'integer' },
      { flags: '--detail <level>', input: 'detail' },
      { flags: '--follow', kind: 'boolean' },
      { flags: '--interval <milliseconds>', kind: 'integer', defaultValue: 250 },
    ],
    behavior: 'events',
  },
  {
    procedure: 'transcript',
    command: 'transcript <dispatchId>',
    positionals: [{ name: 'dispatchId', input: 'dispatch_id', required: true }],
    options: [
      { flags: '--cursor <cursor>', input: 'cursor', kind: 'integer' },
      { flags: '--limit <count>', input: 'limit', kind: 'integer' },
      { flags: '--detail <level>', input: 'detail' },
    ],
  },
  {
    procedure: 'cancel',
    command: 'cancel <dispatchId>',
    positionals: [{ name: 'dispatchId', input: 'dispatch_id', required: true }],
  },
];

export function projectDelegationCommands(
  table: readonly DelegationProcedureEntry[],
): readonly ProjectedDelegationCommand[] {
  const byName = new Map(table.map((procedure) => [procedure.name, procedure]));
  return CLI_METADATA.map((metadata) => {
    const procedure = byName.get(metadata.procedure);
    if (procedure === undefined) throw new Error(`Delegation procedure table is missing ${metadata.procedure}.`);
    const positionals = metadata.positionals ?? [];
    const options = [...(metadata.options ?? []), ...COMMON_OPTIONS];
    return {
      procedure,
      command: metadata.command,
      positionals,
      options,
      behavior: metadata.behavior ?? 'plain',
      canonicalInput: (values, rawOptions) => {
        const wire: Record<string, unknown> = {};
        for (const [index, positional] of positionals.entries()) {
          if (values[index] !== undefined) wire[positional.input] = values[index];
        }
        for (const option of metadata.options ?? []) {
          if (option.input === undefined) continue;
          const key = optionKey(option.flags);
          const value = rawOptions[key];
          if (value !== undefined && value !== false) wire[option.input] = option.value ?? value;
        }
        metadata.prepare?.(wire, rawOptions);
        return procedure.mcp.input.decode(procedure.mcp.input.schema.parse(wire) as never);
      },
    };
  });
}

export function registerDelegationCommands(
  program: Command,
  table: readonly DelegationProcedureEntry[],
  dependencies: DelegationRuntimeDependencies = {},
): void {
  const runtimeDependencies: DelegationRuntimeDependencies = {
    ...dependencies,
    loadProcedures: async () => ({ delegationProcedureTable: table }),
  };
  for (const projected of projectDelegationCommands(table)) {
    const command = program.command(projected.command).exitOverride((error) => {
      if (error.exitCode !== 0) error.exitCode = KIKI_EXIT.usage;
      throw error;
    });
    for (const option of projected.options) {
      const parser = option.kind === 'integer'
        ? parseInteger
        : option.kind === 'json'
          ? parseJson
          : option.kind === 'key-value'
            ? collectKeyValue
            : undefined;
      if (option.defaultValue === undefined) command.option(option.flags, '', parser as never);
      else command.option(option.flags, '', parser as never, option.defaultValue);
    }
    command.action(async (...args: unknown[]) => {
      const commander = args.at(-1) as Command;
      const rawOptions = commander.opts<Record<string, unknown>>();
      const positionals = args.slice(0, -2);
      const exitCode = await runDelegationCommand(projected.procedure.name, positionals, rawOptions, runtimeDependencies);
      process.exitCode = exitCode;
    });
  }
}

export async function loadDelegationProcedureTable(): Promise<readonly DelegationProcedureEntry[]> {
  return (await loadProcedures()).delegationProcedureTable;
}

export async function runDelegationCommand(
  procedureName: string,
  positionals: readonly unknown[],
  options: Record<string, unknown>,
  dependencies: DelegationRuntimeDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  let client: SeatKlientLike | undefined;
  try {
    const procedures = await (dependencies.loadProcedures ?? loadProcedures)();
    const command = projectDelegationCommands(procedures.delegationProcedureTable)
      .find((candidate) => candidate.procedure.name === procedureName)!;
    const input = command.canonicalInput(positionals, options);
    client = await createCliSeatKlient(options, dependencies);
    if (command.behavior === 'events' && options['follow'] === true) {
      return followEvents(client, input as Record<string, unknown>, options, dependencies, stdout);
    }
    const output = await client.call(procedureName, input);
    if (command.behavior === 'dispatch' && options['wait'] === true) {
      return finishDispatch(client, output, options, stdout);
    }
    writeOutput(stdout, output, options['json'] === true);
    return exitCodeForOutput(procedureName, output);
  } catch (error) {
    stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`);
    return exitCodeForError(error);
  } finally {
    if (client !== undefined) await client.close();
  }
}

export async function canonicalWorkspace(
  workspace: string | undefined,
  cwd: () => string = process.cwd,
): Promise<string> {
  return normalize(await realpath(resolve(workspace ?? cwd())));
}

async function createCliSeatKlient(
  options: Record<string, unknown>,
  dependencies: DelegationRuntimeDependencies,
): Promise<SeatKlientLike> {
  const workspace = await canonicalWorkspace(asString(options['workspace']), dependencies.cwd);
  const homeDir = resolveKikiHome(asString(options['home']));
  const connection = await (dependencies.ensureServer ?? ensureServer)({ homeDir, workspace });
  const seat = await (dependencies.createSeat ?? createSeatOnConnection)(connection, {
    workspace,
    principal: KIKI_CLI_PRINCIPAL,
  });
  const createClient = dependencies.createSeatKlient
    ?? (await (dependencies.loadHttp ?? loadHttp)()).createSeatKlient;
  return createClient({ endpoint: connection.url, token: seat.delegationToken });
}

async function finishDispatch(
  client: SeatKlientLike,
  dispatched: unknown,
  options: Record<string, unknown>,
  stdout: Pick<NodeJS.WriteStream, 'write'>,
): Promise<number> {
  const dispatchId = record(dispatched)['dispatchId'];
  const waited = await client.call('wait', {
    dispatchId,
    timeoutMs: options['timeout'] === undefined ? undefined : Number(options['timeout']) * 1_000,
  });
  const waitCode = exitCodeForOutput('wait', waited);
  if (waitCode !== KIKI_EXIT.success) {
    writeOutput(stdout, { dispatch: dispatched, wait: waited }, options['json'] === true);
    return waitCode;
  }
  const result = await client.call('result', { dispatchId });
  writeOutput(stdout, { dispatch: dispatched, wait: waited, result }, options['json'] === true);
  return exitCodeForOutput('result', result);
}

async function followEvents(
  client: SeatKlientLike,
  initialInput: Record<string, unknown>,
  options: Record<string, unknown>,
  dependencies: DelegationRuntimeDependencies,
  stdout: Pick<NodeJS.WriteStream, 'write'>,
): Promise<number> {
  let cursor = initialInput['cursor'];
  for (;;) {
    const page = record(await client.call('events', { ...initialInput, cursor }));
    const items = Array.isArray(page['items']) ? page['items'] : [];
    for (const item of items) writeOutput(stdout, item, options['json'] === true);
    cursor = page['nextCursor'] ?? cursor;
    const status = record(await client.call('status', { dispatchId: initialInput['dispatchId'] }));
    if (isTerminalStatus(status['status'])) return exitCodeForOutput('status', status);
    await (dependencies.sleep ?? ((milliseconds) => sleep(milliseconds)))(Number(options['interval']));
  }
}

function exitCodeForOutput(procedure: string, output: unknown): number {
  const value = record(output);
  if (procedure === 'wait') {
    if (value['waitStatus'] === 'timed_out') return KIKI_EXIT.timedOut;
    if (value['waitStatus'] === 'interaction_pending') return KIKI_EXIT.interactionPending;
  }
  const dispatch = record(value['dispatch'] ?? output);
  if (dispatch['status'] === 'failed') return KIKI_EXIT.failure;
  if (dispatch['status'] === 'cancelled' || dispatch['status'] === 'interrupted') return KIKI_EXIT.notFound;
  return KIKI_EXIT.success;
}

function exitCodeForError(error: unknown): number {
  const value = record(error);
  const message = error instanceof Error ? error.message : String(error);
  if (value['code'] === 40002 || /invalid|validation|required|exactly one/iu.test(message)) return KIKI_EXIT.usage;
  if (value['code'] === 404 || /not found|does not exist/iu.test(message)) return KIKI_EXIT.notFound;
  return KIKI_EXIT.failure;
}

function writeOutput(
  stream: Pick<NodeJS.WriteStream, 'write'>,
  value: unknown,
  json: boolean,
): void {
  const safe = redactValue(value);
  if (json) {
    stream.write(`${JSON.stringify(safe)}\n`);
    return;
  }
  stream.write(`${formatHuman(safe)}\n`);
}

function formatHuman(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(formatHuman).join('\n');
  if (value !== null && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${typeof item === 'object' ? JSON.stringify(item) : String(item)}`)
      .join('\n');
  }
  return String(value);
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /token|authorization|secret/iu.test(key) ? '[redacted]' : redactValue(item),
    ]));
  }
  return typeof value === 'string' ? redact(value) : value;
}

function redact(value: string): string {
  return value.replaceAll(/(bearer\s+|token[=:]\s*)[^\s,}]+/giu, '$1[redacted]');
}

function optionKey(flags: string): string {
  const long = flags.split(/[ ,|]+/u).find((part) => part.startsWith('--'))!;
  return long
    .replace(/^--/u, '')
    .replace(/^no-/u, '')
    .replaceAll(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

function parseInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid integer: ${value}`);
  return parsed;
}

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function collectKeyValue(value: string, previous: Record<string, string | true> = {}): Record<string, string | true> {
  const separator = value.indexOf('=');
  if (separator === -1) return { ...previous, [value]: true };
  return { ...previous, [value.slice(0, separator)]: value.slice(separator + 1) };
}

function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' ? value as Record<string, any> : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isTerminalStatus(value: unknown): boolean {
  return value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'interrupted';
}

async function loadProcedures(): Promise<DelegationProcedureTableModule> {
  const specifier = '@moonshot-ai/klient/procedures';
  return import(specifier) as Promise<DelegationProcedureTableModule>;
}

async function loadHttp(): Promise<SeatKlientModule> {
  const specifier = '@moonshot-ai/klient/procedures/http';
  return import(specifier) as Promise<SeatKlientModule>;
}
