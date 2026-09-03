import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DaemonConnection {
  readonly url: string;
  readonly token: string;
}

export interface DaemonInstance {
  readonly serverId: string;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly startedAt: number;
  readonly heartbeatAt: number;
  readonly workspaces: readonly string[];
}

export interface EnsureDaemonOptions {
  readonly homeDir?: string;
  readonly workspacePath?: string;
  readonly commandPath: string;
  readonly fetch?: typeof fetch;
  readonly spawn?: typeof spawn;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const INSTANCE_DIRS = [['server', 'instances'], ['instances']] as const;

export function resolveDaemonHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['KIKI_HOME'];
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.kiki');
}

export function parseDaemonInstance(raw: string): DaemonInstance | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const serverId = stringField(parsed, 'server_id', 'serverId');
    const pid = numberField(parsed, 'pid');
    const startedAt = numberField(parsed, 'started_at', 'startedAt');
    const heartbeatAt = numberField(parsed, 'heartbeat_at', 'heartbeatAt') ?? startedAt;
    const workspaces = parsed['workspaces'];
    if (
      serverId === undefined ||
      pid === undefined ||
      pid <= 0 ||
      startedAt === undefined ||
      heartbeatAt === undefined ||
      (workspaces !== undefined &&
        (!Array.isArray(workspaces) || !workspaces.every((value) => typeof value === 'string')))
    ) {
      return null;
    }

    const address = addressFromRecord(parsed);
    if (address === null) return null;
    return {
      serverId,
      pid,
      host: address.host,
      port: address.port,
      startedAt,
      heartbeatAt: Math.max(heartbeatAt, startedAt),
      workspaces: (workspaces as string[] | undefined) ?? [],
    };
  } catch {
    return null;
  }
}

export function rankDaemonInstances(
  instances: readonly DaemonInstance[],
  workspacePath?: string,
): readonly DaemonInstance[] {
  return instances.toSorted((left, right) => {
    const leftMatches = workspaceMatches(left, workspacePath) ? 1 : 0;
    const rightMatches = workspaceMatches(right, workspacePath) ? 1 : 0;
    return (
      rightMatches - leftMatches ||
      right.heartbeatAt - left.heartbeatAt ||
      right.startedAt - left.startedAt
    );
  });
}

export async function discoverDaemon(
  homeDir: string,
  workspacePath?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DaemonConnection | null> {
  const token = await readToken(homeDir);
  if (token === null) return null;

  const instances = await readDaemonInstances(homeDir);
  for (const instance of rankDaemonInstances(instances, workspacePath)) {
    const url = formatDaemonUrl(instance.host, instance.port);
    try {
      const response = await fetchImpl(`${url}/api/v1/meta`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return { url, token };
    } catch {
    }
  }
  return null;
}

export async function ensureDaemon(options: EnsureDaemonOptions): Promise<DaemonConnection> {
  const homeDir = options.homeDir ?? resolveDaemonHome();
  const existing = await discoverDaemon(homeDir, options.workspacePath, options.fetch);
  if (existing !== null) return existing;

  const child = (options.spawn ?? spawn)(
    options.commandPath,
    ['web', '--no-open', '--port', '0', '--log-level', 'warn'],
    {
      detached: true,
      env: { ...process.env, KIKI_HOME: homeDir },
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  const spawnError = childSpawnError(child);
  child.unref();

  const sleep =
    options.sleep ??
    ((milliseconds) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const error = spawnError();
    if (error !== undefined) throw error;
    const connection = await discoverDaemon(homeDir, options.workspacePath, options.fetch);
    if (connection !== null) return connection;
    if (child.exitCode !== null) {
      throw new Error(`kimi web exited before the daemon became ready (${child.exitCode}).`);
    }
  }
  throw new Error(`Timed out waiting for kimi web after ${timeoutMs}ms.`);
}

async function readDaemonInstances(homeDir: string): Promise<DaemonInstance[]> {
  const instances: DaemonInstance[] = [];
  for (const segments of INSTANCE_DIRS) {
    const directory = join(homeDir, ...segments);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const records = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          try {
            return parseDaemonInstance(await readFile(join(directory, name), 'utf8'));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            return null;
          }
        }),
    );
    instances.push(...records.filter((record): record is DaemonInstance => record !== null));
  }
  return instances;
}

function addressFromRecord(record: Record<string, unknown>): { host: string; port: number } | null {
  const rawUrl = record['url'];
  if (typeof rawUrl === 'string') {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' || url.port === '') return null;
    const host = normalizeRegistryHost(url.hostname);
    const port = Number(url.port);
    return host === null || !Number.isInteger(port) || port <= 0 || port > 65_535
      ? null
      : { host, port };
  }

  const rawHost = record['host'];
  const port = numberField(record, 'port');
  if (typeof rawHost !== 'string' || port === undefined || port <= 0 || port > 65_535) return null;
  const host = normalizeRegistryHost(rawHost);
  return host === null ? null : { host, port };
}

function normalizeRegistryHost(host: string): string | null {
  const normalized = host.toLowerCase().replace(/^\[(.*)\]$/u, '$1');
  if (normalized === '0.0.0.0') return '127.0.0.1';
  if (normalized === '::') return '::1';
  if (normalized === 'localhost' || normalized === '::1') return normalized;
  const octets = normalized.split('.');
  if (
    octets.length === 4 &&
    octets.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255) &&
    octets[0] === '127'
  ) {
    return normalized;
  }
  return null;
}

function workspaceMatches(instance: DaemonInstance, workspacePath: string | undefined): boolean {
  if (workspacePath === undefined) return false;
  const current = normalizeWorkspace(workspacePath);
  return instance.workspaces.some((workspace) => {
    const root = normalizeWorkspace(workspace);
    return current === root || current.startsWith(`${root}/`);
  });
}

function normalizeWorkspace(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/u, '');
  return /^(?:[A-Za-z]:\/|\/\/)/u.test(normalized) ? normalized.toLowerCase() : normalized;
}

function stringField(record: Record<string, unknown>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function numberField(record: Record<string, unknown>, ...keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function childSpawnError(child: ChildProcess): () => Error | undefined {
  let error: Error | undefined;
  child.once('error', (value) => {
    error = value;
  });
  return () => error;
}

async function readToken(homeDir: string): Promise<string | null> {
  try {
    const token = (await readFile(join(homeDir, 'server.token'), 'utf8')).trim();
    if (token.length > 4_096) throw new Error('Kiki server token is unexpectedly large.');
    return token === '' ? null : token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function formatDaemonUrl(host: string, port: number): string {
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${authority}:${port}`;
}
