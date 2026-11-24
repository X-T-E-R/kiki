import { basename, dirname, join, normalize } from 'pathe';
import { gte, parse, type SemVer } from 'semver';

import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';

import {
  ANTIGRAVITY_IDE_NOT_ACP,
  executorSourceId,
  type AgentExecutorBinarySource,
  type AgentExecutorDescriptor,
  type AgentExecutorSourceProbe,
} from './agentExecutor';
import { ANTIGRAVITY_CLI_ACP_ARGS, ANTIGRAVITY_CLI_MIN_VERSION } from './antigravityDistribution';
import { isAntigravityIdeArtifact } from '#/os/backends/node-local/antigravityHostOps';
import type { ExecutorCapabilityDimension } from '@kiki/agent-profiles/ports';
import { executorProcessOptions, redactExecutorOutput } from './executorOverrides';

interface ProbeResult {
  readonly available: boolean;
  readonly version?: string;
  readonly code?: number;
  readonly output: string;
  readonly truncated?: boolean;
}

export async function discoverExecutorSources(
  descriptor: AgentExecutorDescriptor,
  processService: IHostProcessService,
  fs: IHostFileSystem,
  bootstrap: IBootstrapService,
): Promise<readonly AgentExecutorSourceProbe[]> {
  if (descriptor.sources === undefined || descriptor.sources.length === 0) {
    return probeDescriptorCommand(descriptor, processService);
  }
  const results: AgentExecutorSourceProbe[] = [];
  for (const source of descriptor.sources) {
    results.push(await probeSource(source, descriptor, processService, fs, bootstrap, true));
  }
  return results;
}

export async function discoverExecutorMetadata(
  descriptor: AgentExecutorDescriptor,
  fs: IHostFileSystem,
  bootstrap: IBootstrapService,
): Promise<readonly AgentExecutorSourceProbe[]> {
  const sources: readonly AgentExecutorBinarySource[] = descriptor.sources?.length ? descriptor.sources : descriptor.command === undefined ? []
    : [/[\\/]/.test(descriptor.command) ? { id: 'command', kind: 'explicit-path', path: descriptor.command }
      : { id: 'command', kind: 'path-lookup', command: descriptor.command }];
  return Promise.all(sources.filter(source => descriptor.source === undefined || source.id === descriptor.source)
    .map(async (source): Promise<AgentExecutorSourceProbe> => {
    try {
      if (source.kind === 'node-script') {
        const script = expandPath(source.path, bootstrap);
        const exists = await isFile(fs, script, true);
        const command = exists ? await nodeRuntime(fs, bootstrap, true) : undefined;
        return { id: source.id, kind: source.kind, available: command !== undefined,
          command, launchArgs: [script], diagnostic: command === undefined ? 'Adapter script or Node runtime is missing' : undefined,
          diagnosticCode: command !== undefined ? undefined : exists ? 'not_on_path' : 'path_not_found' };
      }
      const commands = (await sourceCommands(source, fs, bootstrap, true))
        .filter((command) => !(executorSourceId(descriptor) === 'antigravity-acp' && source.id === 'kiki-managed-cli' && !isOfficialAntigravityBinaryName(command)))
        .toSorted(compareExecutorBinaryPaths);
      let sawIde = false;
      for (const command of commands.toReversed()) {
        if (!await isFile(fs, command, true)) continue;
        if (executorSourceId(descriptor) === 'antigravity-acp') {
          const managed = await inspectManagedOfficialAntigravityCandidate(command, fs, true);
          if (managed !== undefined) {
            return { id: source.id, kind: source.kind, available: true, command, launchArgs: ANTIGRAVITY_CLI_ACP_ARGS, version: managed.version };
          }
          if (await isAntigravityIdeCandidate(command, fs, bootstrap.platform, true)) {
            sawIde = true;
            continue;
          }
          if (isLegacyAntigravityServerName(command)) {
            const sibling = join(dirname(command), command.endsWith('.exe') ? 'localharness_external.exe' : 'localharness_external');
            if (!await isFile(fs, sibling, true)) continue;
            return { id: source.id, kind: source.kind, available: true, command, launchArgs: bootstrap.platform === 'linux' ? ['--uid='] : [] };
          }
          if (source.id === 'kiki-managed-cli') continue;
          return { id: source.id, kind: source.kind, available: true, command, launchArgs: ANTIGRAVITY_CLI_ACP_ARGS };
        }
        return { id: source.id, kind: source.kind, available: true, command };
      }
      if (sawIde) {
        return {
          id: source.id,
          kind: source.kind,
          available: false,
          diagnostic: ANTIGRAVITY_IDE_DIAGNOSTIC,
          diagnosticCode: ANTIGRAVITY_IDE_NOT_ACP,
        };
      }
      const envUnset = source.kind === 'env' && !bootstrap.getEnv(source.name)?.trim();
      return { id: source.id, kind: source.kind, available: false,
        diagnostic: source.kind === 'env' && !envUnset ? `The path in ${source.name} does not exist` : unavailableDiagnostic(source, bootstrap),
        diagnosticCode: source.kind === 'path-lookup' ? 'not_on_path' : source.kind === 'glob' ? 'no_glob_match'
          : envUnset ? 'env_unset' : 'path_not_found' };
    } catch {
      return { id: source.id, kind: source.kind, available: false,
        diagnostic: 'Installed engine metadata could not be read', diagnosticCode: 'metadata_unreadable' };
    }
  }));
}

