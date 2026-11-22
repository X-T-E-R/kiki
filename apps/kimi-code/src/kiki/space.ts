import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline/promises';

import {
  portableSpaceApplyInputSchema,
  portableSpaceApplyReceiptSchema,
  portableSpaceDeltaInputSchema,
  portableSpaceEndpointSchema,
  portableSpaceExportInputSchema,
  portableSpaceExportReceiptSchema,
  portableSpaceForkInputSchema,
  portableSpaceInspectInputSchema,
  portableSpaceInspectResultSchema,
  portableSpaceMutateInputSchema,
  portableSpaceMutateReceiptSchema,
  portableSpacePackUnpackInputSchema,
  portableSpacePreviewInputSchema,
  portableSpacePreviewResultSchema,
  portableSpaceRekeyInputSchema,
  portableSpaceSourcesListResponseSchema,
  type PortableSpaceApplyInput,
  type PortableSpaceEndpoint,
  type PortableSpaceEncryption,
  type PortableSpaceExportInput,
  type PortableSpaceFormat,
  type PortableSpaceMutateAction,
  type PortableSpacePackUnpackInput,
  type PortableSpacePreviewInput,
  type PortableSpaceUnlock,
} from '@kiki/protocol';
import type { Command } from 'commander';

import { quoteShellArg } from '../utils/shell-quote';
import { resolveEditorCommand } from '../utils/process/external-editor';
import { resolveKikiHome } from './home';
import { ensureServer, type ServerConnection } from './serve';

const writeBinary = async (path: string, output: { write(chunk: Uint8Array): unknown }): Promise<void> => {
  for await (const chunk of createReadStream(path)) output.write(chunk);
};

const PORTABLE_ARCHIVE_SUFFIX = /\.(?:kiki\.)?(?:age|tgz|tar\.gz|json)$/iu;

export interface SpaceCommandDependencies {
  readonly ensureServer?: typeof ensureServer;
  readonly fetch?: typeof fetch;
  readonly stdout?: { write(chunk: string | Uint8Array): unknown };
  readonly stderr?: { write(chunk: string | Uint8Array): unknown };
  readonly stdin?: NodeJS.ReadableStream;
  readonly confirm?: (message: string) => Promise<boolean>;
  readonly editor?: (directory: string, command: string) => Promise<void>;
  readonly runRemote?: (program: string, args: string[], archive?: string, outputArchive?: string) => Promise<string>;
}

type SpaceOptions = {
  readonly home?: string;
  readonly json?: boolean;
  readonly yes?: boolean;
  readonly output?: string;
  readonly destination?: string;
  readonly format?: PortableSpaceFormat;
  readonly mode?: 'merge' | 'override' | 'replace' | 'sync';
  readonly override?: boolean;
  readonly replace?: boolean;
  readonly merge?: boolean;
  readonly to?: string;
  readonly source?: string;
  readonly sources?: string[];
  readonly space?: string;
  readonly target?: string;
  readonly base?: string;
  readonly since?: string;
  readonly branch?: string;
  readonly subpath?: string;
  readonly label?: string;
  readonly linkTo?: string;
  readonly domain?: string[];
  readonly only?: string[];
  readonly plain?: boolean;
  readonly includeSecretsPlain?: boolean;
  readonly credentials?: boolean;
  readonly memories?: boolean;
  readonly platform?: 'win32' | 'darwin' | 'linux';
  readonly dryRun?: boolean;
  readonly backup?: boolean;
  readonly stat?: boolean;
  readonly session?: string;
  readonly channel?: 'stable' | 'beta';
  readonly pick?: string[];
  readonly unset?: string[];
  readonly includeCredentials?: boolean;
  readonly includeSessions?: boolean | string;
  readonly includeMemories?: boolean;
  readonly gitInit?: boolean;
  readonly secretMode?: 'none' | 'sealed' | 'plain';
  readonly recipient?: string[];
  readonly encryptPassphrase?: string;
  readonly passphrase?: string | true;
  readonly identity?: string;
  readonly fromPassphrase?: string;
  readonly unlockPassphrase?: string;
  readonly fromIdentity?: string;
  readonly recordOverlayUnset?: boolean;
  readonly prefer?: 'left' | 'right';
  readonly editor?: string;
  readonly value?: string;
  readonly previewToken?: string;
  readonly selected?: string[];
  readonly branchExplicit?: boolean;
  readonly overlay?: boolean;
  readonly dir?: boolean;
  readonly apply?: boolean;
};

type JsonParser<T> = { parse(value: unknown): T };
type PortableEndpointKind = PortableSpaceEndpoint['kind'];

