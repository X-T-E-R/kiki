import { spawn } from 'node:child_process';
import { open, mkdir, realpath, stat, unlink } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import { isSea } from 'node:sea';
import { setTimeout as sleep } from 'node:timers/promises';

import { resolveGlobalLogPath, sameWorkDir } from '@kiki/node-sdk';
import {
  listLiveServerInstances,
  readLocalOwnerToken,
  startServer,
  type RunningServer,
  type ServerInstanceInfo,
  type ServerLogLevel,
} from '@kiki/kap-server';
import type { Command } from 'commander';
import { connectionIdentitySchema, type ConnectionIdentity } from '@kiki/protocol';
import { readBoundedJsonBody } from '@kiki/klient/transports/http/bounded-body';

import { parseLogLevel } from '../cli/log-level';
import { createKimiCodeHostIdentity, getVersion } from '../cli/version';
import { requireServerWebAssetsDir } from '../native/web-assets';
import { getBrowserDriverFile } from '../native/native-assets';
import { resolveKikiHome } from './home';

export interface ServerConnection {
  readonly url: string;
  readonly token: string;
  readonly serverId: string;
  readonly identity?: ConnectionIdentity;
  readonly serverVersion?: string;
  readonly dangerousBypassAuth?: boolean;
  readonly buildChannel?: string;
}

interface ServeOptions {
  readonly home?: string;
  readonly port?: number;
  readonly idleExit: string;
  readonly ensure?: boolean;
  readonly query?: boolean;
  readonly workspace?: string;
  readonly json?: boolean;
  readonly stop?: boolean;
  readonly debugEndpoints?: boolean;
  readonly logLevel?: ServerLogLevel;
}

const ENSURE_TIMEOUT_MS = 60_000;
const ENSURE_LOCK_STALE_MS = 65_000;

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Run the local daemon in the foreground, or ensure, query, or stop it.')
    .option('--home <dir>', 'Kiki home directory to operate on.')
    .option('--port <port>', 'Port to bind when starting the daemon.', parsePort)
    .option('--idle-exit <duration>', 'Idle timeout; 0ms keeps a newly started daemon running until explicit stop.', '30m')
    .option('--ensure', 'Start the daemon if none is reachable, then print the connection.')
    .option('--query', 'Query this home without starting a server; JSON contains a private local-owner capability.')
    .option('--workspace <dir>', 'Prefer the server instance serving this workspace.')
    .option('--json', 'Print the connection as JSON.')
    .option('--stop', 'Stop the daemon for this home.')
    .option('--debug-endpoints', 'Mount local-owner debug routes on a new foreground daemon only.')
    .option('--log-level <level>', 'Log level for a new foreground daemon.', parseLogLevel)
    .action(async (options: ServeOptions) => {
      const homeDir = resolveKikiHome(options.home);
      const idleExitMs = parseDuration(options.idleExit);
      if ([options.ensure, options.stop, options.query].filter(Boolean).length > 1) {
        throw new Error('--ensure, --stop and --query cannot be used together.');
      }
      if (options.debugEndpoints === true && (options.ensure || options.stop || options.query)) throw new Error('--debug-endpoints applies only to a new foreground daemon.');
      if (options.logLevel !== undefined && (options.ensure || options.stop || options.query)) throw new Error('--log-level applies only to a new foreground daemon.');
      if (options.query === true) {
        const connection = await findReachableServer(homeDir, options.workspace);
        process.stdout.write(options.json === true
          ? `${JSON.stringify(connection === undefined ? { running: false } : { ...connection, running: true })}\n`
          : connection === undefined ? 'No reachable Kiki server was found.\n' : `Kiki server: ${connection.url}\n`);
        return;
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
      await runServeForeground({ homeDir, port: options.port, idleExitMs, json: options.json, debugEndpoints: options.debugEndpoints, logLevel: options.logLevel });
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
    throw new Error([
      'Kiki server did not become ready before the startup deadline.',
      `See log: ${resolveGlobalLogPath(homeDir)}`,
      `Check daemon status: kiki doctor --home "${homeDir}"`,
      `Validate configuration: kiki doctor agents --home "${homeDir}"`,
    ].join('\n'));
  });
}

