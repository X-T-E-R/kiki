import { basename, dirname, join, normalize } from 'pathe';
import { parse, type SemVer } from 'semver';

import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';

import type {
  AgentExecutorBinarySource,
  AgentExecutorDescriptor,
  AgentExecutorSourceProbe,
} from './agentExecutor';

interface ProbeResult {
  readonly available: boolean;
  readonly version?: string;
  readonly code?: number;
  readonly output: string;
}

export async function discoverExecutorSources(
  descriptor: AgentExecutorDescriptor,
  processService: IHostProcessService,
  fs: IHostFileSystem,
  bootstrap: IBootstrapService,
): Promise<readonly AgentExecutorSourceProbe[]> {
  if (descriptor.sources === undefined || descriptor.sources.length === 0) {
    if (descriptor.command === undefined) return [];
    const probe = await probeCommand(
      processService,
      descriptor.command,
      descriptor.versionProbe?.args ?? ['--version'],
      descriptor.env,
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
  const results: AgentExecutorSourceProbe[] = [];
  for (const source of descriptor.sources) {
    results.push(await probeSource(source, descriptor, processService, fs, bootstrap));
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

async function probeSource(
  source: AgentExecutorBinarySource,
  descriptor: AgentExecutorDescriptor,
  processService: IHostProcessService,
  fs: IHostFileSystem,
  bootstrap: IBootstrapService,
): Promise<AgentExecutorSourceProbe> {
  const commands = await sourceCommands(source, fs, bootstrap);
  if (commands.length === 0) {
    return {
      id: source.id,
      kind: source.kind,
      available: false,
      diagnostic: unavailableDiagnostic(source, bootstrap),
    };
  }
  const candidates = await Promise.all(commands.map(async (command) => ({
    command,
    probe: await probeCommand(
      processService,
      command,
      descriptor.versionProbe?.args ?? ['--version'],
      descriptor.env,
    ),
  })));
  const available = candidates.filter((candidate) => candidate.probe.available && candidate.probe.code === 0);
  if (available.length === 0) {
    const first = candidates[0];
    return {
      id: source.id,
      kind: source.kind,
      available: false,
      command: first?.command,
      version: firstLine(first?.probe.output ?? ''),
      diagnostic: first?.probe.available === true
        ? `version probe exited with code ${String(first.probe.code)}`
        : 'not found or not executable',
    };
  }
  const selected = source.kind === 'glob'
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
    version: firstLine(selected.probe.output),
  };
}

async function sourceCommands(
  source: AgentExecutorBinarySource,
  fs: IHostFileSystem,
  bootstrap: IBootstrapService,
): Promise<readonly string[]> {
  if (source.kind === 'env') {
    const value = bootstrap.getEnv(source.name)?.trim();
    return value === undefined || value.length === 0 ? [] : [expandPath(value, bootstrap)];
  }
  if (source.kind === 'explicit-path') {
    const path = expandPath(source.path, bootstrap);
    return await isFile(fs, path) ? [path] : [];
  }
  if (source.kind === 'path-lookup') {
    const path = await lookupPath(source.command, fs, bootstrap);
    if (path === undefined) return [];
    if (
      source.requiredBasename !== undefined &&
      stripExecutableExtension(basename(path)).toLowerCase() !== source.requiredBasename.toLowerCase()
    ) {
      return [];
    }
    return [path];
  }
  return expandGlob(expandPath(source.pattern, bootstrap), fs, source.maxDepth ?? 8);
}

async function lookupPath(
  command: string,
  fs: IHostFileSystem,
  bootstrap: IBootstrapService,
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
      if (await isFile(fs, path)) return path;
    }
  }
  return undefined;
}

async function expandGlob(
  pattern: string,
  fs: IHostFileSystem,
  maxDepth: number,
): Promise<readonly string[]> {
  const normalized = normalize(pattern).replaceAll('\\', '/');
  const rootMatch = normalized.match(/^(?:[A-Za-z]:\/|\/)/);
  const root = rootMatch?.[0] ?? '';
  const segments = normalized.slice(root.length).split('/').filter(Boolean);
  const results: string[] = [];
  const visit = async (current: string, index: number, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    if (index === segments.length) {
      if (await isFile(fs, current)) results.push(current);
      return;
    }
    const segment = segments[index]!;
    if (segment === '**') {
      await visit(current, index + 1, depth);
      for (const entry of await safeReaddir(fs, current)) {
        if (entry.isDirectory) await visit(join(current, entry.name), index, depth + 1);
      }
      return;
    }
    if (!segment.includes('*') && !segment.includes('?')) {
      await visit(join(current, segment), index + 1, depth + 1);
      return;
    }
    const matcher = wildcard(segment);
    for (const entry of await safeReaddir(fs, current)) {
      if (matcher.test(entry.name)) await visit(join(current, entry.name), index + 1, depth + 1);
    }
  };
  await visit(root || '.', 0, 0);
  return results;
}

function expandPath(value: string, bootstrap: IBootstrapService): string {
  let result = value.replace(/^~(?=$|[\\/])/, bootstrap.osHomeDir);
  result = result.replaceAll(/\$\{([^}]+)\}/g, (_match, name: string) => bootstrap.getEnv(name) ?? `\${${name}}`);
  result = result.replaceAll(/%([^%]+)%/g, (_match, name: string) => bootstrap.getEnv(name) ?? `%${name}%`);
  return normalize(result);
}

async function probeCommand(
  processService: IHostProcessService,
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> | undefined,
): Promise<ProbeResult> {
  let child: IHostProcess;
  try {
    child = await processService.spawn(command, args, {
      env: env === undefined ? undefined : { ...env },
      shell: false,
      windowsHide: true,
      mergeStderr: false,
    });
  } catch {
    return { available: false, output: '' };
  }
  let output = '';
  const append = (chunk: Buffer | string): void => {
    if (output.length >= 64 * 1024) return;
    output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  let timer: NodeJS.Timeout | undefined;
  try {
    const code = await Promise.race([
      child.wait(),
      new Promise<number>((resolve) => {
        timer = setTimeout(() => {
          resolve(-1);
        }, 10_000);
      }),
    ]);
    if (code === -1 && child.exitCode === null) await child.kill('SIGTERM').catch(() => undefined);
    return { available: true, code, output: output.trim() };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await child.dispose();
  }
}

async function isFile(fs: IHostFileSystem, path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile;
  } catch {
    return false;
  }
}

async function safeReaddir(fs: IHostFileSystem, path: string) {
  try {
    return await fs.readdir(path);
  } catch {
    return [];
  }
}

interface BinaryVersionKey {
  readonly core: readonly number[];
  readonly prerelease: readonly (string | number)[];
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

function pathVersion(path: string): BinaryVersionKey | undefined {
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
  if (source.kind === 'explicit-path') return `${expandPath(source.path, bootstrap)} does not exist`;
  return `no files matched ${expandPath(source.pattern, bootstrap)}`;
}