export async function resolveExecutorSource(
  descriptor: AgentExecutorDescriptor,
  processService: IHostProcessService,
  fs: IHostFileSystem,
  bootstrap: IBootstrapService,
): Promise<readonly AgentExecutorSourceProbe[]> {
  if (descriptor.sources === undefined || descriptor.sources.length === 0) {
    return probeDescriptorCommand(descriptor, processService);
  }
  const sources = descriptor.source === undefined
    ? descriptor.sources
    : descriptor.sources.filter((source) => source.id === descriptor.source);
  const results: AgentExecutorSourceProbe[] = [];
  for (const source of sources) {
    const result = await probeSource(source, descriptor, processService, fs, bootstrap, false);
    results.push(result);
    if (result.available) break;
  }
  return results;
}

export function selectExecutorSource(
  descriptor: AgentExecutorDescriptor,
  probes: readonly AgentExecutorSourceProbe[],
): AgentExecutorSourceProbe | undefined {
  if (descriptor.source === undefined) return probes.find((probe) => probe.available);
  return probes.find((probe) => probe.id === descriptor.source && probe.available);
}

export interface ExecutorModelProbeResult {
  readonly models: ExecutorCapabilityDimension;
  readonly programVersion?: string;
  readonly command?: string;
}

export async function probeExecutorModelCatalog(
  descriptor: AgentExecutorDescriptor,
  selected: AgentExecutorSourceProbe | undefined,
  processService: IHostProcessService,
  fs: IHostFileSystem,
  bootstrap: IBootstrapService,
): Promise<ExecutorModelProbeResult> {
  const probe = descriptor.modelProbe;
  if (probe === undefined) return { models: { state: 'unknown', diagnostic: 'No model probe is configured' } };
  const configuredCommand = probe.command ?? selected?.command ?? descriptor.command;
  if (configuredCommand === undefined) {
    return { models: { state: 'unavailable', diagnostic: 'No executable is available for the model probe' } };
  }
  const command = await locateCommand(configuredCommand, fs, bootstrap);
  if (command === undefined) {
    return { models: { state: 'unavailable', diagnostic: 'Model probe executable is unavailable' }, command: configuredCommand };
  }
  const launchPrefix = probe.command === undefined ? [...selected?.launchArgs ?? []] : [];
  const programVersion = probe.versionProbe === undefined ? undefined : await probeProgramVersion(
    processService,
    command,
    [...launchPrefix, ...probe.versionProbe.args],
    descriptor,
    probe.timeoutMs,
    probe.maxOutputBytes,
  );
  const args = [...launchPrefix, ...probe.args];
  const result = await probeCommand(
    processService,
    command,
    args,
    descriptor,
    { timeoutMs: probe.timeoutMs, maxOutputBytes: probe.maxOutputBytes, stdoutOnly: true },
  );
  if (!result.available) return { models: { state: 'unavailable', diagnostic: 'Model probe could not start' }, command, programVersion };
  if (result.code !== 0) {
    return { models: { state: 'unavailable', diagnostic: `Model probe exited with code ${String(result.code)}` }, command, programVersion };
  }
  const values = parseModelProbeOutput(result.output, probe.format, probe.jsonPath);
  if (values.length === 0) {
    return {
      models: { state: 'partial', diagnostic: result.truncated === true ? 'Model probe output was truncated' : 'Model probe returned no model identifiers' },
      command,
      programVersion,
    };
  }
  return {
    models: {
      state: result.truncated === true ? 'partial' : 'ready',
      values,
      diagnostic: result.truncated === true ? 'Model probe output was truncated' : undefined,
    },
    command,
    programVersion,
  };
}