function outputFor(dependencies: SpaceCommandDependencies): { stdout: { write(chunk: string | Uint8Array): unknown }; stderr: { write(chunk: string | Uint8Array): unknown } } {
  return {
    stdout: dependencies.stdout ?? process.stdout,
    stderr: dependencies.stderr ?? process.stderr,
  };
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function sessionSelection(value: boolean | string | undefined): { readonly mode: 'none' } | { readonly mode: 'recent'; readonly count: number } {
  if (value === undefined || value === false) return { mode: 'none' };
  if (value === true) return { mode: 'recent', count: 20 };
  const match = /^recent:(\d+)$/u.exec(value.trim());
  if (match === null) throw new Error('Expected --include-sessions to be bare or recent:<count>.');
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('--include-sessions recent:<count> requires a positive integer count.');
  return { mode: 'recent', count };
}

function nonEmpty(values: readonly string[] | undefined): readonly string[] | undefined {
  return values === undefined || values.length === 0 ? undefined : values;
}

function asOptions(command: Command): SpaceOptions {
  return command.optsWithGlobals<SpaceOptions>();
}

function writeJson(value: unknown, dependencies: SpaceCommandDependencies, compact = false): void {
  outputFor(dependencies).stdout.write(`${JSON.stringify(value, null, compact ? 0 : 2)}\n`);
}

function parseJsonValue(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function isArchivePath(path: string): boolean {
  return PORTABLE_ARCHIVE_SUFFIX.test(path);
}

function archiveFormat(path: string): PortableSpaceFormat {
  return /\.age$/iu.test(path) ? 'age' : 'tgz';
}

function resolveLocalPath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

function parseGitEndpoint(value: string, branch?: string, subpath?: string): PortableSpaceEndpoint {
  let repo = value;
  let ref = branch;
  let path = subpath;
  const hash = value.indexOf('#');
  if (hash >= 0) {
    repo = value.slice(0, hash);
    const suffix = value.slice(hash + 1);
    const separator = suffix.indexOf('//');
    if (separator >= 0) {
      ref = ref ?? suffix.slice(0, separator);
      path = path ?? suffix.slice(separator + 2);
    } else {
      ref = ref ?? suffix;
    }
  } else if (value.startsWith('github:')) {
    const separator = value.indexOf('//', 'github:'.length);
    if (separator >= 0) {
      repo = value.slice(0, separator);
      path = path ?? value.slice(separator + 2);
    }
  }
  return portableSpaceEndpointSchema.parse(compactObject({
    kind: 'git',
    repo,
    ref,
    subpath: path,
  }));
}

export function parsePortableEndpoint(value: string | undefined, options: { readonly kind?: PortableEndpointKind; readonly branch?: string; readonly subpath?: string } = {}): PortableSpaceEndpoint {
  if (value === undefined || value.trim() === '') return { kind: 'live', spaceId: 'main' };
  const raw = value.trim();
  const explicit = /^(live|dir|archive|git):(.*)$/su.exec(raw);
  if (explicit !== null) {
    const kind = explicit[1]! as PortableEndpointKind;
    const payload = explicit[2]!;
    if (kind === 'live') return portableSpaceEndpointSchema.parse({ kind, spaceId: payload || 'main' });
    if (kind === 'git') return parseGitEndpoint(payload, options.branch, options.subpath);
    return portableSpaceEndpointSchema.parse({ kind, path: resolveLocalPath(payload) });
  }
  if (options.kind === 'git' || raw.startsWith('github:') || raw.startsWith('git@') || raw.startsWith('ssh://') || raw.startsWith('git://') || raw.startsWith('https://') || raw.startsWith('http://')) {
    return parseGitEndpoint(raw, options.branch, options.subpath);
  }
  if (options.kind === 'archive' || isArchivePath(raw)) return portableSpaceEndpointSchema.parse({ kind: 'archive', path: resolveLocalPath(raw) });
  if (options.kind === 'dir' || isAbsolute(raw) || raw.startsWith('./') || raw.startsWith('../') || raw.includes('/') || raw.includes('\\')) {
    return portableSpaceEndpointSchema.parse({ kind: 'dir', path: resolveLocalPath(raw) });
  }
  return portableSpaceEndpointSchema.parse({ kind: 'live', spaceId: raw });
}

function unlockFromOptions(options: SpaceOptions): PortableSpaceUnlock | undefined {
  const unlock = compactObject({ passphrase: typeof options.passphrase === 'string' ? options.passphrase : undefined, identity: options.identity });
  return Object.keys(unlock).length === 0 ? undefined : unlock;
}

function recipientsFromOptions(options: SpaceOptions): string[] | undefined {
  const values = (options.recipient ?? []).flatMap((entry) => entry.split(',')).map((entry) => entry.trim()).filter(Boolean);
  return values.length === 0 ? undefined : [...new Set(values)];
}

function encryptionFromOptions(options: SpaceOptions): PortableSpaceEncryption | undefined {
  const recipients = recipientsFromOptions(options);
  if (recipients !== undefined) return { mode: 'x25519', recipients };
  if (options.encryptPassphrase !== undefined) return { mode: 'passphrase', passphrase: options.encryptPassphrase };
  return undefined;
}

function commonOptions(command: Command): Command {
  return command
    .option('--home <dir>', 'Kiki home directory.')
    .option('--space <id>', 'Live Space id; defaults to main.')
    .option('--json', 'Print the response as JSON.')
    .option('-y, --yes', 'Skip confirmation prompts.')
    .option('--passphrase [value]', 'Use a passphrase; without a value use KIKI_AGE_PASSPHRASE.')
    .option('--identity <value>', 'Age identity text or path; defaults to KIKI_AGE_KEY.')
    .option('-r, --recipient <age1...>', 'Age recipient; may be repeated.', collect, [])
    .option('--platform <platform>', 'Apply configuration for linux, darwin, or win32.')
    .option('--only <domains>', 'Select comma-separated portable domains.', collect, [])
    .option('--no-credentials', 'Omit credentials.')
    .option('--include-secrets-plain', 'Write private plaintext credentials to a Git-ignored file.')
    .option('--no-memories', 'Omit memories.')
    .option('--encrypt-passphrase <value>', 'Passphrase used to encrypt a new archive.')
    .option('--secret-mode <mode>', 'Credential mode: none, sealed, or plain.')
    .option('--format <format>', 'Archive format: age or tgz.');
}

function domainsOf(options: SpaceOptions): readonly string[] | undefined {
  return nonEmpty([...options.domain ?? [], ...(options.only ?? []).flatMap((option) => option.split(',').map((value) => value.trim()).filter(Boolean))]);
}

function sealForExport(options: SpaceOptions): PortableSpaceEncryption | undefined {
  return encryptionFromOptions(options) ?? (options.passphrase === undefined ? undefined : { mode: 'passphrase', passphrase: typeof options.passphrase === 'string' ? options.passphrase : undefined });
}

function secretMode(options: SpaceOptions) {
  return options.credentials === false ? 'none' : options.includeSecretsPlain ? 'plain' : options.secretMode;
}

function endpointFromOption(value: string | undefined, options: SpaceOptions): PortableSpaceEndpoint {
  return parsePortableEndpoint(value ?? options.space, { branch: options.branch, subpath: options.subpath });
}

interface PortableSpaceEnvelope {
  readonly code: number;
  readonly msg: string;
  readonly data?: unknown;
  readonly details?: unknown;
  readonly request_id?: string;
}

export class PortableSpaceRequestError extends Error {
  readonly httpStatus: number;
  readonly code: number;
  readonly requestId?: string;
  readonly details?: unknown;

  constructor(
    message: string,
    info: {
      readonly httpStatus: number;
      readonly code: number;
      readonly requestId?: string;
      readonly details?: unknown;
    },
  ) {
    super(message);
    this.name = 'PortableSpaceRequestError';
    this.httpStatus = info.httpStatus;
    this.code = info.code;
    this.requestId = info.requestId;
    this.details = info.details;
  }
}

async function readEnvelope(response: Response): Promise<PortableSpaceEnvelope> {
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error(`Portable Space request returned non-JSON HTTP ${response.status}.`); }
  if (typeof body !== 'object' || body === null || !('code' in body) || typeof body.code !== 'number' || !('msg' in body) || typeof body.msg !== 'string') {
    throw new Error(`Portable Space request returned an invalid envelope (HTTP ${response.status}).`);
  }
  return body as PortableSpaceEnvelope;
}

export async function portableSpaceRequest<T>(
  connection: ServerConnection,
  operation: string,
  options: { readonly method?: 'GET' | 'POST' | 'DELETE'; readonly body?: unknown; readonly parse?: JsonParser<T>; readonly fetch?: typeof fetch } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${connection.token}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await (options.fetch ?? globalThis.fetch)(`${connection.url}/api/spaces/portable/${operation}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'error',
  });
  const envelope = await readEnvelope(response);
  if (!response.ok || envelope.code !== 0) {
    throw new PortableSpaceRequestError(
      envelope.msg || `Portable Space request failed (HTTP ${response.status}).`,
      {
        httpStatus: response.status,
        code: envelope.code,
        requestId: envelope.request_id,
        details: envelope.details ?? envelope.data,
      },
    );
  }
  return options.parse === undefined ? envelope.data as T : options.parse.parse(envelope.data);
}

async function withConnection<T>(command: Command, dependencies: SpaceCommandDependencies, action: (connection: ServerConnection, options: SpaceOptions) => Promise<T>): Promise<T> {
  const options = asOptions(command);
  let homeDir = resolveKikiHome(options.home);
  if (options.space && options.space !== 'main') {
    const records = await readFile(join(homeDir, 'homes.json'), 'utf8').then((text) => JSON.parse(text) as { id: string; path: string }[], (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const matched = records.find((record) => record.id === options.space);
    if (matched) homeDir = matched.path;
  }
  const connection = await (dependencies.ensureServer ?? ensureServer)({ homeDir });
  return action(connection, options);
}

function outputReceipt(value: unknown, options: SpaceOptions, dependencies: SpaceCommandDependencies): void {
  writeJson(value, dependencies, options.json === true);
}

async function confirm(message: string, dependencies: SpaceCommandDependencies): Promise<void> {
  if (dependencies.confirm !== undefined) {
    if (!await dependencies.confirm(message)) throw new Error('Portable Space operation cancelled.');
    return;
  }
  const input = dependencies.stdin ?? process.stdin;
  if ((input as NodeJS.ReadStream).isTTY !== true) throw new Error('Portable Space operation requires confirmation; pass --yes in non-interactive use.');
  const io = createInterface({ input: input as never, output: (dependencies.stderr ?? process.stderr) as never });
  try {
    const answer = await io.question(`${message} [y/N] `);
    if (!/^y(?:es)?$/iu.test(answer.trim())) throw new Error('Portable Space operation cancelled.');
  } finally { io.close(); }
}

async function previewRequest(
  connection: ServerConnection,
  input: PortableSpacePreviewInput,
  dependencies: SpaceCommandDependencies,
): Promise<ReturnType<typeof portableSpacePreviewResultSchema.parse>> {
  return portableSpaceRequest(connection, 'preview', {
    method: 'POST',
    body: portableSpacePreviewInputSchema.parse(input),
    parse: portableSpacePreviewResultSchema,
    fetch: dependencies.fetch,
  });
}

function displayPreview(result: ReturnType<typeof portableSpacePreviewResultSchema.parse>, dependencies: SpaceCommandDependencies, stat = false): void {
  const output = outputFor(dependencies).stdout;
  output.write(`Mode: ${result.mode}\n`);
  output.write(`Sources: ${result.sourceLabels.join(', ')}\nTarget: ${result.targetLabel}\n`);
  output.write(`Changes: ${result.rows.filter((row) => row.change !== 'unchanged').length}; conflicts: ${result.conflictCount}; unchanged: ${result.unchangedCount}\n`);
  for (const row of result.rows) {
    if (row.change === 'unchanged') continue;
    const suffix = stat || row.diffPreview === undefined ? '' : `\n${row.diffPreview}`;
    output.write(`${row.change} ${row.domain}/${row.path}${row.blockedReason === undefined ? '' : ` — ${row.blockedReason}`}${suffix}\n`);
  }
  for (const error of result.dependencyErrors) output.write(`error: ${error}\n`);
}

function previewInputFromOptions(sourceValues: readonly (string | PortableSpaceEndpoint)[], options: SpaceOptions, targetValue?: string | PortableSpaceEndpoint): PortableSpacePreviewInput {
  const values = sourceValues.length === 0 ? (options.sources ?? []) : sourceValues;
  const sources = values.length === 0
    ? [parsePortableEndpoint(undefined, { kind: 'live' })]
    : values.map((entry) => typeof entry === 'string' ? endpointFromOption(entry, options) : entry);
  return portableSpacePreviewInputSchema.parse(compactObject({
    mode: options.override ? 'override' : options.replace ? 'replace' : options.merge ? 'merge' : options.mode,
    sources,
    target: typeof targetValue === 'string' ? endpointFromOption(targetValue, options) : targetValue ?? endpointFromOption(options.target, options),
    base: options.base === undefined ? undefined : endpointFromOption(options.base, options),
    domains: domainsOf(options),
    pick: nonEmpty(options.pick),
    prefer: options.prefer,
    targetPlatform: options.platform,
    sourceUnlocks: unlockFromOptions(options) === undefined ? undefined : sources.map(() => unlockFromOptions(options)),
    targetUnlock: unlockFromOptions(options),
    baseUnlock: unlockFromOptions(options),
  }));
}

function endpointNeedsSourceLookup(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return false;
  const raw = value.trim();
  if (raw === 'main' || /^h-[a-z0-9-]+$/u.test(raw)) return false;
  if (/^(?:live|dir|archive|git):/u.test(raw) || raw.startsWith('github:') || raw.startsWith('git@') || raw.startsWith('ssh://') || raw.startsWith('git://') || raw.startsWith('http://') || raw.startsWith('https://')) return false;
  if (isArchivePath(raw) || isAbsolute(raw) || raw.startsWith('./') || raw.startsWith('../') || raw.includes('/') || raw.includes('\\')) return false;
  return true;
}

async function resolveEndpointReference(
  connection: ServerConnection,
  value: string | undefined,
  options: SpaceOptions,
  dependencies: SpaceCommandDependencies,
): Promise<PortableSpaceEndpoint> {
  if (!endpointNeedsSourceLookup(value)) return endpointFromOption(value, options);
  const listed = await portableSpaceRequest(connection, 'sources', { parse: portableSpaceSourcesListResponseSchema, fetch: dependencies.fetch });
  const record = listed.items.find((item) => item.id === value || item.label === value);
  return record?.endpoint ?? endpointFromOption(value, options);
}

async function resolveEndpointReferences(
  connection: ServerConnection,
  values: readonly (string | PortableSpaceEndpoint)[],
  options: SpaceOptions,
  dependencies: SpaceCommandDependencies,
): Promise<PortableSpaceEndpoint[]> {
  return Promise.all(values.map((value) => typeof value === 'string' ? resolveEndpointReference(connection, value, options, dependencies) : Promise.resolve(value)));
}

function exportInputFromOptions(source: string | undefined, destination: string, options: SpaceOptions): PortableSpaceExportInput {
  return portableSpaceExportInputSchema.parse(compactObject({
    source: endpointFromOption(source ?? options.source, options),
    destination,
    format: options.plain ? 'dir' : options.format,
    spaceMode: options.overlay ? 'overlay' : 'full',
    secretMode: secretMode(options),
    encryption: sealForExport(options),
    domains: domainsOf(options),
    pick: nonEmpty(options.pick),
    unset: nonEmpty(options.unset),
    sessions: sessionSelection(options.includeSessions),
    includeMemories: options.memories !== false && options.includeMemories !== false,
    gitInit: options.gitInit === true,
    targetPlatform: options.platform,
    sourceUnlock: unlockFromOptions(options),
  }));
}

async function withArchiveOutput<T>(
  destination: string,
  suffix: string,
  action: (serverDestination: string, temporaryRoot: string) => Promise<{ readonly value: T; readonly archivePath?: string }>,
  dependencies: SpaceCommandDependencies,
): Promise<T> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kiki-space-cli-'));
  try {
    const serverDestination = destination === '-' ? join(temporaryRoot, `output${suffix}`) : resolveLocalPath(destination);
    const result = await action(serverDestination, temporaryRoot);
    if (destination === '-') {
      const archivePath = result.archivePath ?? serverDestination;
      await writeBinary(archivePath, outputFor(dependencies).stdout);
      outputFor(dependencies).stderr.write(`${JSON.stringify(result.value)}\n`);
    }
    return result.value;
  } finally { await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 }); }
}

async function stageStdin(temporaryRoot: string, suffix: string, dependencies: SpaceCommandDependencies): Promise<string> {
  const path = join(temporaryRoot, `stdin${suffix}`);
  await pipeline(dependencies.stdin ?? process.stdin, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
  return path;
}

async function runExport(source: string | undefined, destination: string, command: Command, dependencies: SpaceCommandDependencies): Promise<void> {
  const options = asOptions(command);
  if (!destination || (destination === '-' && (options.plain || options.format === 'dir'))) throw new Error('Export requires a destination; stdout requires an archive format.');
  await withArchiveOutput(destination, options.format === 'age' || sealForExport(options) ? '.age' : '.tgz', async (serverDestination) => withConnection(command, dependencies, async (connection) => {
    const input = exportInputFromOptions(source, serverDestination, options);
    const receipt = await portableSpaceRequest(connection, 'export', { method: 'POST', body: input, parse: portableSpaceExportReceiptSchema, fetch: dependencies.fetch });
    const displayed = destination === '-' ? { ...receipt, destination: '-' } : receipt;
    return { value: displayed, archivePath: serverDestination };
  }), dependencies).then((receipt) => { if (destination !== '-') outputReceipt(receipt, options, dependencies); });
}

async function runPackUnpack(action: 'pack' | 'unpack', source: string, destination: string, command: Command, dependencies: SpaceCommandDependencies): Promise<void> {
  const options = asOptions(command);
  const inputSuffix = action === 'unpack' ? (options.format === 'age' ? '.age' : '.tgz') : '';
  const outputSuffix = action === 'pack' ? (options.format === 'age' ? '.age' : '.tgz') : '';
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kiki-space-cli-'));
  try {
    const sourcePath = source === '-' ? await stageStdin(temporaryRoot, inputSuffix, dependencies) : resolveLocalPath(source);
    const destinationPath = destination === '-' ? join(temporaryRoot, `output${outputSuffix}`) : resolveLocalPath(destination);
    const input: PortableSpacePackUnpackInput = portableSpacePackUnpackInputSchema.parse(compactObject({
      action,
      sourcePath,
      destinationPath,
      format: options.format ?? (action === 'unpack' ? archiveFormat(sourcePath) : archiveFormat(destinationPath)),
      secretMode: secretMode(options) ?? (action === 'unpack' ? 'sealed' : undefined),
      encryption: encryptionFromOptions(options),
      unlock: unlockFromOptions(options),
    }));
    const receipt = await withConnection(command, dependencies, (connection) => portableSpaceRequest(connection, action, { method: 'POST', body: input, parse: portableSpaceExportReceiptSchema, fetch: dependencies.fetch }));
    if (destination === '-') {
      await writeBinary(destinationPath, outputFor(dependencies).stdout);
      outputFor(dependencies).stderr.write(`${JSON.stringify({ ...receipt, destination: '-' })}\n`);
    } else outputReceipt(receipt, options, dependencies);
  } finally { await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 }); }
}

async function runPreview(sourceValues: readonly string[], target: string | undefined, command: Command, dependencies: SpaceCommandDependencies): Promise<void> {
  const options = asOptions(command);
  const result = await withConnection(command, dependencies, async (connection) => {
    const resolvedSources = await resolveEndpointReferences(connection, sourceValues.length === 0 ? (options.sources ?? []) : sourceValues, options, dependencies);
    const resolvedTarget = await resolveEndpointReference(connection, target ?? options.to ?? options.target, options, dependencies);
    return previewRequest(connection, previewInputFromOptions(resolvedSources, { ...options, mode: options.mode ?? 'sync' }, resolvedTarget), dependencies);
  });
  if (options.json === true) outputReceipt(result, options, dependencies);
  else displayPreview(result, dependencies, options.stat);
}

async function runApply(sourceValues: readonly (string | PortableSpaceEndpoint)[], target: string | PortableSpaceEndpoint | undefined, command: Command, dependencies: SpaceCommandDependencies, forcedMode?: 'sync' | 'override'): Promise<void> {
  await withConnection(command, dependencies, async (connection, options) => {
    const temporaryRoot = sourceValues.includes('-') ? await mkdtemp(join(tmpdir(), 'kiki-space-stdin-')) : undefined;
    try {
      const staged = temporaryRoot ? await stageStdin(temporaryRoot, '.tgz', dependencies) : undefined;
      const sources = sourceValues.map((source) => source === '-' ? { kind: 'archive' as const, path: staged! } : source);
      if (sourceValues.filter((source) => source === '-').length > 1) throw new Error('Read an archive from stdin only once');
      const targetRef = target ?? options.to ?? options.target;
      const resolvedTarget = typeof targetRef === 'object' ? targetRef : await resolveEndpointReference(connection, targetRef, options, dependencies);
      const resolvedSources = await resolveEndpointReferences(connection, sources.length > 0 ? sources : options.sources ?? [], options, dependencies);
      let token = options.previewToken;
      if (token === undefined) {
        const direct = previewInputFromOptions(resolvedSources, forcedMode === undefined ? options : { ...options, mode: forcedMode }, resolvedTarget);
        const preview = await previewRequest(connection, direct, dependencies);
        if (options.dryRun) {
          if (options.json) outputReceipt(preview, options, dependencies);
          else displayPreview(preview, dependencies, options.stat);
          return;
        }
        if (!options.json && !options.yes) displayPreview(preview, dependencies, options.stat);
        if (options.yes !== true) await confirm(`Apply ${preview.rows.filter((row) => row.selected).length} portable Space changes?`, dependencies);
        token = preview.previewToken;
      } else if (options.dryRun) throw new Error('Dry run requires source endpoints, not a preview token');
      const input: PortableSpaceApplyInput = portableSpaceApplyInputSchema.parse({
        previewToken: token, selectedIds: options.selected, createBackup: options.backup !== false, targetEncryption: encryptionFromOptions(options),
      });
      outputReceipt(await portableSpaceRequest(connection, 'apply', { method: 'POST', body: input, parse: portableSpaceApplyReceiptSchema, fetch: dependencies.fetch }), options, dependencies);
    } finally { if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

async function runFork(source: string, destination: string, command: Command, dependencies: SpaceCommandDependencies): Promise<void> {
  const options = asOptions(command);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kiki-space-cli-'));
  try {
    const outputPath = destination === '-' ? join(temporaryRoot, `fork.${options.format === 'age' || sealForExport(options) ? 'age' : 'tgz'}`) : resolveLocalPath(destination);
    const input = portableSpaceForkInputSchema.parse(compactObject({
      source: endpointFromOption(source, options),
      destination: outputPath,
      format: options.format,
      overlay: options.overlay === true,
      secretMode: secretMode(options),
      encryption: sealForExport(options),
      domains: domainsOf(options),
      pick: nonEmpty(options.pick),
      unset: nonEmpty(options.unset),
      includeMemories: options.memories !== false && options.includeMemories !== false,
      sourceUnlock: unlockFromOptions(options),
    }));
    const receipt = await withConnection(command, dependencies, (connection) => portableSpaceRequest(connection, 'fork', { method: 'POST', body: input, parse: portableSpaceExportReceiptSchema, fetch: dependencies.fetch }));
    if (destination === '-') {
      await writeBinary(outputPath, outputFor(dependencies).stdout);
      outputFor(dependencies).stderr.write(`${JSON.stringify({ ...receipt, destination: '-' })}\n`);
    } else outputReceipt(receipt, options, dependencies);
  } finally { await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 }); }
}

async function runDelta(source: string | undefined, since: string, destination: string, command: Command, dependencies: SpaceCommandDependencies): Promise<void> {
  const options = asOptions(command);
  if (destination === '') throw new Error('Delta export requires a destination path; pass a positional destination or --output <path> or - for stdout.');
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kiki-space-cli-'));
  try {
    const outputPath = destination === '-' ? join(temporaryRoot, `delta.${options.format === 'age' || sealForExport(options) ? 'age' : 'tgz'}`) : resolveLocalPath(destination);
    const input = portableSpaceDeltaInputSchema.parse(compactObject({
      source: endpointFromOption(source ?? options.source, options),
      since: endpointFromOption(since, options),
      destination: outputPath,
      format: options.format,
      encryption: sealForExport(options),
      domains: domainsOf(options),
      sessions: sessionSelection(options.includeSessions),
      sourceUnlock: unlockFromOptions(options),
      sinceUnlock: unlockFromOptions(options),
    }));
    const receipt = await withConnection(command, dependencies, (connection) => portableSpaceRequest(connection, 'delta', { method: 'POST', body: input, fetch: dependencies.fetch }));
    if (destination === '-') {
      await writeBinary(outputPath, outputFor(dependencies).stdout);
      outputFor(dependencies).stderr.write(`${JSON.stringify({ ...(typeof receipt === 'object' && receipt !== null ? receipt : {}), destination: '-' })}\n`);
    } else outputReceipt(receipt, options, dependencies);
  } finally { await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 }); }
}

async function runMutation(targetValue: string | undefined, actions: readonly PortableSpaceMutateAction[], command: Command, dependencies: SpaceCommandDependencies): Promise<void> {
  const options = asOptions(command);
  const input = portableSpaceMutateInputSchema.parse({
    target: endpointFromOption(targetValue ?? options.target, options),
    actions,
    unlock: unlockFromOptions(options),
    encryption: encryptionFromOptions(options),
  });
  const result = await withConnection(command, dependencies, (connection) => portableSpaceRequest(connection, 'mutate', { method: 'POST', body: input, parse: portableSpaceMutateReceiptSchema, fetch: dependencies.fetch }));
  outputReceipt(result, options, dependencies);
}

async function runEdit(targetValue: string, subpath: string | undefined, command: Command, dependencies: SpaceCommandDependencies): Promise<void> {
  const options = asOptions(command);
  const target = endpointFromOption(targetValue, options);
  if (target.kind === 'git') throw new Error('Edit a local checkout instead of the Git URL.');
  const file = (subpath ?? 'config.toml').replaceAll('\\', '/');
  if (isAbsolute(file) || file.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':'))) throw new Error('Editor subpath must be relative to the portable Space');
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kiki-space-edit-'));
  try {
    await withConnection(command, dependencies, async (connection) => {
      const unlock = unlockFromOptions(options);
      if (target.kind === 'archive') {
        await portableSpaceRequest(connection, 'unpack', { method: 'POST', body: { action: 'unpack', sourcePath: target.path, destinationPath: temporaryRoot, secretMode: 'plain', unlock }, parse: portableSpaceExportReceiptSchema, fetch: dependencies.fetch });
      } else {
        const inspect = await portableSpaceRequest(connection, 'inspect', { method: 'POST', body: { endpoint: target, unlock }, parse: portableSpaceInspectResultSchema, fetch: dependencies.fetch });
        await portableSpaceRequest(connection, 'export', { method: 'POST', body: { source: target, destination: temporaryRoot, format: 'dir', secretMode: 'plain', spaceMode: inspect.spaceMode, unset: inspect.unset, sourceUnlock: unlock }, parse: portableSpaceExportReceiptSchema, fetch: dependencies.fetch });
      }
      const destination = options.dir && subpath === undefined ? temporaryRoot : join(temporaryRoot, file);
      if (destination !== temporaryRoot) {
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, '', { flag: 'wx', mode: 0o600 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      }
      const before = new Map<string, Buffer>();
      await readPortableFiles(temporaryRoot, before);
      const editor = resolveEditorCommand(options.editor);
      if (dependencies.editor) await dependencies.editor(destination, editor ?? '');
      else {
        if (!editor) throw new Error('No editor configured; set VISUAL or EDITOR, or pass --editor.');
        await launchEditor(destination, editor);
      }
      const after = new Map<string, Buffer>();
      await readPortableFiles(temporaryRoot, after);
      if (canonicalTreeDigest(before) === canonicalTreeDigest(after)) {
        outputFor(dependencies).stdout.write('No changes; archive untouched\n');
        return;
      }
      const actions = buildMutationActions(before, after);
      if (!options.yes && !options.apply) await confirm(`Save ${actions.length} edited portable files?`, dependencies);
      const receipt = await portableSpaceRequest(connection, 'mutate', { method: 'POST', body: { target, actions, unlock, encryption: encryptionFromOptions(options) }, parse: portableSpaceMutateReceiptSchema, fetch: dependencies.fetch });
      if (!receipt.changed) outputFor(dependencies).stdout.write('No changes; archive untouched\n');
      else outputReceipt(receipt, options, dependencies);
      if (options.apply && target.kind !== 'live' && receipt.changed) {
        const input = previewInputFromOptions([target], { ...options, mode: 'override' });
        const applied = await portableSpaceRequest(connection, 'apply', { method: 'POST', body: { direct: input, createBackup: true }, parse: portableSpaceApplyReceiptSchema, fetch: dependencies.fetch });
        outputReceipt(applied, options, dependencies);
      }
    });
  } finally { await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 }); }
}

async function readPortableFiles(root: string, result: Map<string, Buffer>, prefix = ''): Promise<void> {
  const entries = (await readdir(root, { withFileTypes: true })).toSorted((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (['.git', '.gitignore', '.gitattributes', '.kiki-fork-base.json', 'node_modules'].includes(entry.name)) continue;
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const path = join(root, entry.name);
    if (entry.isDirectory()) await readPortableFiles(path, result, relative);
    else if (entry.isFile()) result.set(relative.replaceAll('\\', '/'), await readFile(path));
  }
}

export function canonicalTreeDigest(files: ReadonlyMap<string, Uint8Array>): string {
  const hash = createHash('sha256');
  for (const [path, content] of [...files.entries()].toSorted(([left], [right]) => left.localeCompare(right))) {
    hash.update(path);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function parseAssignments(values: readonly string[]): PortableSpaceMutateAction[] {
  if (values.length === 0) throw new Error('At least one key=value assignment is required.');
  return values.map((entry) => {
    const separator = entry.indexOf('=');
    if (separator <= 0) throw new Error(`Expected key=value assignment, got ${entry}.`);
    return { op: 'set', key: entry.slice(0, separator), value: parseJsonValue(entry.slice(separator + 1)) };
  });
}

function parseCopySpec(value: string): { readonly endpoint: string; readonly path?: string } {
  const separator = value.lastIndexOf(':');
  const prefix = value.slice(0, separator);
  if (separator <= 0 || separator === value.length - 1 || /^(?:[A-Za-z]|live|dir|archive|git|github|ssh|https?)$/u.test(prefix) || /:[A-Za-z]$/u.test(prefix)) return { endpoint: value };
  return { endpoint: prefix, path: value.slice(separator + 1) };
}

function buildMutationActions(before: ReadonlyMap<string, Buffer>, after: ReadonlyMap<string, Buffer>): PortableSpaceMutateAction[] {
  const actions: PortableSpaceMutateAction[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].toSorted()) {
    const oldBytes = before.get(path);
    const newBytes = after.get(path);
    if (newBytes === undefined) {
      if (oldBytes !== undefined) actions.push({ op: 'rm', paths: [path] });
    } else if (oldBytes === undefined || !oldBytes.equals(newBytes)) {
      actions.push({ op: 'writeFile', path, contentBase64: newBytes.toString('base64') });
    }
  }
  return actions;
}

async function launchEditor(directory: string, editor: string): Promise<void> {
  const code = await new Promise<number>((resolveCode, reject) => {
    const child = spawn(`${editor} ${quoteShellArg(directory)}`, { shell: true, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (exitCode) => resolveCode(exitCode ?? 1));
  });
  if (code !== 0) throw new Error(`Editor exited with code ${code}.`);
}

async function runRekey(target: string, outputPath: string | undefined, command: Command, dependencies: SpaceCommandDependencies): Promise<void> {
  const options = asOptions(command);
  const encryption = sealForExport(options);
  if (!encryption) throw new Error('Rekey requires --recipient or --passphrase.');
  const input = portableSpaceRekeyInputSchema.parse(compactObject({
    target: resolveLocalPath(target),
    outputPath: outputPath === undefined ? undefined : resolveLocalPath(outputPath),
    unlock: { identity: options.identity, passphrase: options.unlockPassphrase ?? (options.encryptPassphrase ? unlockFromOptions(options)?.passphrase : undefined) },
    encryption,
  }));
  const result = await withConnection(command, dependencies, (connection) => portableSpaceRequest(connection, 'rekey', { method: 'POST', body: input, parse: portableSpaceInspectResultSchema, fetch: dependencies.fetch }));
  outputReceipt(result, options, dependencies);
}

const INSTALL_SCRIPT_URL = 'https://raw.githubusercontent.com/X-T-E-R/kiki/kiki/scripts/install.sh';

async function remoteCommand(program: string, args: string[], archive?: string, outputArchive?: string): Promise<string> {
  const bashCcp = process.platform === 'win32' && program === 'ccp';
  const child = spawn(bashCcp ? 'bash.exe' : program, bashCcp ? ['-lc', 'exec ccp "$@"', 'ccp', ...args] : args, {
    stdio: [archive ? 'pipe' : 'ignore', 'pipe', 'inherit'], windowsHide: true,
  });
  const exitPromise = new Promise<void>((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', (code, signal) => {
      if (code === 0) resolveExit();
      else rejectExit(new Error(`${program} exited with ${code ?? signal}`));
    });
  });
  const readStdout = outputArchive !== undefined
    ? (async () => {
      let size = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          if (size > 128 * 1024 * 1024) {
            child.kill();
            done(new Error('Remote archive output exceeds 128 MiB'));
          } else {
            done(null, chunk);
          }
        },
      });
      await pipeline(child.stdout!, limit, createWriteStream(outputArchive, { flags: 'wx', mode: 0o600 }));
      return '';
    })()
    : new Promise<string>((resolveStdout, rejectStdout) => {
      const stdout: Buffer[] = [];
      let length = 0;
      child.stdout!.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > 1024 * 1024) { child.kill(); rejectStdout(new Error('Remote command output exceeds 1 MiB')); }
        else stdout.push(chunk);
      });
      child.stdout!.once('error', rejectStdout);
      child.stdout!.once('end', () => { resolveStdout(Buffer.concat(stdout).toString('utf8')); });
    });
  const [, stdout] = await Promise.all([
    exitPromise,
    readStdout,
    archive ? pipeline(createReadStream(archive), child.stdin!) : undefined,
  ]);
  return stdout;
}

function isRemoteTarget(value: string | undefined): value is string {
  return value !== undefined && (value.startsWith('ccp:') || value.startsWith('ssh://'));
}

async function resolveRemoteTarget(
  remote: string,
  run: (program: string, args: string[], archive?: string, outputArchive?: string) => Promise<string>,
): Promise<{
  readonly invoke: (script: string, archive?: string, outputArchive?: string) => Promise<string>;
  readonly ready: string;
}> {
  if (remote.startsWith('ccp:')) {
    const runtime = remote.slice(4);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runtime)) throw new Error('Invalid CCP runtime ID');
    const result = JSON.parse(await run('ccp', ['ssh', 'prepare', runtime])) as { id?: string };
    const id = result.id;
    if (!id || !/^ssh_[A-Za-z0-9]+$/.test(id)) throw new Error('CCP did not return an SSH session ID');
    return {
      invoke: (script, archive, outputArchive) => run('ccp', ['ssh', 'connect', id, '--command', script], archive, outputArchive),
      ready: `ccp ssh connect ${id}`,
    };
  }
  const target = new URL(remote);
  if (target.protocol !== 'ssh:' || target.password || target.search || target.hash || !['', '/'].includes(target.pathname) || !/^(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9a-fA-F:]+\])$/.test(target.hostname) || !/^[\w.-]*$/.test(target.username) || target.username.startsWith('-')) {
    throw new Error('Remote target expects ssh://[user@]host[:port] or ccp:<runtimeId>');
  }
  const host = `${target.username ? `${target.username}@` : ''}${target.hostname}`;
  const args = [...target.port ? ['-p', target.port] : [], '--', host];
  return {
    invoke: (script, archive, outputArchive) => run('ssh', ['-T', ...args, script], archive, outputArchive),
    ready: `ssh -t ${args.join(' ')}`,
  };
}

async function runClone(remote: string, command: Command, dependencies: SpaceCommandDependencies): Promise<void> {
  const options = asOptions(command);
  const run = dependencies.runRemote ?? remoteCommand;
  const channel = options.channel ?? 'beta';
  if (channel !== 'stable' && channel !== 'beta') throw new Error('Clone channel must be stable or beta');
  const { invoke, ready } = await resolveRemoteTarget(remote, run);
  const path = 'export PATH="$HOME/.local/bin:$PATH"; ';
  const bootstrap = `${path}if ! command -v kiki >/dev/null 2>&1; then setup=$(mktemp) && curl -fsSL ${INSTALL_SCRIPT_URL} -o "$setup" && sh "$setup" --channel ${channel} >&2; status=$?; rm -f "$setup"; [ "$status" -eq 0 ] || exit "$status"; fi; exec kiki space key show --json`;
  const keys = portableSpaceSourcesListResponseSchema.parse(JSON.parse(await invoke(bootstrap)));
  const root = await mkdtemp(join(tmpdir(), 'kiki-space-clone-'));
  try {
    const destination = join(root, 'clone.kiki.age');
    const sessionId = options.session === 'current' ? process.env['KIKI_SESSION_ID'] : options.session;
    const sessions = sessionId ? { mode: 'ids', sessionIds: [sessionId] } : options.session === 'current' ? { mode: 'recent', count: 1 } : { mode: 'none' };
    const domains = domainsOf(options);
    const input = portableSpaceExportInputSchema.parse({
      source: endpointFromOption(undefined, options), destination, format: 'age', secretMode: secretMode(options) ?? 'sealed',
      encryption: { mode: 'x25519', recipients: [keys.deviceRecipient] }, domains: options.session && domains && !domains.includes('sessions') ? [...domains, 'sessions'] : domains,
      sessions, includeMemories: options.memories !== false, targetPlatform: options.platform,
    });
    await withConnection(command, dependencies, (connection) => portableSpaceRequest(connection, 'export', { method: 'POST', body: input, parse: portableSpaceExportReceiptSchema, fetch: dependencies.fetch }));
    const result = await invoke(`${path}exec kiki space apply - --override --yes --json`, destination);
    portableSpaceApplyReceiptSchema.parse(JSON.parse(result));
    outputFor(dependencies).stdout.write(`${ready}\n`);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
}

function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runRemotePull(remote: string, target: string | undefined, command: Command, dependencies: SpaceCommandDependencies): Promise<void> {
  const options = asOptions(command);
  const run = dependencies.runRemote ?? remoteCommand;
  const localKeys = await withConnection(command, dependencies, (connection) =>
    portableSpaceRequest(connection, 'sources', { parse: portableSpaceSourcesListResponseSchema, fetch: dependencies.fetch }),
  );
  if (!/^age1[a-z0-9]+$/.test(localKeys.deviceRecipient)) {
    throw new Error('Local Kiki server did not return a valid age device recipient.');
  }
  const { invoke } = await resolveRemoteTarget(remote, run);
  const path = 'export PATH="$HOME/.local/bin:$PATH"; ';
  const exportArgs = ['kiki', 'space', 'export', '-', '--format', 'age', '--recipient', localKeys.deviceRecipient];
  const domains = domainsOf(options);
  if (domains !== undefined) {
    for (const domain of domains) exportArgs.push('--only', domain);
  }
  const sessions = sessionSelection(options.includeSessions);
  if (sessions.mode === 'recent') {
    exportArgs.push('--include-sessions', `recent:${sessions.count}`);
  }
  if (options.memories === false || options.includeMemories === false) {
    exportArgs.push('--no-memories');
  }
  if (options.credentials === false) {
    exportArgs.push('--no-credentials');
  }
  const script = `${path}exec ${exportArgs.map(quotePosixShellArg).join(' ')}`;
  const root = await mkdtemp(join(tmpdir(), 'kiki-space-pull-'));
  try {
    const archivePath = join(root, 'pull.kiki.age');
    await invoke(script, undefined, archivePath);
    await runApply([archivePath], target, command, dependencies);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

function addSourceOptions(command: Command): Command {
  return commonOptions(command)
    .option('--source <source>', 'Source endpoint; may be repeated.', collect, [])
    .option('--target <target>', 'Target endpoint.')
    .option('--base <source>', 'Three-way merge base endpoint.')
    .option('--mode <mode>', 'Merge mode: merge, override, replace, or sync.')
    .option('--override', 'Use override mode.')
    .option('--replace', 'Replace selected domains.')
    .option('--merge', 'Add non-conflicting changes.')
    .option('--to <target>', 'Target portable endpoint.')
    .option('--dry-run', 'Show the preview without writing.')
    .option('--no-backup', 'Skip the live Home backup.')
    .option('--domain <domain>', 'Portable domain; may be repeated.', collect, [])
    .option('--pick <id>', 'Select one item; may be repeated.', collect, [])
    .option('--prefer <side>', 'Conflict preference: left or right.')
    .option('--include-sessions [selection]', 'Include recent sessions; optionally use recent:<count>.')
    .option('--include-memories', 'Include memories.', true)
    .option('--git-init', 'Initialize a destination Git repository.')
    .option('--subpath <path>', 'Git repository subpath.');
}

export function registerSpaceCommand(program: Command, dependencies: SpaceCommandDependencies = {}): Command {
  const space = program.command('space').description('Inspect, export, merge, edit, and synchronize portable Kiki Spaces.').option('--home <dir>', 'Kiki home directory.');
  const sources = space.command('sources').description('Manage registered portable Space sources.');
  commonOptions(sources.command('list').description('List registered sources and age recipients.')).action(async (_options: SpaceOptions, command: Command) => {
    await withConnection(command, dependencies, async (connection) => outputReceipt(await portableSpaceRequest(connection, 'sources', { parse: portableSpaceSourcesListResponseSchema, fetch: dependencies.fetch }), asOptions(command), dependencies));
  });
  commonOptions(space.command('list').description('List registered portable Space sources.')).action(async (_options: SpaceOptions, command: Command) => {
    await withConnection(command, dependencies, async (connection) => outputReceipt(await portableSpaceRequest(connection, 'sources', { parse: portableSpaceSourcesListResponseSchema, fetch: dependencies.fetch }), asOptions(command), dependencies));
  });
  commonOptions(space.command('inspect [source]').description('Inspect a portable Space without changing it.')).action(async (source: string | undefined, _options: SpaceOptions, command: Command) => {
    await withConnection(command, dependencies, async (connection) => {
      const options = asOptions(command);
      const body = portableSpaceInspectInputSchema.parse({ endpoint: endpointFromOption(source ?? options.source, options), unlock: unlockFromOptions(options) });
      outputReceipt(await portableSpaceRequest(connection, 'inspect', { method: 'POST', body, parse: portableSpaceInspectResultSchema, fetch: dependencies.fetch }), options, dependencies);
    });
  });
  commonOptions(space.command('export <dest>').description('Export a Space to a directory or archive.'))
    .option('--source <endpoint>', 'Read a portable endpoint instead of the live Home.')
    .option('--plain', 'Export a portable directory.')
    .option('--overlay', 'Write an overlay manifest.')
    .option('--unset <key>', 'Record an overlay removal.', collect, [])
    .option('--pick <id>', 'Select one item.', collect, [])
    .option('--include-sessions [selection]', 'Include recent sessions; optionally use recent:<count>.')
    .option('--git-init', 'Initialize a destination Git worktree.')
    .action(async (destination: string, _options: SpaceOptions, command: Command) => runExport(undefined, destination, command, dependencies));
  addSourceOptions(space.command('diff <left> [right]').description('Preview portable Space changes without applying them.')).option('--stat', 'Show change counts and paths only.').action(async (left: string, right: string | undefined, _options: SpaceOptions, command: Command) => runPreview([left], right, command, dependencies));
  addSourceOptions(space.command('apply [sources...]').description('Preview and apply portable Space layers.')).option('--preview-token <token>', 'Apply an existing preview token.').option('--selected <id>', 'Apply only this preview item.', collect, []).action(async (sources: string[], _options: SpaceOptions, command: Command) => runApply(sources, undefined, command, dependencies));
  addSourceOptions(space.command('sync [left] [right]').description('Preview and apply a bidirectional synchronization merge.')).option('--selected <id>', 'Apply only this preview item.', collect, []).action(async (left: string | undefined, right: string | undefined, _options: SpaceOptions, command: Command) => runApply([left ?? await defaultLinked(command)], right, command, dependencies, 'sync'));
  commonOptions(space.command('pack <source> <destination>').description('Pack a directory into an age or tgz archive.')).action(async (source: string, destination: string, _options: SpaceOptions, command: Command) => runPackUnpack('pack', source, destination, command, dependencies));
  commonOptions(space.command('unpack <source> <destination>').description('Unpack an archive; credentials are sealed by default.')).action(async (source: string, destination: string, _options: SpaceOptions, command: Command) => runPackUnpack('unpack', source, destination, command, dependencies));
  commonOptions(space.command('fork <source> <destination>').description('Fork a Space into a new directory or archive.')).option('--overlay', 'Fork as an overlay.').option('--domain <domain>', 'Portable domain; may be repeated.', collect, []).option('--pick <id>', 'Select one item; may be repeated.', collect, []).option('--unset <key>', 'Record an overlay unset; may be repeated.', collect, []).action(async (source: string, destination: string, _options: SpaceOptions, command: Command) => runFork(source, destination, command, dependencies));
  commonOptions(space.command('clone <remoteTarget>').description('Install Kiki if needed and hydrate an SSH or CCP host.')).option('--session <current|id>', 'Carry one session.').option('--channel <channel>', 'Installer channel: stable or beta.').action(async (remote: string, _options: SpaceOptions, command: Command) => runClone(remote, command, dependencies));
  commonOptions(space.command('link <source>').description('Register a portable Space source.')).option('--label <name>', 'Source label.').option('--link-to <spaceId>', 'Link this source to a live Space.').action(async (source: string, _options: SpaceOptions, command: Command) => {
    const options = asOptions(command);
    await withConnection(command, dependencies, async (connection) => {
      const body = compactObject({
        label: options.label,
        endpoint: endpointFromOption(source, options),
        linkToSpaceId: options.linkTo ?? options.space ?? 'main',
        unlock: unlockFromOptions(options),
      });
      outputReceipt(await portableSpaceRequest(connection, 'sources', { method: 'POST', body, fetch: dependencies.fetch }), options, dependencies);
    });
  });
  commonOptions(space.command('unlink <id>').description('Remove a registered portable Space source.')).action(async (id: string, _options: SpaceOptions, command: Command) => {
    const options = asOptions(command);
    await withConnection(command, dependencies, async (connection) => outputReceipt(await portableSpaceRequest(connection, `sources/${encodeURIComponent(id)}`, { method: 'DELETE', fetch: dependencies.fetch }), options, dependencies));
  });
  async function defaultLinked(command: Command): Promise<PortableSpaceEndpoint> {
    return withConnection(command, dependencies, async (connection, options) => {
      const result = await portableSpaceRequest(connection, 'sources', { parse: portableSpaceSourcesListResponseSchema, fetch: dependencies.fetch });
      const linked = result.items.filter((item) => item.linkedSpaceId === (options.space ?? 'main'));
      if (linked.length !== 1) throw new Error('Specify a source ID unless exactly one source is linked to this Home');
      return linked[0]!.endpoint;
    });
  }
  addSourceOptions(space.command('pull [id] [target]').description('Pull a linked Space, or an SSH/CCP remote Space, into the live Home.')).action(async (source: string | undefined, target: string | undefined, _options: SpaceOptions, command: Command) => {
    if (isRemoteTarget(source)) {
      await runRemotePull(source, target, command, dependencies);
      return;
    }
    await runApply([source ?? await defaultLinked(command)], target, command, dependencies);
  });
  addSourceOptions(space.command('push [id] [source]').description('Push the live Home to a linked Space.')).option('--branch <branch>', 'Explicit Git branch for a Git push.').action(async (id: string | undefined, source: string | undefined, _options: SpaceOptions, command: Command) => {
    const options = asOptions(command);
    const target = id === undefined ? await defaultLinked(command) : await withConnection(command, dependencies, (connection) => resolveEndpointReference(connection, id, options, dependencies));
    if (target.kind === 'git' && options.branch === undefined) throw new Error('Git push requires an explicit --branch.');
    await runApply([source ?? endpointFromOption(undefined, options)], target.kind === 'git' ? { ...target, ref: options.branch } : target, command, dependencies, 'override');
  });
  commonOptions(space.command('delta [source]').description('Export the delta since a previous Space snapshot.')).requiredOption('--since <source>', 'Previous Space snapshot endpoint.').option('--include-sessions [selection]', 'Include recent sessions; optionally use recent:<count>.').option('-o, --output <path>', 'Destination path; - streams an archive to stdout.').option('--domain <domain>', 'Portable domain; may be repeated.', collect, []).action(async (source: string | undefined, _options: SpaceOptions, command: Command) => {
    const options = asOptions(command);
    const destination = options.output ?? source ?? '';
    await runDelta(options.output === undefined ? undefined : source, options.since!, destination, command, dependencies);
  });
  commonOptions(space.command('set <target> <assignments...>').description('Set portable configuration values as key=value assignments.')).action(async (target: string, assignments: string[], _options: SpaceOptions, command: Command) => runMutation(target, parseAssignments(assignments), command, dependencies));
  commonOptions(space.command('unset <target> <keys...>').description('Unset portable configuration keys.')).option('--overlay', 'Record an overlay unset marker.').action(async (target: string, keys: string[], _options: SpaceOptions, command: Command) => runMutation(target, keys.map((key) => ({ op: 'unset', key, recordOverlayUnset: asOptions(command).overlay === true })), command, dependencies));
  commonOptions(space.command('rm <target> <paths...>').description('Remove portable files from a target.')).action(async (target: string, paths: string[], _options: SpaceOptions, command: Command) => runMutation(target, [{ op: 'rm', paths }], command, dependencies));
  commonOptions(space.command('cp <from> <to>').description('Copy a portable item between endpoints.')).option('--from-identity <key>', 'Unlock the copy source with a separate identity.').option('--from-passphrase <value>', 'Unlock the copy source with a separate passphrase.').action(async (from: string, to: string, _options: SpaceOptions, command: Command) => {
    const options = asOptions(command);
    const sourceSpec = parseCopySpec(from);
    const targetSpec = parseCopySpec(to);
    if (sourceSpec.path === undefined) throw new Error('Copy source must use endpoint:path syntax.');
    await runMutation(targetSpec.endpoint, [{
      op: 'cp',
      from: endpointFromOption(sourceSpec.endpoint, options),
      fromPath: sourceSpec.path,
      toPath: targetSpec.path,
      fromUnlock: options.fromIdentity || options.fromPassphrase ? { identity: options.fromIdentity, passphrase: options.fromPassphrase } : unlockFromOptions(options),
    }], command, dependencies);
  });
  commonOptions(space.command('edit <target> [subpath]').description('Edit an unpacked Space with an external editor and write only canonical changes.')).option('--editor <command>', 'Editor command; defaults to VISUAL or EDITOR.').option('--dir', 'Treat the target as a directory.').option('--apply', 'Apply editor changes after the canonical no-churn check.').action(async (target: string, subpath: string | undefined, _options: SpaceOptions, command: Command) => runEdit(target, subpath, command, dependencies));
  commonOptions(space.command('rekey <target>').description('Re-encrypt a directory or archive with new age recipients.')).option('-o, --output <path>', 'Optional output path; defaults to replacing the target.').option('--unlock-passphrase <value>', 'Passphrase for the existing archive.').action(async (target: string, _options: SpaceOptions, command: Command) => runRekey(target, asOptions(command).output, command, dependencies));
  const key = space.command('key').description('Manage portable age recipients.');
  commonOptions(key.command('show', { isDefault: true }).description('Show the device and known age recipients.')).action(async (_options: SpaceOptions, command: Command) => {
    const options = asOptions(command);
    await withConnection(command, dependencies, async (connection) => outputReceipt(await portableSpaceRequest(connection, 'sources', { parse: portableSpaceSourcesListResponseSchema, fetch: dependencies.fetch }), options, dependencies));
  });
  commonOptions(key.command('add-recipient <recipient>').alias('add').description('Add a known age recipient.')).option('--label <name>', 'Recipient label.').action(async (recipient: string, _options: SpaceOptions, command: Command) => {
    const options = asOptions(command);
    await withConnection(command, dependencies, async (connection) => outputReceipt(await portableSpaceRequest(connection, 'recipients', { method: 'POST', body: compactObject({ recipient, label: options.label }), fetch: dependencies.fetch }), options, dependencies));
  });
  return space;
}

export const registerPortableSpaceCommands = registerSpaceCommand;
