import { realpath } from 'node:fs/promises';
import { normalize, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  delegationProcedureTable,
  type DelegationProcedureInput,
  type DelegationProcedureName,
  type DelegationProcedureTable,
} from '@kiki/klient/procedures';
import { createSeatKlient } from '@kiki/klient/procedures/http';
import { createKlient } from '@kiki/klient/http';
import type { Klient } from '@kiki/klient';
import type { Command } from 'commander';

import { resolveKikiHome } from './home';
import { createSeatOnConnection, resolveSeatOnConnection } from './seat';
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

export type DelegationProcedureEntry = DelegationProcedureTable[number];

export interface DelegationRuntimeDependencies {
  readonly cwd?: () => string;
  readonly ensureServer?: typeof ensureServer;
  readonly createSeat?: typeof createSeatOnConnection;
  readonly resolveSeat?: typeof resolveSeatOnConnection;
  readonly createSeatKlient?: typeof createSeatKlient;
  readonly createKlient?: typeof createKlient;
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
  readonly description: string;
  readonly input?: string;
  readonly kind?: ValueKind;
  readonly value?: unknown;
  readonly defaultValue?: unknown;
}

interface CliProcedureMetadata {
  readonly procedure: DelegationProcedureName;
  readonly command: string;
  readonly description: string;
  readonly positionals?: readonly CliPositionalMetadata[];
  readonly options?: readonly CliOptionMetadata[];
  readonly prepare?: (wire: Record<string, unknown>, options: Record<string, unknown>) => void;
  readonly behavior?: 'dispatch' | 'events' | 'plain';
  readonly sessionRequirement?: 'catalog' | 'existing' | 'create';
}

export interface ProjectedDelegationCommand {
  readonly procedure: DelegationProcedureEntry;
  readonly command: string;
  readonly description: string;
  readonly positionals: readonly CliPositionalMetadata[];
  readonly options: readonly CliOptionMetadata[];
  readonly behavior: 'dispatch' | 'events' | 'plain';
  readonly sessionRequirement: 'catalog' | 'existing' | 'create';
  canonicalInput(positionals: readonly unknown[], options: Record<string, unknown>): unknown;
}

const COMMON_OPTIONS: readonly CliOptionMetadata[] = [
  { flags: '--home <dir>', description: 'Use this Kiki home directory.' },
  { flags: '--workspace <dir>', description: 'Use this workspace for the CLI delegation seat (default: current directory).' },
  { flags: '--json', description: 'Print JSON; followed events are printed as JSONL.', kind: 'boolean' },
];