async function probeProgramVersion(
  processService: IHostProcessService,
  command: string,
  args: readonly string[],
  descriptor: AgentExecutorDescriptor,
  timeoutMs: number | undefined,
  maxOutputBytes: number | undefined,
): Promise<string | undefined> {
  const result = await probeCommand(processService, command, args, descriptor, {
    timeoutMs,
    maxOutputBytes,
    stdoutOnly: true,
  });
  return result.available && result.code === 0 ? firstLine(result.output) : undefined;
}

export function parseModelProbeOutput(output: string, format: 'lines' | 'tab' | 'columns' | 'json', jsonPath: readonly string[] = []): readonly string[] {
  const values = new Set<string>();
  let lines: readonly string[];
  if (format === 'json') {
    let parsed: unknown;
    try { parsed = JSON.parse(output); } catch { return []; }
    for (const key of jsonPath) {
      if (parsed === null || typeof parsed !== 'object' || !Object.hasOwn(parsed, key)) return [];
      parsed = (parsed as Record<string, unknown>)[key];
    }
    if (!Array.isArray(parsed)) return [];
    lines = parsed.flatMap((entry: unknown) => {
      const id = typeof entry === 'string' ? entry : entry !== null && typeof entry === 'object'
        ? (entry as Record<string, unknown>)['id'] : undefined;
      return typeof id === 'string' ? [id] : [];
    });
  } else lines = output.split(/\r?\n/u);
  for (const line of lines) {
    const field = format === 'tab' ? line.split('\t', 1)[0] ?? ''
      : format === 'columns' ? line.trim().split(/\s+/u)[0] ?? ''
        : line;
    const first = field.trim();
    if (first === '' || (format !== 'json' && (first.startsWith('#') || /^(?:id|model|models|name)$/iu.test(first)))) continue;
    if (first.length > 256 || /\s/u.test(first)) continue;
    values.add(first);
  }
  return [...values];
}

async function probeDescriptorCommand(
  descriptor: AgentExecutorDescriptor,
  processService: IHostProcessService,
): Promise<readonly AgentExecutorSourceProbe[]> {
  if (descriptor.command === undefined) return [];
  const probe = await probeCommand(
    processService,
    descriptor.command,
    descriptor.versionProbe?.args ?? ['--version'],
    descriptor,
  );
  return [{
    id: 'command',
    kind: 'path-lookup',
    available: probe.available && probe.code === 0,
    command: descriptor.command,
    version: firstLine(probe.output),
    diagnostic: probe.available
      ? probe.code === 0 ? undefined : `version probe exited with code ${String(probe.code)}`
      : 'not found or not executable',
  }];
}

