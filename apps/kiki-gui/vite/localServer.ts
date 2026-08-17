/**
 * Local kap-server detection — a dev/preview middleware answering
 * `GET /__kiki/local-server` with the newest verified kap-server on this
 * machine. Registered PIDs are only candidates: `/meta` must echo the
 * registry's per-process server id before credentials are returned.
 *
 * kap-server self-registers under
 * `<kimi home>/server/instances/<serverId>.json` and keeps the token at
 * `<kimi home>/server.token`. The token is included only when Vite is bound to
 * loopback; non-loopback dev/preview listeners still report the URL but never
 * disclose the bearer credential over HTTP.
 */

import { readdir, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Plugin } from 'vite';

export const LOCAL_SERVER_ENDPOINT = '/__kiki/local-server';
const IDENTITY_PROBE_TIMEOUT_MS = 1_000;

interface ServerInstanceDisk {
  server_id?: string;
  pid?: number;
  host?: string;
  port?: number;
  started_at?: number;
}

interface MetaEnvelope {
  readonly data?: {
    readonly server_id?: string;
  };
}

export interface LocalServerPayload {
  readonly url?: string;
  readonly token?: string;
  readonly home: string;
}

interface DetectLocalServerOptions {
  readonly home?: string;
  readonly includeToken?: boolean;
}

function kimiHomeDir(): string {
  const fromEnv = process.env['KIMI_CODE_HOME'];
  return fromEnv !== undefined && fromEnv.length > 0
    ? fromEnv
    : join(homedir(), '.kimi-code');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function normalizeHost(host: string | undefined): string {
  if (host === undefined || host === '' || host === '0.0.0.0' || host === '::' || host === '[::]') {
    return '127.0.0.1';
  }
  return host;
}

async function probeServerId(url: string, token: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${url}/api/v1/meta`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(IDENTITY_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as MetaEnvelope;
    const serverId = payload.data?.server_id;
    return typeof serverId === 'string' && serverId.length > 0 ? serverId : undefined;
  } catch {
    return undefined;
  }
}

/** Newest registered instance whose pid and server-id nonce both verify. */
export async function findLiveInstance(
  home: string,
  token: string | undefined,
): Promise<string | undefined> {
  if (token === undefined) return undefined;
  const instancesDir = join(home, 'server', 'instances');
  let names: string[];
  try {
    names = await readdir(instancesDir);
  } catch {
    return undefined;
  }

  const candidates: Array<{ serverId: string; startedAt: number; url: string }> = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let disk: ServerInstanceDisk;
    try {
      disk = JSON.parse(await readFile(join(instancesDir, name), 'utf8')) as ServerInstanceDisk;
    } catch {
      continue;
    }
    if (
      typeof disk.server_id !== 'string' ||
      disk.server_id.length === 0 ||
      typeof disk.pid !== 'number' ||
      typeof disk.port !== 'number' ||
      disk.port <= 0 ||
      !pidAlive(disk.pid)
    ) {
      continue;
    }
    candidates.push({
      serverId: disk.server_id,
      startedAt: typeof disk.started_at === 'number' ? disk.started_at : 0,
      url: `http://${normalizeHost(disk.host)}:${disk.port}`,
    });
  }

  candidates.sort((left, right) => right.startedAt - left.startedAt);
  for (const candidate of candidates) {
    if ((await probeServerId(candidate.url, token)) === candidate.serverId) {
      return candidate.url;
    }
  }
  return undefined;
}

async function readToken(home: string): Promise<string | undefined> {
  try {
    const token = (await readFile(join(home, 'server.token'), 'utf8')).trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

export function isLoopbackBindHost(host: string | boolean | undefined): boolean {
  if (host === undefined || host === false) return true;
  if (host === true) return false;
  const normalized = host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }
  return isIP(normalized) === 4 && normalized.startsWith('127.');
}

export async function detectLocalServer(
  proxyTarget: string,
  options: DetectLocalServerOptions = {},
): Promise<LocalServerPayload> {
  const home = options.home ?? kimiHomeDir();
  const token = await readToken(home);
  const instanceUrl = await findLiveInstance(home, token);
  // Fall back to the dev-proxy target: it is a kap-server URL by construction.
  return {
    url: instanceUrl ?? proxyTarget,
    token: options.includeToken === false ? undefined : token,
    home,
  };
}

function createHandler(proxyTarget: string, includeToken: boolean) {
  return (
    _req: unknown,
    res: { setHeader(name: string, value: string): void; end(data: string): void },
  ): void => {
    void detectLocalServer(proxyTarget, { includeToken })
      .then((payload) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      })
      .catch((error: unknown) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: String(error) }));
      });
  };
}

export function localServerPlugin(options: { proxyTarget: string }): Plugin {
  return {
    name: 'kiki-local-server',
    configureServer(server) {
      server.middlewares.use(
        LOCAL_SERVER_ENDPOINT,
        createHandler(options.proxyTarget, isLoopbackBindHost(server.config.server.host)),
      );
    },
    configurePreviewServer(server) {
      server.middlewares.use(
        LOCAL_SERVER_ENDPOINT,
        createHandler(options.proxyTarget, isLoopbackBindHost(server.config.preview.host)),
      );
    },
  };
}
