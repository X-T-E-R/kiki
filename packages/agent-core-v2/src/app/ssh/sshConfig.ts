import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, glob, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, resolve } from 'pathe';

const execFileAsync = promisify(execFile);
const SAFE_ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SAFE_TARGET = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,253}$/;

export interface ResolvedSshConfig {
  readonly hostname: string;
  readonly user: string;
  readonly port: number;
  readonly identityFiles: readonly string[];
  readonly proxyJump?: string;
  readonly proxyCommand?: string;
  readonly userKnownHostsFiles: readonly string[];
}

export function validateSshAlias(alias: string): string {
  if (!SAFE_ALIAS.test(alias) || alias.startsWith('-')) throw new Error('Invalid SSH host alias');
  return alias;
}

export async function resolveSshConfig(alias: string, configFile?: string): Promise<ResolvedSshConfig> {
  validateSshAlias(alias);
  const args = configFile === undefined ? ['-G', '--', alias] : ['-F', configFile, '-G', '--', alias];
  const { stdout } = await execFileAsync('ssh', args, { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true });
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
    proxyJump: first('proxyjump') === 'none' ? undefined : first('proxyjump'),
    proxyCommand: first('proxycommand') === 'none' ? undefined : first('proxycommand'),
    userKnownHostsFiles: fields.get('userknownhostsfile') ?? [],
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