async function probeSource(
  source: AgentExecutorBinarySource,
  descriptor: AgentExecutorDescriptor,
  processService: IHostProcessService,
  fs: IHostFileSystem,
  bootstrap: IBootstrapService,
  exhaustive: boolean,
): Promise<AgentExecutorSourceProbe> {
  if (source.kind === 'node-script') return probeNodeScript(source, descriptor, processService, fs, bootstrap);
  const rawCommands = await sourceCommands(source, fs, bootstrap);
  const commands = executorSourceId(descriptor) === 'antigravity-acp' && source.id === 'kiki-managed-cli'
    ? rawCommands.filter(isOfficialAntigravityBinaryName)
    : rawCommands;
  if (commands.length === 0) {
    return {
      id: source.id,
      kind: source.kind,
      available: false,
      diagnostic: unavailableDiagnostic(source, bootstrap),
    };
  }
  const selectedCommands = source.kind === 'glob' && !exhaustive
    ? [commands.toSorted(compareExecutorBinaryPaths).at(-1)!]
    : commands;
  const candidates = await Promise.all(selectedCommands.map(async (command) => {
    if (executorSourceId(descriptor) === 'antigravity-acp') {
      const managed = await inspectManagedOfficialAntigravityCandidate(command, fs);
      if (managed !== undefined) {
        return {
          command,
          launchArgs: ANTIGRAVITY_CLI_ACP_ARGS,
          diagnosticCode: undefined as string | undefined,
          probe: { available: true, code: 0, output: managed.version },
        };
      }
      if (await isAntigravityIdeCandidate(command, fs, bootstrap.platform)) {
        return {
          command,
          launchArgs: undefined as readonly string[] | undefined,
          diagnosticCode: ANTIGRAVITY_IDE_NOT_ACP as string | undefined,
          probe: { available: false, code: undefined, output: ANTIGRAVITY_IDE_DIAGNOSTIC },
        };
      }
      if (isLegacyAntigravityServerName(command)) {
        const sibling = join(dirname(command), command.endsWith('.exe') ? 'localharness_external.exe' : 'localharness_external');
        if (!await isFile(fs, sibling)) {
          return {
            command,
            launchArgs: undefined as readonly string[] | undefined,
            diagnosticCode: undefined as string | undefined,
            probe: {
              available: false,
              code: undefined,
              output: 'Antigravity ACP installation is incomplete: localharness_external is missing.',
            },
          };
        }
        const cachedVersion = basename(dirname(dirname(command)));
        return {
          command,
          launchArgs: bootstrap.platform === 'linux' ? ['--uid='] : [],
          diagnosticCode: undefined as string | undefined,
          probe: { available: true, code: 0, output: parse(cachedVersion)?.version ?? '' },
        };
      }
      if (source.id === 'kiki-managed-cli') {
        return {
          command,
          launchArgs: undefined as readonly string[] | undefined,
          diagnosticCode: undefined as string | undefined,
          probe: {
            available: false,
            code: undefined,
            output: 'Antigravity CLI managed installation is incomplete: .install-complete.json is missing or invalid.',
          },
        };
      }
      const probe = await probeCommand(processService, command, descriptor.versionProbe?.args ?? ['--version'], descriptor);
      const version = probeSemver(probe.output, command);
      const supported = probe.available && probe.code === 0 && version !== null && gte(version, ANTIGRAVITY_CLI_MIN_VERSION);
      return {
        command,
        launchArgs: ANTIGRAVITY_CLI_ACP_ARGS,
        diagnosticCode: undefined as string | undefined,
        probe: {
          ...probe,
          code: supported ? probe.code : -1,
          output: supported
            ? version.version
            : `Antigravity CLI ${ANTIGRAVITY_CLI_MIN_VERSION} or newer is required for native agy acp; installed: ${version?.version ?? firstLine(probe.output) ?? 'unknown'}.`,
        },
      };
    }
    return {
      command,
      launchArgs: undefined as readonly string[] | undefined,
      diagnosticCode: undefined as string | undefined,
      probe: await probeCommand(processService, command,
        descriptor.versionProbe?.args ?? ['--version'], descriptor),
    };
  }));
  const available = candidates.filter((candidate) => candidate.probe.available && candidate.probe.code === 0);
  if (available.length === 0) {
    const first = candidates[0];
    return {
      id: source.id,
      kind: source.kind,
      available: false,
      command: first?.command,
      version: firstLine(first?.probe.output ?? ''),
      diagnosticCode: first?.diagnosticCode,
      diagnostic: executorSourceId(descriptor) === 'antigravity-acp' && first?.probe.output
        ? first.probe.output : first?.probe.available === true
          ? `version probe exited with code ${String(first.probe.code)}`
          : 'not found or not executable',
    };
  }
  const selected = source.kind === 'glob' && exhaustive
    ? available.toSorted((left, right) => compareExecutorBinaryCandidates(
        { command: left.command, output: left.probe.output },
        { command: right.command, output: right.probe.output },
      )).at(-1)!
    : available[0]!;
  return {
    id: source.id,
    kind: source.kind,
    available: true,
    command: selected.command,
    launchArgs: selected.launchArgs,
    version: firstLine(selected.probe.output),
  };
}

