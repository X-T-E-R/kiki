import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { isAbsolute, join } from 'pathe';

import type { ILogger } from '#/_base/log/log';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import type { BrowserTab } from '#/app/browser/browser';
import type { BrowserResolvedConnection } from '#/app/browser/browserConfig';
import { BrowserError } from '#/app/browser/errors';

import { egoChildNames, egoFileExists, egoPathDelimiter, egoPathHits, readEgoUninstallRecords, readRegisteredEgoPath } from './hints';
import { readEgoStream, runEgoDetectionCommand, type EgoDetectionOutput } from './process';
import {
  EGO_CLEANUP_TIMEOUT_MS, EGO_NAME_IN_USE, EGO_READY_MARKER, EGO_RUN_TIMEOUT_ENV, EGO_RUN_TIMEOUT_MS,
  EGO_SDK_ENV, EGO_SPACE_FILE, EGO_USER_IN_CONTROL, classifyEgoCheck, egoSpaceName, extractEgoDiagnostic,
  resolveEgoCli, type EgoCliResolution,
} from './resolveCli';
import {
  FINISH, OWNED, PAGE, PRELUDE, REFUSED, TABS, egoCleanupScript,
  egoNumericSpaceId, egoPrelude, egoProgram, type EgoBound,
} from './script';
import { analyzeEgoScriptBindings, type EgoScriptBindingAnalysis } from './scriptBindings';

export {
  EGO_CLEANUP_TIMEOUT_MS, EGO_RUN_TIMEOUT_ENV, EGO_RUN_TIMEOUT_MS, analyzeEgoScriptBindings,
  egoCleanupScript, egoNumericSpaceId, egoPrelude, egoProgram, type EgoBound, type EgoScriptBindingAnalysis,
};

export interface EgoSpaceBinding {
  readonly connectionId: string;
  readonly spaceId?: string;
  readonly name: string;
  readonly ownedSpaceIds?: readonly number[];
}

export interface EgoRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly aborted: boolean;
  readonly scriptPath: string;
  readonly argv: readonly string[];
}

const EGO_PROBE_TIMEOUT_MS = 5_000;

export class EgoProbeTimeoutError extends BrowserError {
  constructor(message: string) {
    super('browser.execution_failed', message);
  }
}

export class EgoRunTimeoutError extends BrowserError {
  constructor(message: string) {
    super('browser.execution_failed', message);
    this.name = 'EgoRunTimeoutError';
  }
}

const fileTails = new Map<string, Promise<unknown>>();

function withFile<T>(file: string, body: () => Promise<T>): Promise<T> {
  const previous = fileTails.get(file) ?? Promise.resolve();
  const run = previous.then(body, body);
  fileTails.set(file, run.then(() => undefined, () => undefined));
  return run;
}

export function egoReadyScript(): string {
  return `console.log(${JSON.stringify(EGO_READY_MARKER)});\n`;
}

export function egoImportArg(file: string): string {
  return `await import(${JSON.stringify(pathToFileURL(file).href)})`;
}

export function egoArgv(serverName: string | undefined, file: string, sdkPath?: string): string[] {
  const args: string[] = [];
  if (serverName !== undefined && serverName !== '') args.push('--ego-server-name', serverName);
  if (sdkPath !== undefined) args.push('--sdk-path', sdkPath);
  args.push('nodejs', '-e', egoImportArg(file));
  return args;
}

interface ParsedLine { readonly spaceId?: string; readonly name?: string; readonly closed?: boolean; readonly label?: string }

function parseMarker(text: string, marker: string): ParsedLine | undefined {
  const line = text.split(/\r?\n/).find((item) => item.startsWith(marker));
  if (line === undefined) return undefined;
  try {
    const value = JSON.parse(line.slice(marker.length)) as { spaceId?: unknown; name?: unknown; closed?: unknown; label?: unknown };
    const spaceId = typeof value.spaceId === 'number' && Number.isSafeInteger(value.spaceId) && value.spaceId >= 0
      ? String(value.spaceId)
      : typeof value.spaceId === 'string' && value.spaceId !== '' ? value.spaceId : undefined;
    return {
      spaceId,
      name: typeof value.name === 'string' ? value.name : undefined,
      closed: value.closed === true ? true : undefined,
      label: typeof value.label === 'string' ? value.label : undefined,
    };
  } catch {
    return undefined;
  }
}

