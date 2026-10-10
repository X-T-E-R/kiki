import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, glob, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, resolve } from 'pathe';

import { translateShellDrivePath } from '#/_base/execEnv/shellPathBridge';

const execFileAsync = promisify(execFile);
const SAFE_ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SAFE_TARGET = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,253}$/;

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

async function knownHostsPaths(alias: string, args: readonly string[], value: string, diagnostics: string): Promise<readonly string[]> {
  if (value === 'none') return [];
  const candidates = new Set<string>(['~/.ssh/known_hosts ~/.ssh/known_hosts2']);
  const files = new Set([...diagnostics.matchAll(/^debug\d+: Reading configuration data (.+)\r?$/gm)].map((match) => match[1]!.replace(/\r$/, '')));
  for (const file of files) {
    const text = await readFile(process.platform === 'win32' ? translateShellDrivePath(file) : file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*UserKnownHostsFile(?:\s*=\s*|\s+)(.+)$/i.exec(line);
      if (match !== null) candidates.add(match[1]!);
    }
  }
  const matches = new Map<string, readonly string[]>();
  for (const candidate of candidates) {
    const tokens = pathTokens(candidate);
    if (tokens.length === 0 || tokens[0] === 'none') continue;
    const separator = `kiki-path-boundary-${randomUUID()}`;
    const { stdout } = await execFileAsync('ssh', [
      ...args, '-o', `UserKnownHostsFile=${tokens.join(` ${separator} `)}`, '-G', '--', alias,
    ], { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true });
    const expanded = /^userknownhostsfile (.*)\r?$/m.exec(stdout)?.[1]?.replace(/\r$/, '');
    const paths = expanded?.split(` ${separator} `);
    if (paths !== undefined && paths.join(' ') === value) matches.set(JSON.stringify(paths), paths);
  }
  if (matches.size !== 1) throw new Error('Cannot resolve SSH known_hosts path boundaries from ssh -G output');
  return [...matches.values()][0]!.map((path) => process.platform === 'win32' ? translateShellDrivePath(path) : path);
}

export async function resolveSshConfig(alias: string, configFile?: string): Promise<ResolvedSshConfig> {
  validateSshAlias(alias);
  const args = configFile === undefined ? [] : ['-F', configFile];
  const { stdout, stderr } = await execFileAsync('ssh', [...args, '-v', '-G', '--', alias], { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true });
  const fields = new Map<string, string[]>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([^\s]+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    fields.set(key, [...(fields.get(key) ?? []), match[2]!]);
  }
  const first = (key: string): string | undefined => fields.get(key)?.[0];
  const hostname = first('hostname');
  const user = first('user');
  const port = Number(first('port'));
  if (!hostname || !user || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Incomplete ssh -G output');
  }
  return {
    hostname,
    user,
    port,
    identityFiles: fields.get('identityfile') ?? [],
    identityAgent: first('identityagent'),
    proxyJump: first('proxyjump') === 'none' ? undefined : first('proxyjump'),
    proxyCommand: first('proxycommand') === 'none' ? undefined : first('proxycommand'),
    userKnownHostsFiles: await knownHostsPaths(alias, args, first('userknownhostsfile') ?? 'none', stderr),
  };
}

export async function discoverSshAliases(configFile = join(homedir(), '.ssh', 'config')): Promise<readonly string[]> {
  const seen = new Set<string>();
  const visited = new Set<string>();
  const scan = async (file: string, depth: number): Promise<void> => {
    if (depth > 16 || visited.has(file)) return;
    visited.add(file);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(host|include)\s+(.+?)\s*$/i.exec(line);
      if (!match) continue;
      const tokens = match[2]!.replace(/\s+#.*$/, '').split(/\s+/);
      if (match[1]!.toLowerCase() === 'host') {
        for (const token of tokens) if (SAFE_ALIAS.test(token)) seen.add(token);
        continue;
      }
      for (const token of tokens) {
        if (token.startsWith('!')) continue;
        const pattern = token.startsWith('~/')
          ? join(homedir(), token.slice(2))
          : isAbsolute(token) ? token : resolve(dirname(file), token);
        for await (const included of glob(pattern, { withFileTypes: false })) await scan(included, depth + 1);
      }
    }
  };
  await scan(configFile, 0);
  return [...seen].sort();
}

export async function appendSshHost(configFile: string, alias: string, hostname: string, user: string, port: number): Promise<void> {
  validateSshAlias(alias);
  if (!SAFE_TARGET.test(hostname) || !SAFE_ALIAS.test(user) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid SSH host target');
  }
  if ((await discoverSshAliases(configFile)).includes(alias)) throw new Error('SSH host alias already exists in config');
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