async function probeNodeScript(
  source: Extract<AgentExecutorBinarySource, { kind: 'node-script' }>,
  descriptor: AgentExecutorDescriptor,
  processService: IHostProcessService,
  fs: IHostFileSystem,
  bootstrap: IBootstrapService,
): Promise<AgentExecutorSourceProbe> {
  const script = expandPath(source.path, bootstrap);
  const base = { id: source.id, kind: source.kind, launchArgs: [script] } as const;
  if (!await isFile(fs, script)) return { ...base, available: false, diagnostic: `${script} does not exist` };
  const node = await nodeRuntime(fs, bootstrap);
  if (node === undefined) return { ...base, available: false, diagnostic: 'node was not found on PATH' };
  const probe = await probeCommand(
    processService,
    node,
    [script, ...descriptor.versionProbe?.args ?? ['--version']],
    descriptor,
  );
  const version = firstLine(probe.output);
  if (!probe.available || probe.code !== 0) {
    return {
      ...base,
      available: false,
      command: node,
      version,
      diagnosticCode: descriptor.instance?.configuration.kind === 'plugin_account' && executorSourceId(descriptor) === 'agy-cli' && probe.available
        ? 'instance_agy_bridge_update' : undefined,
      diagnostic: probe.available ? descriptor.instance?.configuration.kind === 'plugin_account' && executorSourceId(descriptor) === 'agy-cli'
        ? 'Update the AGY bridge before using plugin accounts.' : `version probe exited with code ${String(probe.code)}` : 'node is not executable',
    };
  }
  return { ...base, available: true, command: node, version };
}

async function nodeRuntime(fs: IHostFileSystem, bootstrap: IBootstrapService, strict = false): Promise<string | undefined> {
  if (stripExecutableExtension(basename(process.execPath)).toLowerCase() === 'node') return normalize(process.execPath);
  return lookupPath('node', fs, bootstrap, strict);
}

/** Resolves a bare command name the way the host PATH would, for display and for probes that need a path. */
export async function locateCommand(
  command: string,
  fs: IHostFileSystem,
  bootstrap: IBootstrapService,
  strict = false,
): Promise<string | undefined> {
  if (/[\\/]/.test(command)) return await isFile(fs, command, strict) ? normalize(command) : undefined;
  return lookupPath(command, fs, bootstrap, strict);
}

/** Expands `${NAME}` in display text such as an install command; `${KIKI_HOME}` is the resolved Kiki home. */
export function expandExecutorText(value: string, bootstrap: IBootstrapService): string {
  return value.replaceAll(/\$\{([^}]+)\}/g, (_match, name: string) =>
    (name === 'KIKI_HOME' ? bootstrap.homeDir : bootstrap.getEnv(name)) ?? `\${${name}}`);
}

async function sourceCommands(
  source: AgentExecutorBinarySource,
  fs: IHostFileSystem,
  bootstrap: IBootstrapService,
  strict = false,
): Promise<readonly string[]> {
  if (source.kind === 'env') {
    const value = bootstrap.getEnv(source.name)?.trim();
    return value === undefined || value.length === 0 ? [] : [expandPath(value, bootstrap)];
  }
  if (source.kind === 'explicit-path') {
    const path = expandPath(source.path, bootstrap);
    return await isFile(fs, path, strict) ? [path] : [];
  }
  if (source.kind === 'path-lookup') {
    const path = await lookupPath(source.command, fs, bootstrap, strict);
    if (path === undefined) return [];
    if (
      source.requiredBasename !== undefined &&
      stripExecutableExtension(basename(path)).toLowerCase() !== source.requiredBasename.toLowerCase()
    ) {
      return [];
    }
    return [path];
  }
  if (source.kind === 'node-script') return [];
  return expandGlob(expandPath(source.pattern, bootstrap), fs, source.maxDepth ?? 8, strict);
}

