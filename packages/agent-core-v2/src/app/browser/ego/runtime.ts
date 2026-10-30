import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { isAbsolute, join } from 'pathe';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import type { BrowserTab } from '#/app/browser/browser';
import type { BrowserResolvedConnection } from '#/app/browser/browserConfig';
import { BrowserError } from '#/app/browser/errors';

import { egoChildNames, egoFileExists, egoPathDelimiter, egoPathHits, readEgoUninstallRecords, readRegisteredEgoPath } from './hints';
import { runEgoDetectionCommand } from './process';
import {
  EGO_NAME_IN_USE, EGO_READY_MARKER, EGO_SDK_ENV, EGO_SPACE_FILE, EGO_USER_IN_CONTROL,
  classifyEgoCheck, egoSpaceName, resolveEgoCli, type EgoCliResolution,
} from './resolveCli';

export interface EgoBound {
  readonly spaceId?: string;
  readonly name: string;
  readonly label?: string;
  readonly profileId?: string;
  readonly connectionId: string;
  readonly url?: string;
}

export interface EgoSpaceBinding {
  readonly connectionId: string;
  readonly spaceId?: string;
  readonly name: string;
}

export interface EgoRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly aborted: boolean;
  readonly scriptPath: string;
  readonly argv: readonly string[];
}

const PRELUDE = 'KIKI_EGO_PRELUDE ';
const FINISH = 'KIKI_EGO_FINISH ';
const TABS = 'KIKI_EGO_TABS ';
const PAGE = 'KIKI_EGO_PAGE ';
const REFUSED = 'KIKI_EGO_REFUSED';
const EGO_PROBE_TIMEOUT_MS = 5_000;

const fileTails = new Map<string, Promise<unknown>>();

function withFile<T>(file: string, body: () => Promise<T>): Promise<T> {
  const previous = fileTails.get(file) ?? Promise.resolve();
  const run = previous.then(body, body);
  fileTails.set(file, run.then(() => undefined, () => undefined));
  return run;
}

export function egoPrelude(bound: EgoBound): string {
  const payload = JSON.stringify(JSON.stringify(bound));
  const open = bound.spaceId === undefined && bound.profileId !== undefined && bound.profileId !== ''
    ? 'const task = await taskSpace(__kikiBound.name, { profileId: __kikiBound.profileId });'
    : 'const task = await taskSpace(__kikiBound.spaceId ?? __kikiBound.name);';
  const lines = [
    `const __kikiBound = JSON.parse(${payload});`,
    open,
  ];
  if (bound.label !== undefined && bound.label !== '') lines.push('const page = task.page(__kikiBound.label);');
  lines.push(`console.log(${JSON.stringify(PRELUDE)} + JSON.stringify({ spaceId: task.spaceId ?? task.id, name: task.name, closed: task.closed === true }));`);
  return lines.join('\n');
}

