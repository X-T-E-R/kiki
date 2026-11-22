import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, glob, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, resolve } from 'pathe';

import { translateShellDrivePath } from '@kiki/kaos/exec-env';

const execFileAsync = promisify(execFile);
const SAFE_ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SAFE_TARGET = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,253}$/;
const DEFAULT_MAX_CACHE_ENTRIES = 128;
const GLOB_MAGIC = /[*?[\]{}]/;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const MAX_INCLUDE_DEPTH = 16;

export interface ResolvedSshConfig {
  readonly hostname: string;
  readonly user: string;
  readonly port: number;
  readonly identityFiles: readonly string[];
  readonly identityAgent?: string;
  readonly proxyJump?: string;
  readonly proxyCommand?: string;
  readonly userKnownHostsFiles: readonly string[];
}

export type SshExecFile = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface SshConfigResolverOptions {
  readonly execSsh?: SshExecFile;
  readonly maxEntries?: number;
}

interface ConfigFileSnapshot {
  readonly path: string;
  readonly stat: string;
}

interface ConfigGlobSnapshot {
  readonly pattern: string;
  readonly matches: readonly string[];
}

interface ConfigSnapshot {
  readonly files: readonly ConfigFileSnapshot[];
  readonly globs: readonly ConfigGlobSnapshot[];
}

interface CachedValue<T> {
  readonly snapshot: ConfigSnapshot;
  readonly value: T;
}

async function defaultExecSsh(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(file, [...args], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return { stdout, stderr };
}

export function parseTransientSshTarget(value: string): { user: string; hostname: string; port: number } | undefined {
  const match = /^([A-Za-z0-9_][A-Za-z0-9_.-]{0,63})@([A-Za-z0-9][A-Za-z0-9.-]{0,252})(?::([0-9]{1,5}))?$/.exec(value);
  if (match === null) return undefined;
  const port = match[3] === undefined ? 22 : Number(match[3]);
  if (port < 1 || port > 65535) return undefined;
  return { user: match[1]!, hostname: match[2]!, port };
}

export function validateSshAlias(alias: string): string {
  if (!SAFE_ALIAS.test(alias) || alias.startsWith('-')) throw new Error('Invalid SSH host alias');
  return alias;
}

function normalizeKnownHostPath(path: string): string {
  return process.platform === 'win32' ? translateShellDrivePath(path) : path;
}

function normalizeTrackPath(path: string): string {
  return resolve(normalizeKnownHostPath(path));
}

function normalizePathForCompare(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathTokens(value: string): string[] {
  const tokens: string[] = [];
  let start = -1;
  let quote: string | undefined;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (start < 0) {
      if (/\s/.test(char)) continue;
      if (char === '#') break;
      start = index;
    }
    if (char === '\\' && ['\\', '"', "'"].includes(value[index + 1] ?? '')) {
      index++;
    } else if (char === quote) {
      quote = undefined;
    } else if (quote === undefined && (char === '"' || char === "'")) {
      quote = char;
    } else if (quote === undefined && /\s/.test(char)) {
      tokens.push(value.slice(start, index));
      start = -1;
    }
  }
  if (quote !== undefined) throw new Error('Invalid quoted SSH path');
  if (start >= 0) tokens.push(value.slice(start));
  return tokens;
}

function stripOuterQuotes(token: string): string {
  if (token.length >= 2 && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))) {
    return token.slice(1, -1);
  }
  return token;
}