async function lookupPath(
  command: string,
  fs: IHostFileSystem,
  bootstrap: IBootstrapService,
  strict = false,
): Promise<string | undefined> {
  const pathValue = bootstrap.getEnv('PATH') ?? bootstrap.getEnv('Path') ?? '';
  const separator = bootstrap.platform === 'win32' ? ';' : ':';
  const extensions = bootstrap.platform === 'win32'
    ? (bootstrap.getEnv('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  const hasExtension = /\.[^/\\]+$/.test(command);
  for (const root of pathValue.split(separator).filter(Boolean)) {
    const commands = hasExtension ? [command] : extensions.map((extension) => `${command}${extension}`);
    for (const candidate of commands) {
      const path = normalize(join(root, candidate));
      if (await isFile(fs, path, strict)) return path;
    }
  }
  return undefined;
}

async function expandGlob(
  pattern: string,
  fs: IHostFileSystem,
  maxDepth: number,
  strict = false,
): Promise<readonly string[]> {
  const normalized = normalize(pattern).replaceAll('\\', '/');
  const rootMatch = normalized.match(/^(?:[A-Za-z]:\/|\/)/);
  const root = rootMatch?.[0] ?? '';
  const segments = normalized.slice(root.length).split('/').filter(Boolean);
  const results: string[] = [];
  const visit = async (current: string, index: number, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    if (index === segments.length) {
      if (await isFile(fs, current, strict)) results.push(current);
      return;
    }
    const segment = segments[index]!;
    if (segment === '**') {
      await visit(current, index + 1, depth);
      for (const entry of await safeReaddir(fs, current, strict)) {
        if (entry.isDirectory) await visit(join(current, entry.name), index, depth + 1);
      }
      return;
    }
    if (!segment.includes('*') && !segment.includes('?')) {
      await visit(join(current, segment), index + 1, depth + 1);
      return;
    }
    const matcher = wildcard(segment);
    for (const entry of await safeReaddir(fs, current, strict)) {
      if (matcher.test(entry.name)) await visit(join(current, entry.name), index + 1, depth + 1);
    }
  };
  await visit(root || '.', 0, 0);
  return results;
}

function expandPath(value: string, bootstrap: IBootstrapService): string {
  let result = value.replace(/^~(?=$|[\\/])/, bootstrap.osHomeDir);
  result = expandExecutorText(result, bootstrap);
  result = result.replaceAll(/%([^%]+)%/g, (_match, name: string) => bootstrap.getEnv(name) ?? `%${name}%`);
  return normalize(result);
}

async function probeCommand(
  processService: IHostProcessService,
  command: string,
  args: readonly string[],
  descriptor: AgentExecutorDescriptor,
  limits: { readonly timeoutMs?: number; readonly maxOutputBytes?: number; readonly stdoutOnly?: boolean } = {},
): Promise<ProbeResult> {
  let child: IHostProcess;
  try {
    child = await processService.spawn(command, args, {
      ...executorProcessOptions(descriptor),
      shell: false,
      windowsHide: true,
      mergeStderr: false,
    });
  } catch {
    return { available: false, output: '' };
  }
  const maxOutputBytes = limits.maxOutputBytes ?? 64 * 1024;
  let output = '';
  let truncated = false;
  const append = (chunk: Buffer | string): void => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = maxOutputBytes - Buffer.byteLength(output);
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    if (value.length > remaining) {
      output += value.subarray(0, remaining).toString('utf8');
      truncated = true;
      return;
    }
    output += value.toString('utf8');
  };
  child.stdout.on('data', append);
  if (limits.stdoutOnly !== true) child.stderr.on('data', append);
  let timer: NodeJS.Timeout | undefined;
  try {
    const code = await Promise.race([
      child.wait(),
      new Promise<number>((resolve) => {
        timer = setTimeout(() => {
          resolve(-1);
        }, limits.timeoutMs ?? 10_000);
      }),
    ]);
    if (code === -1 && child.exitCode === null) await child.kill('SIGTERM').catch(() => undefined);
    return { available: true, code, output: redactExecutorOutput(descriptor, output.trim()), truncated };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await child.dispose();
  }
}

function missingPathError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error &&
    ['ENOENT', 'ENOTDIR', 'os.fs.not_found', 'os.fs.not_directory'].includes(String(error.code));
}

async function isFile(fs: IHostFileSystem, path: string, strict = false): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile;
  } catch (error) {
    if (strict && !missingPathError(error)) throw error;
    return false;
  }
}

async function safeReaddir(fs: IHostFileSystem, path: string, strict = false) {
  try {
    return await fs.readdir(path);
  } catch (error) {
    if (strict && !missingPathError(error)) throw error;
    return [];
  }
}

interface BinaryVersionKey {
  readonly core: readonly number[];
  readonly prerelease: readonly (string | number)[];
}