export function egoProgram(bound: EgoBound, body: string, shotDir?: string): string {
  const shot = shotDir === undefined || shotDir === '' ? '' : `const shotDir = ${JSON.stringify(shotDir)};\n`;
  return `${egoPrelude(bound)}\n${shot}${body}\nconsole.log(${JSON.stringify(FINISH)} + JSON.stringify({ spaceId: task.spaceId ?? task.id, closed: task.closed === true }));\n`;
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
    return {
      ...(typeof value.spaceId === 'string' || typeof value.spaceId === 'number' ? { spaceId: String(value.spaceId) } : {}),
      ...(typeof value.name === 'string' ? { name: value.name } : {}),
      ...(value.closed === true ? { closed: true } : {}),
      ...(typeof value.label === 'string' ? { label: value.label } : {}),
    };
  } catch {
    return undefined;
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

async function readSpaces(files: IHostFileSystem, sessionDir: string): Promise<Record<string, EgoSpaceBinding>> {
  try {
    const parsed = JSON.parse(await files.readText(spaceFile(sessionDir))) as Record<string, EgoSpaceBinding>;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeSpaces(files: IHostFileSystem, sessionDir: string, value: Record<string, EgoSpaceBinding>): Promise<void> {
  await files.mkdir(sessionDir, { recursive: true });
  await files.writeText(spaceFile(sessionDir), `${JSON.stringify(value)}\n`);
}

function sameLease(current: EgoSpaceBinding | undefined, started: EgoSpaceBinding): boolean {
  return current !== undefined && current.connectionId === started.connectionId && current.name === started.name
    && (current.spaceId ?? undefined) === (started.spaceId ?? undefined);
}

function linkAbort(first: AbortSignal | undefined, second: AbortSignal | undefined): AbortSignal | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  const linked = new AbortController();
  const forward = (): void => {
    if (!linked.signal.aborted) linked.abort(first.aborted ? first.reason : second.reason);
  };
  if (first.aborted || second.aborted) forward();
  else {
    first.addEventListener('abort', forward, { once: true });
    second.addEventListener('abort', forward, { once: true });
  }
  return linked.signal;
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
  ) {}

  arm(connectionId: string): void {
    const current = this.agentStops.get(connectionId);
    if (current === undefined || current.signal.aborted) this.agentStops.set(connectionId, new AbortController());
  }

  abort(connectionId: string): void {
    const current = this.agentStops.get(connectionId);
    if (current === undefined) {
      const stopped = new AbortController();
      stopped.abort();
      this.agentStops.set(connectionId, stopped);
      return;
    }
    current.abort();
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
    return (await readSpaces(this.files, sessionDir))[agentId];
  }

  private async updateSpace(sessionDir: string, agentId: string, started: EgoSpaceBinding, spaceId: string, connectionId: string): Promise<void> {
    await withFile(spaceFile(sessionDir), async () => {
      const all = await readSpaces(this.files, sessionDir);
      const current = all[agentId];
      if (current === undefined) {
        if (started.spaceId !== undefined) return;
      } else if (!sameLease(current, started)) return;
      all[agentId] = { connectionId: current?.connectionId ?? connectionId, name: started.name, spaceId };
      await writeSpaces(this.files, sessionDir, all);
    });
  }

  private async deleteIfStarted(sessionDir: string, agentId: string, started: EgoSpaceBinding, writtenSpaceId: string | undefined): Promise<void> {
    await withFile(spaceFile(sessionDir), async () => {
      const all = await readSpaces(this.files, sessionDir);
      const current = all[agentId];
      const expected = writtenSpaceId ?? started.spaceId;
      const owned = current !== undefined && current.connectionId === started.connectionId && current.name === started.name
        && (current.spaceId ?? undefined) === (expected ?? undefined);
      if (!owned) return;
      delete all[agentId];
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

  private async spawn(cli: string, args: readonly string[], signal?: AbortSignal): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string; readonly aborted: boolean }> {
    signal?.throwIfAborted();
    const child = await this.processes.spawn(cli, args, { shell: false, windowsHide: true });
    (child.stdin as { end?: () => void } | undefined)?.end?.();
    let aborted = false;
    const stop = (): void => {
      aborted = true;
      void child.kill().catch(() => undefined);
    };
    if (signal !== undefined) {
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }
    try {
      const stdoutPromise = readAll(child.stdout);
      const stderrPromise = readAll(child.stderr);
      const code = await child.wait();
      return { code, stdout: await stdoutPromise, stderr: await stderrPromise, aborted: aborted || signal?.aborted === true };
    } finally {
      signal?.removeEventListener('abort', stop);
      await child.dispose();
    }
  }

  private async writeProgram(directory: string, source: string): Promise<string> {
    const folder = join(directory, 'ego-scripts');
    await this.files.mkdir(folder, { recursive: true });
    const file = join(folder, `${randomUUID()}.mjs`);
    await this.files.writeText(file, source);
    return file;
  }

  async run(cli: string, connection: BrowserResolvedConnection, directory: string, source: string, signal?: AbortSignal, detection = false): Promise<EgoRunResult> {
    const scriptPath = await this.writeProgram(directory, source);
    let cleanupConfirmed = false;
    try {
      const sdk = await this.sdkPath();
      const serverName = connection.type === 'ego-lite' ? connection.serverName : undefined;
      const execute = async (args: readonly string[]) => detection
        ? { ...await runEgoDetectionCommand(this.processes, cli, args, signal), aborted: false }
        : this.spawn(cli, args, signal);
      let argv = egoArgv(serverName, scriptPath, sdk);
      let outcome = await execute(argv);
      const first = `${outcome.stdout}\n${outcome.stderr}`;
      const flags = egoOutputFlags(first);
      if (!outcome.aborted && sdk !== undefined && outcome.code !== 0 && flags.sdkRejected && !flags.nameInUse && !flags.userInControl && parseMarker(first, PRELUDE) === undefined) {
        argv = egoArgv(serverName, scriptPath);
        outcome = await execute(argv);
      }
      cleanupConfirmed = true;
      return { ...outcome, scriptPath, argv };
    } catch (error) {
      cleanupConfirmed = signal?.aborted === true && error === signal.reason;
      throw error;
    } finally {
      if (detection && cleanupConfirmed) await this.files.remove(scriptPath);
    }
  }

  async probe(connection: BrowserResolvedConnection, callerSignal?: AbortSignal): Promise<{ readonly resolution: EgoCliResolution; readonly output: string; readonly kind: 'ready' | 'onboarding' | 'not_ready' | 'missing' | 'choose' }> {
    const deadline = new AbortController();
    const timeoutError = new BrowserError('browser.execution_failed', 'Ego Lite probe timed out after 5000ms; check that the browser is started and onboarding is complete, then retry.');
    const timer = setTimeout(() => deadline.abort(timeoutError), EGO_PROBE_TIMEOUT_MS);
    timer.unref?.();
    const signal = linkAbort(callerSignal, deadline.signal) ?? deadline.signal;
    try {
      const resolution = await this.resolve(connection, signal);
      signal.throwIfAborted();
      if (resolution.kind !== 'found') return { resolution, output: '', kind: resolution.kind };
      const directory = join(tmpdir(), 'kiki-ego');
      const result = await this.run(resolution.path, connection, directory, egoReadyScript(), signal, true);
      signal.throwIfAborted();
      const output = `${result.stdout}\n${result.stderr}`;
      if (result.aborted) throw callerSignal?.reason ?? deadline.signal.reason ?? new BrowserError('browser.execution_failed', 'Ego Lite check was cancelled');
      return { resolution, output, kind: classifyEgoCheck(output) };
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
  }): Promise<{ readonly result: EgoRunResult; readonly binding: EgoSpaceBinding; readonly tabs?: readonly BrowserTab[]; readonly pageLabel?: string; readonly refused: boolean; readonly shots: readonly string[] }> {
    const resolution = await this.resolve(input.connection);
    if (resolution.kind === 'missing') throw new BrowserError('browser.disconnected', 'Ego Lite is not installed');
    if (resolution.kind === 'choose') throw new BrowserError('browser.requires_action', 'Choose one Ego Lite CLI path');
    const name = egoSpaceName(input.sessionId, input.agentId);
    const stop = this.agentStop(input.connection.id);
    const key = `${input.connection.id}\0${input.sessionDir}\0${input.agentId}`;
    return this.lock(key, async () => {
      const started = (await this.readBinding(input.sessionDir, input.agentId)) ?? { connectionId: input.connection.id, name };
      return this.lock(`${input.connection.id}\0space\0${started.spaceId ?? started.name}`, async () => {
        const bound: EgoBound = {
          ...(started.spaceId !== undefined ? { spaceId: started.spaceId } : {}),
          name: started.name,
          ...(input.label !== undefined && input.label !== '' ? { label: input.label } : {}),
          ...(input.connection.type === 'ego-lite' && input.connection.profileId !== undefined ? { profileId: input.connection.profileId } : {}),
          connectionId: input.connection.id,
          ...(input.url !== undefined ? { url: input.url } : {}),
        };
        const shotDir = join(input.sessionDir, 'ego-shots', randomUUID());
        await this.files.mkdir(shotDir, { recursive: true });
        const result = await this.run(resolution.path, input.connection, input.sessionDir, egoProgram(bound, input.body, shotDir), linkAbort(input.signal, stop));
        const output = `${result.stdout}\n${result.stderr}`;
        const flags = egoOutputFlags(output);
        if (result.aborted) throw (input.signal?.aborted === true ? input.signal.reason : undefined) ?? new BrowserError('browser.execution_failed', 'Ego Lite script was cancelled');
        if (result.code !== 0) {
          if (flags.nameInUse) throw new BrowserError('browser.execution_failed', EGO_NAME_IN_USE);
          if (flags.userInControl) throw new BrowserError('browser.execution_failed', EGO_USER_IN_CONTROL);
        }
        const prelude = parseMarker(output, PRELUDE);
        const finish = parseMarker(output, FINISH);
        let written: string | undefined;
        if (prelude?.spaceId !== undefined && prelude.spaceId !== '') {
          await this.updateSpace(input.sessionDir, input.agentId, started, prelude.spaceId, input.connection.id);
          written = prelude.spaceId;
        }
        if (result.code === 0 && finish?.closed === true) await this.deleteIfStarted(input.sessionDir, input.agentId, started, written);
        const binding = (await this.readBinding(input.sessionDir, input.agentId)) ?? { ...started, ...(written !== undefined ? { spaceId: written } : {}) };
        const shots = await listShots(this.files, shotDir);
        return { result, binding, tabs: parseTabs(output), pageLabel: parseMarker(output, PAGE)?.label, refused: output.includes(REFUSED), shots };
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
        ...(typeof record['title'] === 'string' ? { title: record['title'] } : {}),
        ...(typeof record['url'] === 'string' ? { url: record['url'] } : {}),
        ...(typeof record['active'] === 'boolean' ? { active: record['active'] } : {}),
      });
    }
    return [...byLabel.values()];
  } catch {
    return undefined;
  }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
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
