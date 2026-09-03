/**
 * Local kap-server detection — a dev/preview middleware answering
 * `GET /__kiki/local-server` with the newest verified kap-server on this
 * machine. Registered PIDs are only candidates: an authenticated `/meta`
 * response must identify a Kiki server before credentials are returned.
 *
 * kap-server self-registers under
 * `<kiki home>/server/instances/<serverId>.json` and keeps the token at
 * `<kiki home>/server.token`. The token is included only when Vite is bound to
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
  serverId?: string;
  url?: string;
  pid?: number;
  host?: string;
  port?: number;
  started_at?: number;
  startedAt?: number;
  heartbeat_at?: number;
  heartbeatAt?: number;
  workspaces?: string[];
}

export interface LocalServerCandidate {
  readonly pid: number;
  readonly url: string;
  readonly startedAt: number;
  readonly heartbeatAt: number;
  readonly workspaces: readonly string[];
}

export interface LocalServerPayload {
  readonly url?: string;
  readonly token?: string;
  readonly home: string;
}

interface DetectLocalServerOptions {
  readonly home?: string;
  readonly includeToken?: boolean;
  readonly currentWorkspace?: string;
}

function kikiHomeDir(): string {
  return process.env['KIKI_HOME']
    ?? process.env['KIMI_CODE_HOME']
    ?? join(homedir(), '.kiki');
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

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host).replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
}

export function parseServerInstance(raw: string): LocalServerCandidate | undefined {
  let disk: ServerInstanceDisk;
  try {
    disk = JSON.parse(raw) as ServerInstanceDisk;
  } catch {
    return undefined;
  }
  if (typeof disk.pid !== 'number' || disk.pid <= 0) return undefined;

  let port: number;
  if (typeof disk.url === 'string') {
    let url: URL;
    try {
      url = new URL(disk.url);
    } catch {
      return undefined;
    }
    if (url.protocol !== 'http:' || !isLoopbackHost(url.hostname)) return undefined;
    port = Number(url.port);
  } else {
    if (typeof disk.port !== 'number' || !isLoopbackHost(disk.host ?? '')) return undefined;
    port = disk.port;
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;

  const startedAt = disk.started_at ?? disk.startedAt;
  if (typeof startedAt !== 'number') return undefined;
  const heartbeatAt = disk.heartbeat_at ?? disk.heartbeatAt ?? startedAt;
  const workspaces = Array.isArray(disk.workspaces)
    ? disk.workspaces.filter((workspace): workspace is string => typeof workspace === 'string')
    : [];
  return {
    pid: disk.pid,
    url: `http://127.0.0.1:${port}`,
    startedAt,
    heartbeatAt,
    workspaces,
  };
}

function normalizeWorkspace(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function matchesWorkspace(candidate: LocalServerCandidate, currentWorkspace: string): boolean {
  const current = normalizeWorkspace(currentWorkspace);
  return candidate.workspaces.some((workspace) => {
    const root = normalizeWorkspace(workspace);
    return current === root || current.startsWith(`${root}/`);
  });
}

export function rankServerInstances(
  candidates: readonly LocalServerCandidate[],
  currentWorkspace: string,
): LocalServerCandidate[] {
  return [...candidates].sort((left, right) =>
    Number(matchesWorkspace(right, currentWorkspace)) - Number(matchesWorkspace(left, currentWorkspace))
    || right.heartbeatAt - left.heartbeatAt
    || right.startedAt - left.startedAt,
  );
}

async function probeServer(url: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/v1/meta`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(IDENTITY_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as { data?: { server_version?: unknown } };
    return typeof payload.data?.server_version === 'string';
  } catch {
    return false;
  }
}

export async function findLiveInstance(
  home: string,
  token: string | undefined,
  currentWorkspace = process.cwd(),
): Promise<string | undefined> {
  if (token === undefined) return undefined;
  const candidates: LocalServerCandidate[] = [];
  for (const instancesDir of [join(home, 'server', 'instances'), join(home, 'instances')]) {
    let names: string[];
    try {
      names = await readdir(instancesDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const candidate = parseServerInstance(await readFile(join(instancesDir, name), 'utf8'));
        if (candidate !== undefined && pidAlive(candidate.pid)) candidates.push(candidate);
      } catch {
        continue;
      }
    }
  }

  for (const candidate of rankServerInstances(candidates, currentWorkspace)) {
    if (await probeServer(candidate.url, token)) return candidate.url;
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
  const home = options.home ?? kikiHomeDir();
  const token = await readToken(home);
  const instanceUrl = await findLiveInstance(home, token, options.currentWorkspace);
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