function compareExecutorBinaryPaths(left: string, right: string): number {
  const leftVersion = pathVersion(left);
  const rightVersion = pathVersion(right);
  if (leftVersion !== undefined && rightVersion !== undefined) {
    const compared = compareVersionKeys(leftVersion, rightVersion);
    if (compared !== 0) return compared;
  } else if (leftVersion !== undefined) {
    return 1;
  } else if (rightVersion !== undefined) {
    return -1;
  }
  return left.localeCompare(right);
}

export function compareExecutorBinaryCandidates(
  left: { readonly command: string; readonly output: string },
  right: { readonly command: string; readonly output: string },
): number {
  const leftVersion = effectiveVersionKey(left);
  const rightVersion = effectiveVersionKey(right);
  if (leftVersion !== undefined && rightVersion !== undefined) {
    const compared = compareVersionKeys(leftVersion, rightVersion);
    if (compared !== 0) return compared;
  } else if (leftVersion !== undefined) {
    return 1;
  } else if (rightVersion !== undefined) {
    return -1;
  }
  return left.command.localeCompare(right.command);
}

function effectiveVersionKey(
  candidate: { readonly command: string; readonly output: string },
): BinaryVersionKey | undefined {
  const probe = probeSemver(candidate.output, candidate.command);
  return probe === null ? pathVersion(candidate.command) : semanticVersionKey(probe);
}

function probeSemver(output: string, command: string): SemVer | null {
  const lines = output.split(/\r?\n/);
  const commandName = stripExecutableExtension(basename(command)).toLowerCase();
  const preferred = lines.filter((line) => line.toLowerCase().includes(commandName));
  for (const line of [...preferred, ...lines]) {
    const version = semverInText(line);
    if (version !== null) return version;
  }
  return null;
}

function semverInText(value: string): SemVer | null {
  const match = value.match(/(?:^|[^0-9A-Za-z])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=$|[^0-9A-Za-z.-])/);
  return match?.[1] === undefined ? null : parse(match[1]);
}

const ANTIGRAVITY_IDE_DIAGNOSTIC = '这是 Antigravity IDE，不是 ACP CLI。请通过 Antigravity 执行器的二进制缓存安装官方 Google Antigravity CLI 1.5+（或安装 agy 1.5+ CLI）。';

function isOfficialAntigravityBinaryName(command: string): boolean {
  const name = basename(command).toLowerCase();
  return name === 'agy.exe' || name === 'agy' || name === 'antigravity';
}

function isLegacyAntigravityServerName(command: string): boolean {
  return basename(command).replace(/\.(?:exe|par|cmd|bat|com)$/i, '').toLowerCase() === 'agy_acp_server';
}

async function inspectManagedOfficialAntigravityCandidate(
  command: string,
  fs: IHostFileSystem,
  strict = false,
): Promise<{ readonly version: string } | undefined> {
  if (!isOfficialAntigravityBinaryName(command)) return undefined;
  const markerPath = join(dirname(command), '.install-complete.json');
  let raw: string;
  try {
    raw = await fs.readText(markerPath);
  } catch (error) {
    if (strict && !missingPathError(error)) throw error;
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const version = typeof parsed['version'] === 'string' ? parse(parsed['version'].trim()) : null;
    if (version === null || !gte(version, ANTIGRAVITY_CLI_MIN_VERSION)) return undefined;
    const rawExecutable = parsed['executable'];
    const executableName = typeof rawExecutable === 'string'
      ? rawExecutable
      : rawExecutable !== null && typeof rawExecutable === 'object' && typeof (rawExecutable as Record<string, unknown>)['name'] === 'string'
        ? (rawExecutable as Record<string, unknown>)['name'] as string
        : undefined;
    const executableBytes = rawExecutable !== null && typeof rawExecutable === 'object' && typeof (rawExecutable as Record<string, unknown>)['bytes'] === 'number'
      ? (rawExecutable as Record<string, unknown>)['bytes'] as number
      : typeof parsed['size'] === 'number'
        ? parsed['size']
        : undefined;
    if (executableName !== undefined && executableName.toLowerCase() !== basename(command).toLowerCase()) return undefined;
    if (executableBytes !== undefined && executableBytes > 0) {
      const info = await fs.stat(command);
      if (info.size > 0 && info.size !== executableBytes) return undefined;
    }
    return { version: version.version };
  } catch {
    return undefined;
  }
}

