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
  readonly host: string;
  readonly port: number;
  readonly startedAt: number;
  readonly heartbeatAt: number;
  readonly workspaces?: readonly string[];
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

export function resolveDaemonHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['KIMI_CODE_HOME'] ?? join(homedir(), '.kiki');
}

export function parseDaemonInstance(raw: string): DaemonInstance | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const serverId = parsed['server_id'];
    const host = parsed['host'];
    const port = parsed['port'];
    const startedAt = parsed['started_at'];
    const heartbeatAt = parsed['heartbeat_at'];
    const workspaces = parsed['workspaces'];
    if (
      typeof serverId !== 'string' ||
      typeof host !== 'string' ||
      typeof port !== 'number' ||
      typeof startedAt !== 'number' ||
      typeof heartbeatAt !== 'number'
    ) {
      return null;
    }
    if (
      workspaces !== undefined &&
      (!Array.isArray(workspaces) || !workspaces.every((value) => typeof value === 'string'))
    ) {
      return null;
    }
    return {
      serverId,
      host,
      port,
      startedAt,
      heartbeatAt,
      workspaces: workspaces as string[] | undefined,
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
    const leftMatches = workspacePath !== undefined && left.workspaces?.includes(workspacePath) ? 1 : 0;
    const rightMatches = workspacePath !== undefined && right.workspaces?.includes(workspacePath) ? 1 : 0;
    return rightMatches - leftMatches || right.heartbeatAt - left.heartbeatAt || right.startedAt - left.startedAt;
  });
}

export async function discoverDaemon(
  homeDir: string,
  workspacePath?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DaemonConnection | null> {
  const token = await readToken(homeDir);
  if (token === null) return null;

  let names: string[];
  try {
    names = await readdir(join(homeDir, 'server', 'instances'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  const instances = (
    await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          try {
            return parseDaemonInstance(
              await readFile(join(homeDir, 'server', 'instances', name), 'utf8'),
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
          }
        }),
    )
  ).filter((instance): instance is DaemonInstance => instance !== null);

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
      env: { ...process.env, KIMI_CODE_HOME: homeDir },
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