const CLI_METADATA: readonly CliProcedureMetadata[] = [
  { procedure: 'profiles', command: 'agents', description: 'List named agent profiles, models, and tools.', behavior: 'plain', sessionRequirement: 'catalog' },
  { procedure: 'list', command: 'list', description: 'List children and continuations owned by the CLI seat.', behavior: 'plain' },
  {
    procedure: 'dispatch',
    sessionRequirement: 'create',
    command: 'dispatch <message>',
    description: 'Dispatch main-agent work or start/reuse a named child asynchronously.',
    positionals: [{ name: 'message', input: 'message', required: true }],
    options: [
      { flags: '--main', description: 'Target the main agent instead of a named child.', input: 'target', kind: 'boolean', value: 'main' },
      { flags: '--profile <name>', description: 'Profile for a named child.', input: 'profile_name' },
      { flags: '--name <task>', description: 'Stable child name: lowercase letters, digits, and underscores; not root.', input: 'task_name' },
      { flags: '--model <alias>', description: 'Bind a model when the named child is first created.', input: 'model_alias' },
      { flags: '--thinking <effort>', description: 'Bind thinking effort when the named child is first created.', input: 'thinking_effort' },
      { flags: '--dispatch-key <key>', description: 'Deduplicate dispatch retries with this key (default: generated).', input: 'dispatch_key' },
      { flags: '--wait', description: 'Wait for completion or pending interaction, then read the result if completed.', kind: 'boolean' },
      { flags: '--timeout <seconds>', description: 'Timeout for --wait in seconds; does not cancel the dispatch.', kind: 'integer' },
    ],
    prepare: (wire) => {
      wire['target'] ??= 'named';
    },
    behavior: 'dispatch',
  },
  {
    procedure: 'continue',
    command: 'continue <dispatchId> <message>',
    description: 'Continue an owned terminal main-agent or named-child dispatch.',
    positionals: [
      { name: 'dispatchId', input: 'dispatch_id', required: true },
      { name: 'message', input: 'message', required: true },
    ],
    options: [
      { flags: '--dispatch-key <key>', description: 'Deduplicate continuation retries with this key (default: generated).', input: 'dispatch_key' },
      { flags: '--wait', description: 'Wait for completion or pending interaction, then read the result if completed.', kind: 'boolean' },
      { flags: '--timeout <seconds>', description: 'Timeout for --wait in seconds; does not cancel the dispatch.', kind: 'integer' },
    ],
    behavior: 'dispatch',
  },
  {
    procedure: 'send',
    command: 'send <taskName> <message>',
    description: 'Queue a message for an owned named child at its next run boundary.',
    positionals: [
      { name: 'taskName', input: 'task_name', required: true },
      { name: 'message', input: 'message', required: true },
    ],
    options: [{ flags: '--idempotency-key <key>', description: 'Deduplicate message retries with this key (default: generated).', input: 'idempotency_key' }],
  },
  {
    procedure: 'interactions', command: 'interactions',
    description: 'List pending approvals and questions from owned children.',
    options: [{ flags: '--cursor <cursor>', description: 'Resume from the returned nextCursor.', input: 'cursor', kind: 'integer' }],
  },
  {
    procedure: 'respond',
    command: 'respond <interactionId>',
    description: 'Answer an owned child approval or question.',
    positionals: [{ name: 'interactionId', input: 'interaction_id', required: true }],
    options: [
      { flags: '--approve', description: 'Approve the request; select exactly one approval decision.', kind: 'boolean' },
      { flags: '--reject', description: 'Reject the approval request.', kind: 'boolean' },
      { flags: '--cancel', description: 'Cancel the approval request.', kind: 'boolean' },
      { flags: '--answer <key=value...>', description: 'Answer a question with key=value pairs; a bare key means true.', kind: 'key-value' },
      { flags: '--method <method>', description: 'Question input method: enter, space, or number_key.' },
      { flags: '--feedback <text>', description: 'Feedback for an approval decision.' },
      { flags: '--selected-label <label>', description: 'Selected approval option label.' },
      { flags: '--selected-option-id <id>', description: 'Selected approval option ID.' },
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
    description: 'Read the status of an owned dispatch.',
    positionals: [{ name: 'dispatchId', input: 'dispatch_id', required: true }],
  },
  {
    procedure: 'wait',
    command: 'wait [dispatchId]',
    description: 'Wait for one or the next owned dispatch to finish or request interaction.',
    positionals: [{ name: 'dispatchId', input: 'dispatch_id' }],
    options: [{ flags: '--timeout <seconds>', description: 'Wait up to 600 seconds; timeout does not cancel the dispatch.', input: 'timeout_s', kind: 'integer' }],
  },
  {
    procedure: 'result',
    command: 'result <dispatchId>',
    description: 'Read a UTF-8-bounded result page for an owned dispatch.',
    positionals: [{ name: 'dispatchId', input: 'dispatch_id', required: true }],
    options: [
      { flags: '--cursor <cursor>', description: 'Resume from the returned nextCursor.', input: 'cursor', kind: 'integer' },
      { flags: '--limit <bytes>', description: 'Maximum result bytes per page (4–65536; larger values are capped).', input: 'max_bytes', kind: 'integer' },
    ],
  },
  {
    procedure: 'events',
    command: 'events <dispatchId>',
    description: 'Read ordered lifecycle or turn events for an owned dispatch.',
    positionals: [{ name: 'dispatchId', input: 'dispatch_id', required: true }],
    options: [
      { flags: '--cursor <cursor>', description: 'Resume after this event sequence; each detail level has its own cursor.', input: 'cursor', kind: 'integer' },
      { flags: '--limit <count>', description: 'Maximum events per page (1–100).', input: 'limit', kind: 'integer' },
      { flags: '--detail <level>', description: 'Event detail: lifecycle or turn.', input: 'detail' },
      { flags: '--follow', description: 'Poll events until the dispatch reaches a terminal status.', kind: 'boolean' },
      { flags: '--interval <milliseconds>', description: 'Polling interval for --follow.', kind: 'integer', defaultValue: 250 },
    ],
    behavior: 'events',
  },
  {
    procedure: 'transcript',
    command: 'transcript <dispatchId>',
    description: 'Read text or structured transcript items for an owned dispatch.',
    positionals: [{ name: 'dispatchId', input: 'dispatch_id', required: true }],
    options: [
      { flags: '--cursor <cursor>', description: 'Resume from the returned nextCursor.', input: 'cursor', kind: 'integer' },
      { flags: '--limit <count>', description: 'Maximum transcript items per page (1–100).', input: 'limit', kind: 'integer' },
      { flags: '--detail <level>', description: 'Transcript detail: text or items.', input: 'detail' },
    ],
  },
  {
    procedure: 'cancel',
    command: 'cancel <dispatchId>',
    description: 'Idempotently cancel an owned active dispatch.',
    positionals: [{ name: 'dispatchId', input: 'dispatch_id', required: true }],
  },
];

export function projectDelegationCommands(
  table: DelegationProcedureTable = delegationProcedureTable,
): readonly ProjectedDelegationCommand[] {
  const byName = new Map(table.map((procedure) => [procedure.name, procedure]));
  return CLI_METADATA.map((metadata) => {
    const procedure = byName.get(metadata.procedure)!;
    const positionals = metadata.positionals ?? [];
    const options = [...(metadata.options ?? []), ...COMMON_OPTIONS];
    return {
      procedure,
      command: metadata.command,
      description: metadata.description,
      positionals,
      options,
      behavior: metadata.behavior ?? 'plain',
      sessionRequirement: metadata.sessionRequirement ?? 'existing',
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
  table: DelegationProcedureTable = delegationProcedureTable,
  dependencies: DelegationRuntimeDependencies = {},
): void {
  for (const projected of projectDelegationCommands(table)) {
    const command = program.command(projected.command).description(projected.description).exitOverride((error) => {
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
      if (option.defaultValue === undefined) command.option(option.flags, option.description, parser as never);
      else command.option(option.flags, option.description, parser as never, option.defaultValue);
    }
    command.action(async (...args: unknown[]) => {
      const commander = args.at(-1) as Command;
      const rawOptions = commander.opts<Record<string, unknown>>();
      const positionals = args.slice(0, -2);
      const exitCode = await runDelegationCommand(projected.procedure.name, positionals, rawOptions, dependencies);
      process.exitCode = exitCode;
    });
  }
}

export async function runDelegationCommand(
  procedureName: DelegationProcedureName,
  positionals: readonly unknown[],
  options: Record<string, unknown>,
  dependencies: DelegationRuntimeDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  let client: CliDelegationClient | undefined;
  try {
    const command = projectDelegationCommands()
      .find((candidate) => candidate.procedure.name === procedureName)!;
    const input = command.canonicalInput(positionals, options);
    client = await createCliDelegationClient(command.sessionRequirement, options, dependencies);
    if (command.behavior === 'events' && options['follow'] === true) {
      return await followEvents(client, input as DelegationProcedureInput<'events'>, options, dependencies, stdout);
    }
    const output = await callProcedure(client, procedureName, input);
    if (command.behavior === 'dispatch' && options['wait'] === true) {
      return await finishDispatch(client, output, options, stdout);
    }
    writeOutput(stdout, output, options['json'] === true);
    return exitCodeForOutput(procedureName, output);
  } catch (error) {
    stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`);
    return exitCodeForError(error);
  } finally {
    await client?.close();
  }
}

function callProcedure(
  client: CliDelegationClient,
  name: DelegationProcedureName,
  input: unknown,
): Promise<unknown> {
  return client.call(name, input as never);
}

export async function canonicalWorkspace(
  workspace: string | undefined,
  cwd: () => string = () => process.cwd(),
): Promise<string> {
  return normalize(await realpath(resolve(workspace ?? cwd())));
}

interface CliDelegationClient {
  call(name: DelegationProcedureName, input: unknown): Promise<unknown>;
  close(): Promise<void>;
}

async function createCliDelegationClient(
  requirement: ProjectedDelegationCommand['sessionRequirement'],
  options: Record<string, unknown>,
  dependencies: DelegationRuntimeDependencies,
): Promise<CliDelegationClient> {
  const workspace = await canonicalWorkspace(asString(options['workspace']), dependencies.cwd);
  const homeDir = resolveKikiHome(asString(options['home']));
  const connection = await (dependencies.ensureServer ?? ensureServer)({ homeDir, workspace });
  if (requirement === 'catalog') {
    const client: Klient = (dependencies.createKlient ?? createKlient)({
      endpoint: connection.url,
      token: connection.token,
    });
    return {
      call: () => client.rest!.agents.list({ cwd: workspace, effective: true }),
      close: () => client.close(),
    };
  }
  const resolveSeat = requirement === 'create'
    ? dependencies.createSeat ?? createSeatOnConnection
    : dependencies.resolveSeat ?? resolveSeatOnConnection;
  const seat = await resolveSeat(connection, { workspace, principal: KIKI_CLI_PRINCIPAL });
  if (seat === null) throw new Error('CLI delegation seat does not exist; dispatch work or explicitly create a seat first.');
  const client = (dependencies.createSeatKlient ?? createSeatKlient)({
    endpoint: connection.url,
    token: seat.delegationToken,
  });
  return { call: (name, input) => client.call(name, input as never), close: () => client.close() };
}

async function finishDispatch(
  client: CliDelegationClient,
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
  client: CliDelegationClient,
  initialInput: DelegationProcedureInput<'events'>,
  options: Record<string, unknown>,
  dependencies: DelegationRuntimeDependencies,
  stdout: Pick<NodeJS.WriteStream, 'write'>,
): Promise<number> {
  let cursor = initialInput['cursor'];
  for (;;) {
    const page = record(await client.call('events', { ...initialInput, cursor }));
    const items = Array.isArray(page['items']) ? page['items'] : [];
    for (const item of items) writeOutput(stdout, item, options['json'] === true);
    if (items.length > 0) {
      cursor = page['nextCursor'] ?? record(items.at(-1))['seq'];
    }
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