function parseOwnedMarker(text: string): readonly number[] {
  const lines = text.split(/\r?\n/).filter((item) => item.startsWith(OWNED));
  const line = lines.at(-1);
  if (line === undefined) return [];
  try {
    const value = JSON.parse(line.slice(OWNED.length)) as { spaceIds?: unknown };
    if (!Array.isArray(value.spaceIds)) return [];
    const ids = value.spaceIds
      .map((item) => egoNumericSpaceId(item))
      .filter((item): item is number => item !== undefined);
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

export function egoOutputFlags(output: string): { readonly nameInUse: boolean; readonly userInControl: boolean; readonly sdkRejected: boolean } {
  return {
    nameInUse: output.includes(EGO_NAME_IN_USE),
    userInControl: output.includes(EGO_USER_IN_CONTROL),
    sdkRejected: /(?:^|\s)--sdk-path\b|unknown option|unrecognized option|KIKI_EGO_SDK_REJECT/i.test(output),
  };
}

function spaceFile(sessionDir: string): string {
  return join(sessionDir, EGO_SPACE_FILE);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof HostFsError && error.code === OsFsErrors.codes.OS_FS_NOT_FOUND;
}

function normalizeSpaces(parsed: unknown): Record<string, EgoSpaceBinding> | undefined {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const normalized: Record<string, EgoSpaceBinding> = {};
  for (const [key, raw] of Object.entries(parsed)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry['connectionId'] !== 'string' || typeof entry['name'] !== 'string') continue;
    const spaceId = typeof entry['spaceId'] === 'number' && Number.isSafeInteger(entry['spaceId']) && entry['spaceId'] >= 0
      ? String(entry['spaceId'])
      : typeof entry['spaceId'] === 'string' && entry['spaceId'] !== '' ? entry['spaceId'] : undefined;
    const ownedRaw = Array.isArray(entry['ownedSpaceIds'])
      ? entry['ownedSpaceIds'].map((id) => egoNumericSpaceId(id)).filter((id): id is number => id !== undefined)
      : [];
    const ownedSpaceIds = ownedRaw.length > 0 ? [...new Set(ownedRaw)] : undefined;
    normalized[key] = { connectionId: entry['connectionId'], name: entry['name'], spaceId, ownedSpaceIds };
  }
  return normalized;
}

function parseSpaces(text: string): Record<string, EgoSpaceBinding> | undefined {
  try {
    return normalizeSpaces(JSON.parse(text));
  } catch {
    return undefined;
  }
}

async function preserveCorruptSpaces(files: IHostFileSystem, file: string, text: string, log: Pick<ILogger, 'warn'> | undefined): Promise<void> {
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const backup = `${file}.corrupt-${digest}`;
  if (!await files.createExclusive(backup, new TextEncoder().encode(text))) return;
  log?.warn('Ego Lite space bindings file is corrupt; preserved a backup before rewriting it', { path: file, backup });
}

async function readSpaces(files: IHostFileSystem, sessionDir: string, log: Pick<ILogger, 'warn'> | undefined): Promise<Record<string, EgoSpaceBinding>> {
  const file = spaceFile(sessionDir);
  let text: string;
  try {
    text = await files.readText(file);
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }
  const spaces = parseSpaces(text);
  if (spaces !== undefined) return spaces;
  await preserveCorruptSpaces(files, file, text, log);
  return {};
}

async function writeSpaces(files: IHostFileSystem, sessionDir: string, value: Record<string, EgoSpaceBinding>): Promise<void> {
  if (files.replaceText === undefined) {
    throw new BrowserError('browser.execution_failed', 'Ego Lite space bindings need a host filesystem with atomic replace');
  }
  await files.mkdir(sessionDir, { recursive: true });
  await files.replaceText(spaceFile(sessionDir), `${JSON.stringify(value)}\n`);
}

function sameLease(current: EgoSpaceBinding | undefined, started: EgoSpaceBinding): current is EgoSpaceBinding {
  return current !== undefined && current.connectionId === started.connectionId && current.name === started.name
    && (current.spaceId ?? undefined) === (started.spaceId ?? undefined);
}

function mergeSignals(...signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((item): item is AbortSignal => item !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

async function listShots(files: IHostFileSystem, directory: string): Promise<readonly string[]> {
  try {
    const entries = await files.readdir(directory);
    return entries
      .filter((entry) => entry.isFile && /\.(?:png|jpe?g)$/i.test(entry.name))
      .map((entry) => join(directory, entry.name));
  } catch {
    return [];
  }
}

export class EgoBrowserRuntime {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly agentStops = new Map<string, AbortController>();

  constructor(
    private readonly processes: IHostProcessService,
    private readonly files: IHostFileSystem,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly log?: Pick<ILogger, 'warn'>,
  ) {}

  arm(connectionId: string): void {
    const current = this.agentStops.get(connectionId);
    if (current === undefined || current.signal.aborted) this.agentStops.set(connectionId, new AbortController());
  }

  abort(connectionId: string): void {
    const reason = new BrowserError('browser.disconnected', 'Ego Lite connection was disconnected');
    const current = this.agentStops.get(connectionId);
    if (current === undefined) {
      const stopped = new AbortController();
      stopped.abort(reason);
      this.agentStops.set(connectionId, stopped);
      return;
    }
    current.abort(reason);
  }

  private agentStop(connectionId: string): AbortSignal {
    const current = this.agentStops.get(connectionId);
    if (current === undefined) {
      const created = new AbortController();
      this.agentStops.set(connectionId, created);
      return created.signal;
    }
    if (current.signal.aborted) throw new BrowserError('browser.disconnected', 'Ego Lite connection is disconnected');
    return current.signal;
  }

  private resolveRunTimeoutMs(explicit?: number): number {
    if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
    const raw = this.env[EGO_RUN_TIMEOUT_ENV]?.trim();
    if (raw !== undefined && /^\d+$/.test(raw)) {
      const parsed = Number(raw);
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    }
    return EGO_RUN_TIMEOUT_MS;
  }

  async resolve(connection: BrowserResolvedConnection | undefined, signal?: AbortSignal): Promise<EgoCliResolution> {
    const exists = async (file: string): Promise<boolean> => {
      signal?.throwIfAborted();
      const found = await egoFileExists(this.files, file);
      signal?.throwIfAborted();
      return found;
    };
    const cliPath = connection?.type === 'ego-lite' ? connection.cliPath?.trim() : undefined;
    if (cliPath !== undefined && cliPath !== '' && isAbsolute(cliPath) && await exists(cliPath)) {
      return { kind: 'found', path: cliPath };
    }
    const [recordsResult, registeredResult] = await Promise.allSettled([
      readEgoUninstallRecords(this.processes, this.platform, signal),
      readRegisteredEgoPath(this.processes, this.env, this.platform, signal),
    ]);
    if (recordsResult.status === 'rejected') throw recordsResult.reason;
    if (registeredResult.status === 'rejected') throw registeredResult.reason;
    const records = recordsResult.value;
    const registered = registeredResult.value;
    signal?.throwIfAborted();
    const pathEnv = [registered, this.env['PATH']].filter((part): part is string => part !== undefined && part.trim() !== '').join(egoPathDelimiter(this.platform));
    const pathHits = await egoPathHits(pathEnv === '' ? undefined : pathEnv, exists, this.platform);
    const syncExists = new Map<string, boolean>();
    const remember = async (file: string): Promise<boolean> => {
      const known = syncExists.get(file);
      if (known !== undefined) return known;
      const found = await exists(file);
      syncExists.set(file, found);
      return found;
    };
    const locations = [...new Set(records.map((record) => record.installLocation))];
    for (const location of locations) {
      for (const child of await egoChildNames(this.files, location)) {
        await remember(join(location, child, 'ego-browser.exe'));
      }
      for (const record of records) {
        if (record.installLocation === location && record.displayVersion !== undefined) await remember(join(location, record.displayVersion, 'ego-browser.exe'));
      }
    }
    if (cliPath !== undefined) await remember(cliPath);
    for (const hit of pathHits) syncExists.set(hit, true);
    const children = new Map<string, string[]>();
    for (const location of locations) children.set(location, [...await egoChildNames(this.files, location)]);
    return resolveEgoCli({
      cliPath,
      exists: (file) => syncExists.get(file) === true,
      children: (directory) => children.get(directory) ?? [],
      records,
      pathHits,
    });
  }

  async readBinding(sessionDir: string, agentId: string): Promise<EgoSpaceBinding | undefined> {
    try {
      return (await readSpaces(this.files, sessionDir, this.log))[agentId];
    } catch {
      return undefined;
    }
  }

  private async updateSpace(
    sessionDir: string,
    agentId: string,
    started: EgoSpaceBinding,
    spaceId: string | undefined,
    createdOwned: readonly number[],
    connectionId: string,
  ): Promise<void> {
    await withFile(spaceFile(sessionDir), async () => {
      const all = await readSpaces(this.files, sessionDir, this.log);
      const current = all[agentId];
      if (current === undefined) {
        if (started.spaceId !== undefined) return;
      } else if (!sameLease(current, started)) return;
      const nextSpaceId = spaceId ?? current?.spaceId;
      const mergedOwned = [...new Set([...(current?.ownedSpaceIds ?? []), ...createdOwned])];
      const ownedSpaceIds = mergedOwned.length > 0 ? mergedOwned : undefined;
      if (nextSpaceId === undefined && ownedSpaceIds === undefined) return;
      all[agentId] = {
        connectionId: current?.connectionId ?? connectionId,
        name: started.name,
        spaceId: nextSpaceId,
        ownedSpaceIds,
      };
      await writeSpaces(this.files, sessionDir, all);
    });
  }

  private async deleteIfStarted(sessionDir: string, agentId: string, started: EgoSpaceBinding, writtenSpaceId: string | undefined): Promise<void> {
    await withFile(spaceFile(sessionDir), async () => {
      const all = await readSpaces(this.files, sessionDir, this.log);
      const current = all[agentId];
      const expected = writtenSpaceId ?? started.spaceId;
      const owned = current !== undefined && current.connectionId === started.connectionId && current.name === started.name
        && (current.spaceId ?? undefined) === (expected ?? undefined);
      if (!owned) return;
      const closedNumeric = egoNumericSpaceId(expected);
      const remaining = (current.ownedSpaceIds ?? []).filter((id) => id !== closedNumeric);
      if (remaining.length > 0) {
        all[agentId] = { connectionId: current.connectionId, name: current.name, ownedSpaceIds: remaining };
      } else {
        delete all[agentId];
      }
      await writeSpaces(this.files, sessionDir, all);
    });
  }

  private async reconcileAgentLease(
    sessionDir: string,
    agentId: string,
    started: EgoSpaceBinding,
    aliveIds: readonly number[],
  ): Promise<void> {
    await withFile(spaceFile(sessionDir), async () => {
      const all = await readSpaces(this.files, sessionDir, this.log);
      const current = all[agentId];
      if (!sameLease(current, started)) return;
      const aliveSet = new Set(aliveIds);
      const currentPrimary = egoNumericSpaceId(current.spaceId);
      const nextPrimary = currentPrimary !== undefined && aliveSet.has(currentPrimary) ? String(currentPrimary) : undefined;
      const remainingOwned = (current.ownedSpaceIds ?? []).filter((id) => aliveSet.has(id));
      const ownedSpaceIds = remainingOwned.length > 0 ? remainingOwned : undefined;
      if (nextPrimary === undefined && ownedSpaceIds === undefined) {
        delete all[agentId];
      } else {
        all[agentId] = {
          connectionId: current.connectionId,
          name: current.name,
          spaceId: nextPrimary,
          ownedSpaceIds,
        };
      }
      await writeSpaces(this.files, sessionDir, all);
    });
  }

  private lock<T>(key: string, body: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.then(body, body);
    this.tails.set(key, run.then(() => undefined, () => undefined));
    return run;
  }

  private async sdkPath(): Promise<string | undefined> {
    const value = this.env[EGO_SDK_ENV];
    if (value === undefined || value.trim() === '') return undefined;
    return await egoFileExists(this.files, value) ? value : undefined;
  }

  private async spawn(
    cli: string,
    args: readonly string[],
    signal?: AbortSignal,
    output: EgoDetectionOutput = { stdout: [], stderr: [] },
  ): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string; readonly aborted: boolean }> {
    signal?.throwIfAborted();
    const child = await this.processes.spawn(cli, args, {
      shell: false,
      windowsHide: true,
      ownedProcessTree: true,
      ownedProcessLifetime: this.platform === 'win32' && process.platform === 'win32' ? 'owner' : undefined,
    });
    const stdoutPromise = readEgoStream(child.stdout, output.stdout);
    const stderrPromise = readEgoStream(child.stderr, output.stderr);
    (child.stdin as { end?: () => void } | undefined)?.end?.();
    let cleanup: Promise<void> | undefined;
    let stop: (() => void) | undefined;
    const work = Promise.all([child.wait(), stdoutPromise, stderrPromise]);
    const cancelled = signal === undefined ? undefined : new Promise<never>((_resolve, reject) => {
      stop = () => {
        cleanup ??= child.kill().then(async () => { await child.dispose(); });
        void cleanup.then(() => {
          reject(signal.reason ?? new BrowserError('browser.execution_failed', 'Ego Lite script was cancelled'));
        }, reject);
      };
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    });
    try {
      const [code, stdout, stderr] = await (cancelled === undefined ? work : Promise.race([work, cancelled]));
      signal?.throwIfAborted();
      return { code, stdout, stderr, aborted: false };
    } catch (error) {
      if (signal?.aborted === true && cleanup !== undefined) {
        await cleanup;
        throw signal.reason ?? error;
      }
      throw error;
    } finally {
      if (stop !== undefined) signal?.removeEventListener('abort', stop);
      if (cleanup !== undefined) await cleanup;
      else await child.dispose();
    }
  }

  private async writeProgram(directory: string, source: string): Promise<string> {
    const folder = join(directory, 'ego-scripts');
    await this.files.mkdir(folder, { recursive: true });
    const file = join(folder, `${randomUUID()}.mjs`);
    await this.files.writeText(file, source);
    return file;
  }

  async run(
    cli: string,
    connection: BrowserResolvedConnection,
    directory: string,
    source: string,
    signal?: AbortSignal,
    detectionOutput?: EgoDetectionOutput,
    removeScript = detectionOutput !== undefined,
    capturedOutput?: EgoDetectionOutput,
  ): Promise<EgoRunResult> {
    const scriptPath = await this.writeProgram(directory, source);
    let cleanupConfirmed = false;
    try {
      const sdk = await this.sdkPath();
      const serverName = connection.type === 'ego-lite' ? connection.serverName : undefined;
      const execute = async (args: readonly string[]) => detectionOutput !== undefined
        ? { ...await runEgoDetectionCommand(this.processes, cli, args, signal, detectionOutput), aborted: false }
        : this.spawn(cli, args, signal, capturedOutput);
      let argv = egoArgv(serverName, scriptPath, sdk);
      let outcome = await execute(argv);
      const first = `${outcome.stdout}\n${outcome.stderr}`;
      const flags = egoOutputFlags(first);
      if (!outcome.aborted && sdk !== undefined && outcome.code !== 0 && flags.sdkRejected && !flags.nameInUse && !flags.userInControl && parseMarker(first, PRELUDE) === undefined) {
        argv = egoArgv(serverName, scriptPath);
        if (detectionOutput !== undefined) {
          detectionOutput.stdout.length = 0;
          detectionOutput.stderr.length = 0;
        }
        if (capturedOutput !== undefined) {
          capturedOutput.stdout.length = 0;
          capturedOutput.stderr.length = 0;
        }
        outcome = await execute(argv);
      }
      cleanupConfirmed = true;
      return { ...outcome, scriptPath, argv };
    } catch (error) {
      cleanupConfirmed = signal?.aborted === true && error === signal.reason;
      throw error;
    } finally {
      if (removeScript && cleanupConfirmed) await this.files.remove(scriptPath);
    }
  }

  async probe(connection: BrowserResolvedConnection, callerSignal?: AbortSignal): Promise<{ readonly resolution: EgoCliResolution; readonly output: string; readonly kind: 'ready' | 'onboarding' | 'not_ready' | 'missing' | 'choose' }> {
    const deadline = new AbortController();
    const timeoutError = new EgoProbeTimeoutError('Ego Lite probe timed out after 5000ms; check that the browser is started and onboarding is complete, then retry.');
    const captured: EgoDetectionOutput = { stdout: [], stderr: [] };
    const timer = setTimeout(() => deadline.abort(timeoutError), EGO_PROBE_TIMEOUT_MS);
    timer.unref?.();
    const signal = mergeSignals(callerSignal, deadline.signal) ?? deadline.signal;
    try {
      const resolution = await this.resolve(connection, signal);
      signal.throwIfAborted();
      if (resolution.kind !== 'found') return { resolution, output: '', kind: resolution.kind };
      const directory = join(tmpdir(), 'kiki-ego');
      const result = await this.run(resolution.path, connection, directory, egoReadyScript(), signal, captured, true);
      signal.throwIfAborted();
      const output = `${result.stdout}\n${result.stderr}`;
      if (result.aborted) throw callerSignal?.reason ?? deadline.signal.reason ?? new BrowserError('browser.execution_failed', 'Ego Lite check was cancelled');
      return { resolution, output, kind: classifyEgoCheck(output) };
    } catch (error) {
      if (error === signal.reason && error instanceof EgoProbeTimeoutError) {
        const diagnostic = extractEgoDiagnostic(`${Buffer.concat(captured.stdout).toString('utf8')}\n${Buffer.concat(captured.stderr).toString('utf8')}`);
        if (diagnostic !== undefined) error.message = `${error.message.replace(/\.$/, '')}: ${diagnostic}`;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async runAgent(input: {
    readonly connection: BrowserResolvedConnection;
    readonly sessionDir: string;
    readonly sessionId: string;
    readonly agentId: string;
    readonly label?: string;
    readonly url?: string;
    readonly body: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  }): Promise<{ readonly result: EgoRunResult; readonly binding: EgoSpaceBinding; readonly tabs?: readonly BrowserTab[]; readonly pageLabel?: string; readonly refused: boolean; readonly shots: readonly string[] }> {
    const resolution = await this.resolve(input.connection, input.signal);
    if (resolution.kind === 'missing') throw new BrowserError('browser.disconnected', 'Ego Lite is not installed');
    if (resolution.kind === 'choose') throw new BrowserError('browser.requires_action', 'Choose one Ego Lite CLI path');
    const name = egoSpaceName(input.sessionId, input.agentId);
    const stop = this.agentStop(input.connection.id);
    const key = `${input.connection.id}\0${input.sessionDir}\0${input.agentId}`;
    return this.lock(key, async () => {
      input.signal?.throwIfAborted();
      if (stop.aborted) throw stop.reason ?? new BrowserError('browser.disconnected', 'Ego Lite connection is disconnected');
      const started = (await this.readBinding(input.sessionDir, input.agentId)) ?? { connectionId: input.connection.id, name };
      return this.lock(`${input.connection.id}\0space\0${started.spaceId ?? started.name}`, async () => {
        input.signal?.throwIfAborted();
        if (stop.aborted) throw stop.reason ?? new BrowserError('browser.disconnected', 'Ego Lite connection is disconnected');
        const numericSpaceId = egoNumericSpaceId(started.spaceId);
        const bound: EgoBound = {
          spaceId: numericSpaceId,
          name: started.name,
          label: input.label !== undefined && input.label !== '' ? input.label : undefined,
          profileId: input.connection.type === 'ego-lite' ? input.connection.profileId : undefined,
          connectionId: input.connection.id,
          url: input.url,
        };
        const shotDir = join(input.sessionDir, 'ego-shots', randomUUID());
        await this.files.mkdir(shotDir, { recursive: true });
        const timeoutMs = this.resolveRunTimeoutMs(input.timeoutMs);
        const deadline = new AbortController();
        const timeoutError = new EgoRunTimeoutError(`Ego Lite script timed out after ${String(timeoutMs)}ms`);
        const captured: EgoDetectionOutput = { stdout: [], stderr: [] };
        const timer = setTimeout(() => deadline.abort(timeoutError), timeoutMs);
        timer.unref?.();
        const execSignal = mergeSignals(input.signal, stop, deadline.signal);
        let result: EgoRunResult;
        try {
          result = await this.run(
            resolution.path,
            input.connection,
            input.sessionDir,
            egoProgram(bound, input.body, shotDir),
            execSignal,
            undefined,
            false,
            captured,
          );
        } catch (error) {
          if (error === timeoutError) {
            const diagnostic = extractEgoDiagnostic(`${Buffer.concat(captured.stdout).toString('utf8')}\n${Buffer.concat(captured.stderr).toString('utf8')}`);
            if (diagnostic !== undefined) timeoutError.message = `${timeoutError.message}: ${diagnostic}`;
          }
          throw error;
        } finally {
          clearTimeout(timer);
        }
        const output = `${result.stdout}\n${result.stderr}`;
        const flags = egoOutputFlags(output);
        if (result.aborted) {
          throw (input.signal?.aborted === true ? input.signal.reason : undefined)
            ?? (deadline.signal.aborted ? deadline.signal.reason : undefined)
            ?? new BrowserError('browser.execution_failed', 'Ego Lite script was cancelled');
        }
        if (result.code !== 0) {
          if (flags.nameInUse) throw new BrowserError('browser.execution_failed', EGO_NAME_IN_USE);
          if (flags.userInControl) throw new BrowserError('browser.execution_failed', EGO_USER_IN_CONTROL);
        }
        const prelude = parseMarker(output, PRELUDE);
        const finish = parseMarker(output, FINISH);
        const createdOwned = parseOwnedMarker(output);
        let written: string | undefined;
        if ((prelude?.spaceId !== undefined && prelude.spaceId !== '') || createdOwned.length > 0) {
          const nextSpaceId = prelude?.spaceId !== undefined && prelude.spaceId !== '' ? prelude.spaceId : undefined;
          await this.updateSpace(input.sessionDir, input.agentId, started, nextSpaceId, createdOwned, input.connection.id);
          written = nextSpaceId;
        }
        if (result.code === 0 && finish?.closed === true) await this.deleteIfStarted(input.sessionDir, input.agentId, started, written);
        const binding = (await this.readBinding(input.sessionDir, input.agentId))
          ?? { ...started, spaceId: written ?? started.spaceId };
        const shots = await listShots(this.files, shotDir);
        return { result, binding, tabs: parseTabs(output), pageLabel: parseMarker(output, PAGE)?.label, refused: output.includes(REFUSED), shots };
      });
    });
  }

  async cleanupAgent(input: {
    readonly connection: BrowserResolvedConnection;
    readonly sessionDir: string;
    readonly agentId: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  }): Promise<boolean> {
    if (input.agentId === 'main' || input.agentId === '') return false;
    const key = `${input.connection.id}\0${input.sessionDir}\0${input.agentId}`;
    return this.lock(key, async () => {
      const started = await this.readBinding(input.sessionDir, input.agentId);
      if (started === undefined || started.connectionId !== input.connection.id) return false;
      const stop = this.agentStops.get(input.connection.id)?.signal;
      if (stop?.aborted === true) return false;
      const resolution = await this.resolve(input.connection, input.signal);
      if (resolution.kind !== 'found') return false;
      return this.lock(`${input.connection.id}\0space\0${started.spaceId ?? started.name}`, async () => {
        const current = await this.readBinding(input.sessionDir, input.agentId);
        if (!sameLease(current, started)) return false;
        const spaceIds = [...new Set([
          egoNumericSpaceId(current?.spaceId),
          ...(current?.ownedSpaceIds ?? []),
        ].filter((id): id is number => id !== undefined))];
        const timeoutMs = input.timeoutMs !== undefined && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
          ? Math.floor(input.timeoutMs)
          : EGO_CLEANUP_TIMEOUT_MS;
        const deadline = new AbortController();
        const timeoutError = new EgoRunTimeoutError(`Ego Lite cleanup timed out after ${String(timeoutMs)}ms`);
        const timer = setTimeout(() => deadline.abort(timeoutError), timeoutMs);
        timer.unref?.();
        const execSignal = mergeSignals(input.signal, stop, deadline.signal);
        try {
          const result = await this.run(
            resolution.path,
            input.connection,
            input.sessionDir,
            egoCleanupScript({ name: started.name, spaceIds }),
            execSignal,
            undefined,
            true,
          );
          if (result.code === 0) {
            const output = `${result.stdout}\n${result.stderr}`;
            const finish = parseMarker(output, FINISH);
            const stillAlive = finish?.closed === true ? [] : parseOwnedMarker(output);
            await this.reconcileAgentLease(input.sessionDir, input.agentId, started, stillAlive);
            return true;
          }
          return false;
        } finally {
          clearTimeout(timer);
        }
      });
    });
  }
}

function parseTabs(output: string): readonly BrowserTab[] | undefined {
  const line = output.split(/\r?\n/).find((item) => item.startsWith(TABS));
  if (line === undefined) return undefined;
  try {
    const value = JSON.parse(line.slice(TABS.length)) as unknown;
    const rows = Array.isArray(value) ? value : [];
    const byLabel = new Map<string, BrowserTab>();
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue;
      const record = row as Record<string, unknown>;
      const label = typeof record['label'] === 'string' && record['label'] !== '' ? record['label'] : undefined;
      if (label === undefined) continue;
      const prev = byLabel.get(label);
      byLabel.set(label, {
        ...prev,
        tabId: label,
        targetId: label,
        label,
        title: typeof record['title'] === 'string' ? record['title'] : prev?.title,
        url: typeof record['url'] === 'string' ? record['url'] : prev?.url,
        active: typeof record['active'] === 'boolean' ? record['active'] : prev?.active,
      });
    }
    return [...byLabel.values()];
  } catch {
    return undefined;
  }
}

export function egoTabBody(action: 'list' | 'open' | 'select' | 'close'): string {
  if (action === 'list') return `const pages = await task.pages();\nconst tabs = await task.tabs();\nconsole.log(${JSON.stringify(TABS)} + JSON.stringify([].concat(pages ?? [], tabs ?? [])));`;
  if (action === 'open') return `const opened = await task.newPage();\nif (__kikiBound.url) await opened.goto(__kikiBound.url);\nconsole.log(${JSON.stringify(PAGE)} + JSON.stringify({ label: opened && opened.label }));`;
  if (action === 'select') return `console.log(${JSON.stringify(PAGE)} + JSON.stringify({ label: __kikiBound.label }));`;
  return `const found = (await task.tabs()).find((tab) => tab && tab.label === __kikiBound.label);\nif (!found || !found.label || found.openedBy !== 'agent') console.log(${JSON.stringify(REFUSED)});\nelse { await task.page(found.label).close(); console.log(${JSON.stringify(PAGE)} + JSON.stringify({ label: found.label })); }`;
}

export function egoUserOutput(result: { readonly stdout: string; readonly stderr: string }): string {
  const isInternalMarker = (line: string): boolean =>
    line.startsWith(PRELUDE)
    || line.startsWith(FINISH)
    || line.startsWith(TABS)
    || line.startsWith(PAGE)
    || line.startsWith(OWNED)
    || line === REFUSED;
  const clean = (text: string): string =>
    text
      .split(/\r?\n/)
      .filter((line) => !isInternalMarker(line))
      .join('\n')
      .trim();
  const stdout = clean(result.stdout);
  if (stdout !== '') return stdout;
  return clean(result.stderr);
}