function parseIncludeTokens(raw: string): string[] {
  try {
    return pathTokens(raw).map(stripOuterQuotes).filter((token) => token.length > 0);
  } catch {
    return raw.replace(/\s+#.*$/, '').split(/\s+/).map(stripOuterQuotes).filter((token) => token.length > 0);
  }
}

function splitDefaultKnownHostsShape(value: string): readonly [string, string] | undefined {
  if (value.length < 2 || (value.length - 2) % 2 !== 0) return undefined;
  const mid = (value.length - 2) / 2;
  if (value[mid] !== ' ') return undefined;
  const first = value.slice(0, mid);
  const second = value.slice(mid + 1);
  if (second !== `${first}2`) return undefined;
  if (!/[/\\]\.ssh[/\\]known_hosts$/.test(first)) return undefined;
  return [first, second];
}

function matchDefaultKnownHosts(value: string): readonly [string, string] | undefined {
  const shape = splitDefaultKnownHostsShape(value);
  if (shape === undefined) return undefined;
  const [first] = shape;
  const suffix = /[/\\]\.ssh[/\\]known_hosts$/.exec(first);
  if (suffix === null) return undefined;
  const prefix = first.slice(0, suffix.index);
  if (prefix === '~') return shape;
  const normalizedPrefix = normalizePathForCompare(normalizeKnownHostPath(prefix)).replace(/\/+$/, '');
  const homes = [homedir(), process.env['HOME'], process.env['USERPROFILE']]
    .filter((entry): entry is string => entry !== undefined && entry.length > 0)
    .map((entry) => normalizePathForCompare(normalizeKnownHostPath(entry)).replace(/\/+$/, ''));
  return homes.includes(normalizedPrefix) ? shape : undefined;
}

function tryLiteralToken(token: string): string | undefined {
  let raw = token;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    raw = raw.slice(1, -1);
  }
  if (raw.includes('"') || raw.includes("'") || raw.includes('%') || raw.startsWith('~')) return undefined;
  if (/\\[\\"']/.test(raw)) return undefined;
  return raw;
}

function tryLiteralTokens(tokens: readonly string[]): readonly string[] | undefined {
  const result: string[] = [];
  for (const token of tokens) {
    const literal = tryLiteralToken(token);
    if (literal === undefined) return undefined;
    result.push(literal);
  }
  return result;
}

function tryExpandTildeOnlyTokens(tokens: readonly string[], homePrefix: string): readonly string[] | undefined {
  const result: string[] = [];
  for (const token of tokens) {
    let raw = token;
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      raw = raw.slice(1, -1);
    }
    if (raw.includes('"') || raw.includes("'") || raw.includes('%') || /\\[\\"']/.test(raw)) return undefined;
    if (raw.startsWith('~/')) {
      result.push(`${homePrefix}${raw.slice(1)}`);
    } else if (raw.startsWith('~')) {
      return undefined;
    } else {
      result.push(raw);
    }
  }
  return result;
}

function matchWildcardParts(parts: readonly string[], target: string): boolean {
  if (parts.length === 1) return target === parts[0];
  const first = parts[0]!;
  const last = parts.at(-1)!;
  if (!target.startsWith(first) || !target.endsWith(last)) return false;
  if (first.length + last.length > target.length) return false;
  let cursor = first.length;
  const limit = target.length - last.length;
  for (let index = 1; index < parts.length - 1; index++) {
    const piece = parts[index]!;
    if (piece.length === 0) continue;
    const found = target.indexOf(piece, cursor);
    if (found < 0 || found + piece.length > limit) return false;
    cursor = found + piece.length;
  }
  return true;
}

function candidateCouldMatchValue(tokens: readonly string[], value: string): boolean {
  const joinedParts: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    let raw = tokens[index]!;
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      raw = raw.slice(1, -1);
    }
    if (raw.includes('"') || raw.includes("'") || /\\[\\"']/.test(raw)) return true;
    const hasTilde = raw.startsWith('~');
    const body = hasTilde ? raw.replace(/^~[^/\\]*/, '') : raw;
    const tokenParts = body.split(/%./).map(normalizePathForCompare);
    if (hasTilde) tokenParts.unshift('');
    if (index === 0) {
      joinedParts.push(...tokenParts);
    } else {
      joinedParts[joinedParts.length - 1] = `${joinedParts.at(-1)!} ${tokenParts[0]!}`;
      joinedParts.push(...tokenParts.slice(1));
    }
  }
  return matchWildcardParts(joinedParts, normalizePathForCompare(value));
}

function parseReadConfigFiles(diagnostics: string): readonly string[] {
  return [...new Set([...diagnostics.matchAll(/^debug\d+: Reading configuration data (.+)\r?$/gm)].map((match) => match[1]!.replace(/\r$/, '')))];
}

async function knownHostsPaths(
  alias: string,
  args: readonly string[],
  value: string,
  diagnostics: string,
  execSsh: SshExecFile,
): Promise<readonly string[]> {
  if (value === 'none' || value === '') return [];
  if (!/\s/.test(value)) return [normalizeKnownHostPath(value)];

  const matches = new Map<string, readonly string[]>();
  const defaultMatch = matchDefaultKnownHosts(value);
  if (defaultMatch !== undefined) {
    matches.set(JSON.stringify(defaultMatch), defaultMatch);
  }

  const configCandidates = new Set<string>();
  const files = parseReadConfigFiles(diagnostics);
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(normalizeKnownHostPath(file), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*UserKnownHostsFile(?:\s*=\s*|\s+)(.+)$/i.exec(line);
      if (match !== null) configCandidates.add(match[1]!);
    }
  }

  const toProbe = new Map<string, string[]>();
  const defaultHomePrefix = defaultMatch === undefined
    ? undefined
    : defaultMatch[0].slice(0, /[/\\]\.ssh[/\\]known_hosts$/.exec(defaultMatch[0])!.index);
  for (const candidate of configCandidates) {
    const tokens = pathTokens(candidate);
    if (tokens.length === 0 || tokens[0] === 'none') continue;
    const literal = tryLiteralTokens(tokens);
    if (literal !== undefined) {
      if (literal.join(' ') === value) {
        matches.set(JSON.stringify(literal), literal);
        continue;
      }
      if (normalizePathForCompare(literal.join(' ')) !== normalizePathForCompare(value)) {
        continue;
      }
      toProbe.set(JSON.stringify(tokens), tokens);
      continue;
    }
    if (defaultHomePrefix !== undefined) {
      const expandedWithDefaultHome = tryExpandTildeOnlyTokens(tokens, defaultHomePrefix);
      if (expandedWithDefaultHome !== undefined) {
        if (expandedWithDefaultHome.join(' ') === value) {
          matches.set(JSON.stringify(expandedWithDefaultHome), expandedWithDefaultHome);
          continue;
        }
        if (normalizePathForCompare(expandedWithDefaultHome.join(' ')) !== normalizePathForCompare(value)) {
          continue;
        }
      }
    }
    if (candidateCouldMatchValue(tokens, value)) {
      toProbe.set(JSON.stringify(tokens), tokens);
    }
  }

  const probeList = [...toProbe.values()];
  if (defaultMatch === undefined) {
    const shape = splitDefaultKnownHostsShape(value);
    if (shape !== undefined && (matches.size === 0 || !matches.has(JSON.stringify(shape)))) {
      probeList.unshift(['~/.ssh/known_hosts', '~/.ssh/known_hosts2']);
    }
  }

  for (const tokens of probeList) {
    const separator = `kiki-path-boundary-${randomUUID()}`;
    const { stdout } = await execSsh('ssh', [
      ...args, '-o', `UserKnownHostsFile=${tokens.join(` ${separator} `)}`, '-G', '--', alias,
    ]);
    const expanded = /^userknownhostsfile (.*)\r?$/m.exec(stdout)?.[1]?.replace(/\r$/, '');
    const paths = expanded?.split(` ${separator} `);
    if (paths !== undefined && paths.join(' ') === value) {
      matches.set(JSON.stringify(paths), paths);
    }
  }

  if (matches.size !== 1) throw new Error('Cannot resolve SSH known_hosts path boundaries from ssh -G output');
  return [...matches.values()][0]!.map((path) => normalizeKnownHostPath(path));
}

async function statFingerprint(filePath: string): Promise<string> {
  const nativePath = normalizeKnownHostPath(filePath);
  try {
    const info = await stat(nativePath, { bigint: true });
    if (info.isDirectory()) return `dir:${info.mtimeNs}:${info.ctimeNs}:${info.ino}`;
    return `file:${info.mtimeNs}:${info.ctimeNs}:${info.size}:${info.ino}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    throw error;
  }
}

async function expandGlob(pattern: string): Promise<readonly string[]> {
  const matches: string[] = [];
  try {
    for await (const entry of glob(pattern, { withFileTypes: false })) {
      matches.push(normalizeTrackPath(entry));
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
  return [...new Set(matches)].toSorted();
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function isSnapshotCurrent(snapshot: ConfigSnapshot): Promise<boolean> {
  try {
    const [fileMatches, globMatches] = await Promise.all([
      Promise.all(snapshot.files.map(async (entry) => (await statFingerprint(entry.path)) === entry.stat)),
      Promise.all(snapshot.globs.map(async (entry) => arraysEqual(await expandGlob(entry.pattern), entry.matches))),
    ]);
    return fileMatches.every(Boolean) && globMatches.every(Boolean);
  } catch {
    return false;
  }
}

function resolveIncludePatterns(token: string, file: string, includeHomeRelative: boolean): readonly string[] {
  if (token.startsWith('~/')) {
    const suffix = token.slice(2);
    const primary = join(homedir(), suffix);
    if (!includeHomeRelative || !process.env['HOME']) return [primary];
    const envHome = join(process.env['HOME'], suffix);
    return normalizeTrackPath(envHome) === normalizeTrackPath(primary) ? [primary] : [primary, envHome];
  }
  if (isAbsolute(token) || WINDOWS_DRIVE_PATH.test(token)) return [token];
  const local = resolve(dirname(file), token);
  if (!includeHomeRelative) return [local];
  const homeRelative = resolve(join(homedir(), '.ssh'), token);
  return homeRelative === local ? [local] : [local, homeRelative];
}

interface ConfigScanCollector {
  readonly visited: Set<string>;
  readonly files: Map<string, string>;
  readonly globs: Map<string, readonly string[]>;
  readonly aliases: Set<string>;
  dynamic: boolean;
}

const MATCH_EXEC = /^\s*match(?:\s*=\s*|\s+).*\bexec\b/i;

function createCollector(): ConfigScanCollector {
  return {
    visited: new Set<string>(),
    files: new Map<string, string>(),
    globs: new Map<string, readonly string[]>(),
    aliases: new Set<string>(),
    dynamic: false,
  };
}

async function scanConfigFile(
  file: string,
  depth: number,
  collector: ConfigScanCollector,
  collectAliases: boolean,
  includeHomeRelative: boolean,
): Promise<void> {
  if (depth > MAX_INCLUDE_DEPTH) return;
  const canonical = normalizeTrackPath(file);
  if (collector.visited.has(canonical)) return;
  collector.visited.add(canonical);
  const fingerprint = await statFingerprint(canonical);
  collector.files.set(canonical, fingerprint);
  if (fingerprint === 'missing' || fingerprint.startsWith('dir:')) return;
  let text: string;
  try {
    text = await readFile(canonical, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') {
      collector.files.set(canonical, code === 'ENOENT' ? 'missing' : await statFingerprint(canonical));
      return;
    }
    throw error;
  }
  for (const line of text.split(/\r?\n/)) {
    if (MATCH_EXEC.test(line)) collector.dynamic = true;
    const match = /^\s*(host|include)(?:\s*=\s*|\s+)(.+?)\s*$/i.exec(line);
    if (!match) continue;
    if (match[1]!.toLowerCase() === 'host') {
      if (collectAliases) {
        for (const token of match[2]!.replace(/\s+#.*$/, '').split(/\s+/)) {
          if (SAFE_ALIAS.test(token)) collector.aliases.add(token);
        }
      }
      continue;
    }
    for (const token of parseIncludeTokens(match[2]!)) {
      if (token.startsWith('!')) continue;
      for (const pattern of resolveIncludePatterns(token, canonical, includeHomeRelative)) {
        if (GLOB_MAGIC.test(pattern)) {
          const matched = await expandGlob(pattern);
          collector.globs.set(pattern, matched);
          for (const included of matched) {
            await scanConfigFile(included, depth + 1, collector, collectAliases, includeHomeRelative);
          }
        } else {
          await scanConfigFile(pattern, depth + 1, collector, collectAliases, includeHomeRelative);
        }
      }
    }
  }
}

function finalizeSnapshot(collector: ConfigScanCollector): ConfigSnapshot {
  const files = [...collector.files.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([path, statValue]) => ({ path, stat: statValue }));
  const globs = [...collector.globs.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([pattern, matches]) => ({ pattern, matches }));
  return { files, globs };
}

function resolveCacheKey(alias: string, configFile: string | undefined): string {
  return JSON.stringify([
    alias,
    configFile === undefined ? null : normalizeTrackPath(configFile),
    process.env['HOME'] ?? '',
    process.env['USERPROFILE'] ?? '',
    process.env['USER'] ?? '',
    process.env['USERNAME'] ?? '',
    process.env['LOGNAME'] ?? '',
  ]);
}

function discoverCacheKey(configFile: string): string {
  return JSON.stringify([
    normalizeTrackPath(configFile),
    process.env['HOME'] ?? '',
    process.env['USERPROFILE'] ?? '',
  ]);
}

function setBounded<V>(cache: Map<string, V>, key: string, value: V, maxEntries: number): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function touchEntry<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
}

/**
 * Caches SSH config resolutions and alias discovery keyed by exact async file stat fingerprints
 * and Include glob memberships, coalescing concurrent lookups per key.
 */
export class SshConfigResolver {
  declare readonly _serviceBrand: undefined;
  private readonly execSsh: SshExecFile;
  private readonly maxEntries: number;
  private readonly resolveCache = new Map<string, CachedValue<ResolvedSshConfig>>();
  private readonly resolveInFlight = new Map<string, Promise<ResolvedSshConfig>>();
  private readonly aliasCache = new Map<string, CachedValue<readonly string[]>>();
  private readonly aliasInFlight = new Map<string, Promise<readonly string[]>>();
  private generation = 0;

  constructor(options?: SshConfigResolverOptions) {
    this.execSsh = options?.execSsh ?? defaultExecSsh;
    this.maxEntries = Math.max(1, options?.maxEntries ?? DEFAULT_MAX_CACHE_ENTRIES);
  }

  clear(): void {
    this.generation++;
    this.resolveCache.clear();
    this.aliasCache.clear();
  }

  async resolve(alias: string, configFile?: string): Promise<ResolvedSshConfig> {
    validateSshAlias(alias);
    const key = resolveCacheKey(alias, configFile);
    const activeFlight = this.resolveInFlight.get(key);
    if (activeFlight !== undefined) return activeFlight;

    const cached = this.resolveCache.get(key);
    if (cached !== undefined && await isSnapshotCurrent(cached.snapshot)) {
      touchEntry(this.resolveCache, key, cached);
      return cached.value;
    }

    const racedFlight = this.resolveInFlight.get(key);
    if (racedFlight !== undefined) return racedFlight;

    const generation = this.generation;
    const flight = this.computeResolve(alias, configFile, key, generation).finally(() => {
      if (this.resolveInFlight.get(key) === flight) this.resolveInFlight.delete(key);
    });
    this.resolveInFlight.set(key, flight);
    return flight;
  }

  async discoverAliases(configFile = join(homedir(), '.ssh', 'config')): Promise<readonly string[]> {
    const key = discoverCacheKey(configFile);
    const activeFlight = this.aliasInFlight.get(key);
    if (activeFlight !== undefined) return activeFlight;

    const cached = this.aliasCache.get(key);
    if (cached !== undefined && await isSnapshotCurrent(cached.snapshot)) {
      touchEntry(this.aliasCache, key, cached);
      return cached.value;
    }

    const racedFlight = this.aliasInFlight.get(key);
    if (racedFlight !== undefined) return racedFlight;

    const generation = this.generation;
    const flight = this.computeDiscoverAliases(configFile, key, generation).finally(() => {
      if (this.aliasInFlight.get(key) === flight) this.aliasInFlight.delete(key);
    });
    this.aliasInFlight.set(key, flight);
    return flight;
  }

  private async computeResolve(
    alias: string,
    configFile: string | undefined,
    key: string,
    generation: number,
  ): Promise<ResolvedSshConfig> {
    const collector = createCollector();
    const rootConfig = configFile ?? join(homedir(), '.ssh', 'config');
    await scanConfigFile(rootConfig, 0, collector, false, true);
    const preSnapshot = finalizeSnapshot(collector);

    const args = configFile === undefined ? [] : ['-F', configFile];
    const { stdout, stderr } = await this.execSsh('ssh', [...args, '-v', '-G', '--', alias]);
    const fields = new Map<string, string[]>();
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^([^\s]+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const fieldKey = match[1]!.toLowerCase();
      fields.set(fieldKey, [...(fields.get(fieldKey) ?? []), match[2]!]);
    }
    const first = (fieldKey: string): string | undefined => fields.get(fieldKey)?.[0];
    const hostname = first('hostname');
    const user = first('user');
    const port = Number(first('port'));
    if (!hostname || !user || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Incomplete ssh -G output');
    }

    for (const file of parseReadConfigFiles(stderr)) {
      await scanConfigFile(file, 0, collector, false, true);
    }

    const resolved: ResolvedSshConfig = Object.freeze({
      hostname,
      user,
      port,
      identityFiles: Object.freeze([...(fields.get('identityfile') ?? [])]),
      identityAgent: first('identityagent'),
      proxyJump: first('proxyjump') === 'none' ? undefined : first('proxyjump'),
      proxyCommand: first('proxycommand') === 'none' ? undefined : first('proxycommand'),
      userKnownHostsFiles: Object.freeze([
        ...await knownHostsPaths(alias, args, first('userknownhostsfile') ?? 'none', stderr, this.execSsh),
      ]),
    });

    const fullSnapshot = finalizeSnapshot(collector);
    if (!collector.dynamic && this.generation === generation &&
      await isSnapshotCurrent(preSnapshot) && await isSnapshotCurrent(fullSnapshot)) {
      setBounded(this.resolveCache, key, { snapshot: fullSnapshot, value: resolved }, this.maxEntries);
    }
    return resolved;
  }

  private async computeDiscoverAliases(
    configFile: string,
    key: string,
    generation: number,
  ): Promise<readonly string[]> {
    const collector = createCollector();
    await scanConfigFile(configFile, 0, collector, true, false);
    const snapshot = finalizeSnapshot(collector);
    const aliases = Object.freeze([...collector.aliases].toSorted());
    if (this.generation === generation && await isSnapshotCurrent(snapshot)) {
      setBounded(this.aliasCache, key, { snapshot, value: aliases }, this.maxEntries);
    }
    return aliases;
  }
}

const defaultSshConfigResolver = new SshConfigResolver();

export async function resolveSshConfig(
  alias: string,
  configFile?: string,
  resolver: Pick<SshConfigResolver, 'resolve'> = defaultSshConfigResolver,
): Promise<ResolvedSshConfig> {
  return resolver.resolve(alias, configFile);
}

export async function discoverSshAliases(
  configFile = join(homedir(), '.ssh', 'config'),
  resolver: Pick<SshConfigResolver, 'discoverAliases'> = defaultSshConfigResolver,
): Promise<readonly string[]> {
  return resolver.discoverAliases(configFile);
}

export async function appendSshHost(
  configFile: string,
  alias: string,
  hostname: string,
  user: string,
  port: number,
  resolver: Pick<SshConfigResolver, 'discoverAliases'> = defaultSshConfigResolver,
): Promise<void> {
  validateSshAlias(alias);
  if (!SAFE_TARGET.test(hostname) || !SAFE_ALIAS.test(user) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid SSH host target');
  }
  if ((await resolver.discoverAliases(configFile)).includes(alias)) throw new Error('SSH host alias already exists in config');
  let previous = '';
  try {
    previous = await readFile(configFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await appendFile(configFile, `${previous.endsWith('\n') || previous.length === 0 ? '' : '\n'}\nHost ${alias}\n  HostName ${hostname}\n  User ${user}\n  Port ${port}\n`, { mode: 0o600 });
}

export function workspaceSshKey(workspaceId: string): string {
  return `ssh/workspaces/${createHash('sha256').update(workspaceId).digest('hex')}.toml`;
}