export async function findReachableServer(
  homeDir: string,
  workspace?: string,
): Promise<ServerConnection | undefined> {
  const token = await readLocalOwnerToken(homeDir);
  if (token === undefined) return undefined;
  const instances = [...await listLiveServerInstances(homeDir)];
  if (workspace !== undefined) {
    instances.sort((a, b) => {
      const aMatch = a.workspaces.some((item) => sameWorkDir(item, workspace));
      const bMatch = b.workspaces.some((item) => sameWorkDir(item, workspace));
      return Number(bMatch) - Number(aMatch) || a.startedAt - b.startedAt;
    });
  }
  for (const instance of instances) {
    const connection = await probeInstance(instance, token);
    if (connection !== undefined) return connection;
  }
  return undefined;
}

class ServerProtocolMismatchError extends Error {
  constructor() { super('A running Kiki server was found but its identity handshake could not be verified; retry or stop and upgrade it before starting another server.'); }
}

async function probeInstance(
  instance: ServerInstanceInfo,
  token: string,
): Promise<ServerConnection | undefined> {
  const url = instanceUrl(instance);
  let identified = false;
  try {
    const response = await fetch(`${url}/api/meta`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    });
    if (!response.ok) return undefined;
    const envelope = await readBoundedJsonBody(response, 65536) as {
      readonly code?: number;
      readonly data?: { readonly server_id?: string; readonly server_home_id?: string; readonly server_version?: string; readonly dangerous_bypass_auth?: boolean; readonly build_channel?: string };
    };
    if (envelope.code !== 0 || envelope.data?.server_id !== instance.serverId) return undefined;
    identified = true;
    const handshake = await fetch(`${url}/api/remote-connections/handshake`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000), redirect: 'error',
    });
    if (!handshake.ok) throw new ServerProtocolMismatchError();
    const hello = await readBoundedJsonBody(handshake, 8192) as { code: number; data?: { identity: unknown; serverId: string } };
    if (hello.code !== 0 || hello.data?.serverId !== instance.serverId) throw new ServerProtocolMismatchError();
    const parsedIdentity = connectionIdentitySchema.safeParse(hello.data.identity);
    if (!parsedIdentity.success || parsedIdentity.data.homeId !== envelope.data.server_home_id) throw new ServerProtocolMismatchError();
    const identity = parsedIdentity.data;
    return { url, token, serverId: instance.serverId, identity, serverVersion: envelope.data.server_version,
      dangerousBypassAuth: envelope.data.dangerous_bypass_auth, buildChannel: envelope.data.build_channel };
  } catch (error) {
    if (error instanceof ServerProtocolMismatchError) throw error;
    if (identified) throw new ServerProtocolMismatchError();
    return undefined;
  }
}

interface ServeStartOptions {
  readonly homeDir: string;
  readonly port?: number;
  readonly idleExitMs: number;
  readonly debugEndpoints?: boolean;
  readonly logLevel?: ServerLogLevel;
}

export function startServeServer(
  options: ServeStartOptions,
  webAssetsDir = requireServerWebAssetsDir(),
  startServerImpl: typeof startServer = startServer,
): Promise<RunningServer> {
  const version = getVersion();
  return startServerImpl({
    host: '127.0.0.1',
    port: options.port,
    homeDir: options.homeDir,
    idleExitMs: options.idleExitMs === 0 ? undefined : options.idleExitMs,
    debugEndpoints: options.debugEndpoints,
    logLevel: options.logLevel,
    serverVersion: version,
    hostIdentity: createKimiCodeHostIdentity(version, { homeDir: options.homeDir }),
    webAssetsDir,
    browserDriverPath: getBrowserDriverFile() ?? undefined,
  });
}

async function runServeForeground(
  options: ServeStartOptions & { readonly json?: boolean },
): Promise<void> {
  const running = await startServeServer(options);
  const token = await readLocalOwnerToken(options.homeDir);
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
  const response = await fetch(`${connection.url}/api/shutdown`, {
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
  const entryArgs = isSea() ? [] : [...process.execArgv, process.argv[1]!];
  const args = [
    ...entryArgs,
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

function writeConnection(connection: ServerConnection, json: boolean): void {
  process.stdout.write(json
    ? `${JSON.stringify(connection)}\n`
    : `Kiki server: ${connection.url}\n`);
}