export async function isAntigravityIdeCandidate(
  command: string,
  fs: IHostFileSystem,
  platform: NodeJS.Platform,
  strict = false,
): Promise<boolean> {
  if (stripExecutableExtension(basename(command)).toLowerCase() !== 'antigravity') return false;
  if (platform === 'win32') return true;
  const normalized = normalize(command).toLowerCase();
  if (normalized.includes('.app/contents/')) return true;
  const dir = dirname(command);
  for (const marker of [
    join(dir, 'resources', 'app', 'package.json'),
    join(dir, '..', 'resources', 'app', 'package.json'),
    join(dir, '..', '..', 'Resources', 'app', 'package.json'),
    join(dir, 'Contents', 'MacOS', 'Electron'),
  ]) {
    if (await isFile(fs, marker, strict)) return true;
  }
  return isAntigravityIdeArtifact(command, platform);
}

function pathVersion(path: string): BinaryVersionKey | undefined {
  const parentDirectory = basename(dirname(path));
  const officialRelease = parentDirectory.match(/^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-[0-9a-f]{12}$/i)?.[1];
  if (officialRelease !== undefined) return versionKey(officialRelease);
  const legacyVersion = basename(dirname(dirname(path)));
  if (isLegacyAntigravityServerName(path)) {
    const parsedLegacy = versionKey(legacyVersion);
    if (parsedLegacy !== undefined) return parsedLegacy;
  }
  const packageDirectory = basename(dirname(dirname(dirname(path))));
  const desktop = packageDirectory.match(/^OpenAI\.Codex_([^_]+)/i)?.[1];
  const extension = packageDirectory.match(
    /^openai\.chatgpt-(.+?)(?:-(?:win32|linux|darwin)(?:-|$)|$)/i,
  )?.[1];
  return versionKey(desktop ?? extension);
}

function versionKey(value: string | undefined): BinaryVersionKey | undefined {
  if (value === undefined) return undefined;
  const semantic = parse(value);
  if (semantic !== null) return semanticVersionKey(semantic);
  if (!/^\d+(?:\.\d+){2,3}$/.test(value)) return undefined;
  return { core: value.split('.').map(Number), prerelease: [] };
}

function semanticVersionKey(version: SemVer): BinaryVersionKey {
  return {
    core: [version.major, version.minor, version.patch],
    prerelease: version.prerelease,
  };
}

function compareVersionKeys(left: BinaryVersionKey, right: BinaryVersionKey): number {
  const core = compareNumberTuples(left.core, right.core);
  if (core !== 0) return core;
  if (left.prerelease.length === 0 && right.prerelease.length > 0) return 1;
  if (right.prerelease.length === 0 && left.prerelease.length > 0) return -1;
  const size = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < size; index += 1) {
    const compared = comparePrereleasePart(left.prerelease[index], right.prerelease[index]);
    if (compared !== 0) return compared;
  }
  return 0;
}

function comparePrereleasePart(
  left: string | number | undefined,
  right: string | number | undefined,
): number {
  if (left === undefined) return right === undefined ? 0 : -1;
  if (right === undefined) return 1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'number') return -1;
  if (typeof right === 'number') return 1;
  return left.localeCompare(right);
}

function compareNumberTuples(left: readonly number[], right: readonly number[]): number {
  const size = Math.max(left.length, right.length);
  for (let index = 0; index < size; index += 1) {
    const compared = (left[index] ?? 0) - (right[index] ?? 0);
    if (compared !== 0) return compared;
  }
  return 0;
}

function wildcard(segment: string): RegExp {
  const escaped = segment.replaceAll(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function stripExecutableExtension(value: string): string {
  return value.replace(/\.(?:exe|cmd|bat|com)$/i, '');
}

function firstLine(value: string): string | undefined {
  return value.split(/\r?\n/, 1)[0] ?? undefined;
}

function unavailableDiagnostic(
  source: AgentExecutorBinarySource,
  bootstrap: IBootstrapService,
): string {
  if (source.kind === 'env') return `${source.name} is unset`;
  if (source.kind === 'path-lookup') return `${source.command} was not found on PATH`;
  if (source.kind === 'explicit-path' || source.kind === 'node-script') return `${expandPath(source.path, bootstrap)} does not exist`;
  return `no files matched ${expandPath(source.pattern, bootstrap)}`;
}
