import { spawn } from 'node:child_process';
import { open, mkdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { platform } from 'node:os';
import { join, normalize, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  listLiveServerInstances,
  readServerToken,
  startServer,
  type ServerInstanceInfo,
} from '@moonshot-ai/kap-server';
import type { Command } from 'commander';

import { getDataDir } from '../utils/paths';
import { createKimiCodeHostIdentity, getVersion } from '../cli/version';

export interface ServerConnection {
  readonly url: string;
  readonly token: string;
  readonly serverId: string;
}

interface ServeOptions {
  readonly home?: string;
  readonly port?: number;
  readonly idleExit: string;
  readonly ensure?: boolean;
  readonly workspace?: string;
  readonly json?: boolean;
  readonly stop?: boolean;
}

const ENSURE_TIMEOUT_MS = 60_000;
const ENSURE_LOCK_STALE_MS = 65_000;

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .option('--home <dir>')
    .option('--port <port>', '', parsePort)
    .option('--idle-exit <duration>', '', '30m')
    .option('--ensure')
    .option('--workspace <dir>')
    .option('--json')
    .option('--stop')
    .action(async (options: ServeOptions) => {
      const homeDir = resolve(options.home ?? getDataDir());
      const idleExitMs = parseDuration(options.idleExit);
      if (options.ensure === true && options.stop === true) {
        throw new Error('--ensure and --stop cannot be used together.');
      }
      if (options.stop === true) {
        await stopServer(homeDir);
        return;
      }
      if (options.ensure === true) {
        const connection = await ensureServer({
          homeDir,
          port: options.port,
          idleExit: options.idleExit,
          workspace: options.workspace,
        });
        writeConnection(connection, options.json === true);
        return;
      }
      await runServeForeground({ homeDir, port: options.port, idleExitMs, json: options.json });
    });
}

export async function ensureServer(options: {
  readonly homeDir: string;
  readonly port?: number;
  readonly idleExit?: string;
  readonly workspace?: string;
}): Promise<ServerConnection> {
  const homeDir = resolve(options.homeDir);
  const workspace = options.workspace === undefined
    ? undefined
    : normalize(await realpath(resolve(options.workspace)));
  const existing = await findReachableServer(homeDir, workspace);
  if (existing !== undefined) return existing;

  return withEnsureLock(homeDir, async () => {
    const raced = await findReachableServer(homeDir, workspace);
    if (raced !== undefined) return raced;
    spawnDetachedServer({
      homeDir,
      port: options.port,
      idleExit: options.idleExit ?? '30m',
    });
    const deadline = Date.now() + ENSURE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(250);
      const ready = await findReachableServer(homeDir, workspace);
      if (ready !== undefined) return ready;
    }
    throw new Error('Kiki server did not become ready before the startup deadline.');
  });
}

export async function findReachableServer(
  homeDir: string,
  workspace?: string,
): Promise<ServerConnection | undefined> {
  const token = await readServerToken(homeDir);
  if (token === undefined) return undefined;
  const instances = [...await listLiveServerInstances(homeDir)];
  if (workspace !== undefined) {
    const target = pathKey(workspace);
    instances.sort((a, b) => {
      const aMatch = a.workspaces.some((item) => pathKey(item) === target);
      const bMatch = b.workspaces.some((item) => pathKey(item) === target);
      return Number(bMatch) - Number(aMatch) || a.startedAt - b.startedAt;
    });
  }
  for (const instance of instances) {
    const connection = await probeInstance(instance, token);
    if (connection !== undefined) return connection;
  }
  return undefined;
}

async function probeInstance(
  instance: ServerInstanceInfo,
  token: string,
): Promise<ServerConnection | undefined> {
  const url = instanceUrl(instance);
  try {
    const response = await fetch(`${url}/api/v1/meta`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    const envelope = await response.json() as {
      readonly code?: number;
      readonly data?: { readonly server_id?: string };
    };
    if (envelope.code !== 0 || envelope.data?.server_id !== instance.serverId) return undefined;
    return { url, token, serverId: instance.serverId };
  } catch {
    return undefined;
  }
}

async function runServeForeground(options: {
  readonly homeDir: string;
  readonly port?: number;
  readonly idleExitMs: number;
  readonly json?: boolean;
}): Promise<void> {
  const version = getVersion();
  const running = await startServer({
    host: '127.0.0.1',
    port: options.port,
    homeDir: options.homeDir,
    idleExitMs: options.idleExitMs,
    serverVersion: version,
    hostIdentity: createKimiCodeHostIdentity(version),
  });
  const token = await readServerToken(options.homeDir);
  const connection = {
    url: `http://127.0.0.1:${running.port}`,
    token: token!,
    serverId: running.serverId,
  };
  writeConnection(connection, options.json === true);
  const shutdown = (): void => {
    void running.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await running.closed;
  } finally {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  }
}

async function stopServer(homeDir: string): Promise<void> {
  const connection = await findReachableServer(homeDir);
  if (connection === undefined) throw new Error('No reachable Kiki server was found.');
  const response = await fetch(`${connection.url}/api/v1/shutdown`, {
    method: 'POST',
    headers: { authorization: `Bearer ${connection.token}` },
  });
  if (!response.ok) throw new Error(`Kiki server shutdown failed with HTTP ${response.status}.`);
}

function spawnDetachedServer(options: {
  readonly homeDir: string;
  readonly port?: number;
  readonly idleExit: string;
}): void {
  const args = [
    process.argv[1]!,
    'serve',
    '--home',
    options.homeDir,
    '--idle-exit',
    options.idleExit,
    '--json',
  ];
  if (options.port !== undefined) args.push('--port', String(options.port));
  const env = { ...process.env };
  for (const name of [
    'KIKI_EXTERNAL_PRINCIPAL_ID',
    'KIKI_EXTERNAL_SESSION_ID',
    'KIKI_EXTERNAL_DELEGATION_TOKEN',
    'KIKI_EXTERNAL_WORKSPACE_PATH',
    'KIKI_EXTERNAL_MODEL_ALIAS',
    'KIKI_EXTERNAL_THINKING_EFFORT',
    'KIKI_EXTERNAL_PERMISSION_MODE',
    'KIKI_EXTERNAL_PERMISSION_CEILING',
    'KIKI_EXTERNAL_SESSION_TITLE',
  ]) delete env[name];
  const child = spawn(process.execPath, args, {
    detached: true,
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

async function withEnsureLock<T>(homeDir: string, work: () => Promise<T>): Promise<T> {
  const serverDir = join(homeDir, 'server');
  const lockPath = join(serverDir, 'ensure.lock');
  await mkdir(serverDir, { recursive: true });
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      try {
        return await work();
      } finally {
        await unlink(lockPath).catch(() => {});
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let info;
      try {
        info = await stat(lockPath);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() - info.mtimeMs >= ENSURE_LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => {});
      } else {
        await sleep(100);
      }
    }
  }
}

function instanceUrl(instance: ServerInstanceInfo): string {
  const host = instance.host.includes(':') ? `[${instance.host}]` : instance.host;
  return `http://${host}:${instance.port}`;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Invalid port.');
  return port;
}

export function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (match === null) throw new Error('Invalid duration.');
  const amount = Number(match[1]);
  const scale = match[2] === 'ms' ? 1 : match[2] === 's' ? 1_000 : match[2] === 'm' ? 60_000 : 3_600_000;
  return amount * scale;
}

function pathKey(value: string): string {
  const normalized = normalize(value);
  return platform() === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function writeConnection(connection: ServerConnection, json: boolean): void {
  process.stdout.write(json
    ? `${JSON.stringify(connection)}\n`
    : `Kiki server: ${connection.url}\n`);
}
